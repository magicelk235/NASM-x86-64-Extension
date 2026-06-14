import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';

// ---------- insns.dat (operand-form database) ----------

export interface InstructionForm {
    operands: string[];
    flags: string[];
}

export interface InstructionDatabase {
    [name: string]: InstructionForm[];
}

export function parseInsnsDat(datPath: string): InstructionDatabase {
    const db: InstructionDatabase = {};
    if (!fs.existsSync(datPath)) return db;

    const content = fs.readFileSync(datPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const sizeMap: Record<string, string> = { b: 'B', w: 'W', d: 'D', q: 'Q' };

    for (const line of lines) {
        if (line.startsWith(';') || !line.trim()) continue;

        const parts = line.split(/\t+/).filter(p => p.trim());
        if (parts.length < 4) continue;

        const nameField    = parts[0].trim();
        const operandField = parts[1].trim();
        const flagsField   = parts[parts.length - 1].trim();

        if (nameField === 'ignore' || operandField === 'ignore') continue;

        const sizePrefix = nameField.match(/^\$([bwdq]+)\s+/);
        let names: string[] = [];

        if (sizePrefix) {
            const sizes    = sizePrefix[1];
            const baseName = nameField.substring(sizePrefix[0].length).trim();
            if (baseName.includes('%')) {
                for (const s of sizes) names.push(baseName.replace('%', sizeMap[s]).toLowerCase());
            } else {
                names = [baseName.toLowerCase()];
            }
        } else {
            const match = nameField.match(/^([A-Za-z0-9_]+)/);
            if (match) names = [match[1].toLowerCase()];
        }

        if (names.length === 0) continue;

        const operands = operandField === 'void'
            ? []
            : operandField.split(',').map(o => o.trim().replace(/[#*?]|\|.*$/g, '').toLowerCase());
        const flags = flagsField.split(',').map(f => f.trim().toUpperCase());

        for (const name of names) {
            if (!db[name]) db[name] = [];
            db[name].push({ operands, flags });
        }
    }

    return db;
}

// ---------- x86 instruction summaries (XML) ----------

export interface InstructionInfo {
    name: string;
    summary: string;
}

export interface InstructionSet {
    [name: string]: InstructionInfo;
}

export function parseInstructionSet(xmlPath: string): InstructionSet {
    const instructions: InstructionSet = {};
    if (!fs.existsSync(xmlPath)) return instructions;

    try {
        const xmlContent = fs.readFileSync(xmlPath, 'utf8');
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const parsed = parser.parse(xmlContent);
        const instrList = parsed?.InstructionSet?.Instruction;
        if (!instrList) return instructions;

        const instrArray = Array.isArray(instrList) ? instrList : [instrList];
        for (const instr of instrArray) {
            const name = instr['@_name'];
            const summary = instr['@_summary'] || '';
            if (!name) continue;
            instructions[name.toLowerCase()] = { name, summary };
        }
    } catch (e) {
        console.error('Failed to parse instruction set XML:', e);
    }

    return instructions;
}

// ---------- operand classification & matching ----------

export type OperandType =
    | 'gpr' | 'xmm' | 'ymm' | 'zmm' | 'mmx' | 'k' | 'mem' | 'imm' | 'other';

const GPR_REGEX = /^(?:r[0-9]+[bwdq]?|[re]?[abcd]x|[abcd][hl]|[re]?[sd]i|[sd]il|[re]?[bs]p|[bs]pl|[re]?ip|[cdefgs]s|cr[0-9]+|dr[0-9]+)$/i;
const IMM_REGEX = /^[+-]?(?:0x[0-9a-f]+|\$[0-9a-f]+|[0-9][0-9a-f]*h|0b[01]+|[01]+[by]|[0-9]+[dt]?)$/i;

export function getOperandType(op: string): OperandType {
    if (/\[/.test(op)) return 'mem';
    const opLower = op.toLowerCase().replace(/\s+/g, '');
    if (/^[xyz]mm[0-9]+$/.test(opLower)) {
        return opLower.startsWith('x') ? 'xmm' : opLower.startsWith('y') ? 'ymm' : 'zmm';
    }
    if (/^mm[0-7]$/.test(opLower)) return 'mmx';
    if (/^k[0-7]$/.test(opLower))  return 'k';
    if (GPR_REGEX.test(opLower))   return 'gpr';
    if (IMM_REGEX.test(opLower))   return 'imm';
    return 'other';
}

const SIMD_PATTERN_REGEX = /^(xmm|ymm|zmm|mm)/;
function patternExpectsSimd(pattern: string): boolean {
    return SIMD_PATTERN_REGEX.test(pattern);
}

// A strict GPR slot: bare `reg`, `reg8`/`reg16`/`reg32`/`reg64`, or `reg_<name>`.
// Excludes `rm*` (also accepts memory) and SIMD slots (`xmmreg`/`ymmreg`/...),
// so a SIMD register supplied here is a real error.
const GPR_PATTERN_REGEX = /^reg(?:8|16|32|64|_[a-z]+)?$/;
function patternExpectsGpr(pattern: string): boolean {
    return GPR_PATTERN_REGEX.test(pattern);
}

// A memory-only slot: `mem`, `mem8`..`mem512`, `mem_offs`. `rm*` is excluded
// (it also accepts a register), so a non-memory operand here is a real error.
const MEM_PATTERN_REGEX = /^mem(?:\d+|_offs)?$/;
function patternExpectsMem(pattern: string): boolean {
    return MEM_PATTERN_REGEX.test(pattern);
}

export interface MatchResult {
    match: boolean;
    countMatch: boolean;
    typeError: string | null;
    flags: string[];
}

export function matchOperandPattern(actualOps: string[], patterns: InstructionForm[]): MatchResult {
    if (patterns.length === 0) {
        return { match: false, countMatch: false, typeError: null, flags: [] };
    }

    const sameCount = patterns.filter(p => p.operands.length === actualOps.length);
    if (sameCount.length === 0) {
        return { match: false, countMatch: false, typeError: null, flags: [] };
    }

    for (let i = 0; i < actualOps.length; i++) {
        const actualType = getOperandType(actualOps[i]);
        if (actualType === 'gpr' && sameCount.every(f => patternExpectsSimd(f.operands[i]))) {
            return {
                match: false,
                countMatch: true,
                typeError: `operand ${i + 1}: expected SIMD register, got GPR`,
                flags: [],
            };
        }
        const isSimd = actualType === 'xmm' || actualType === 'ymm' || actualType === 'zmm' || actualType === 'mmx';
        if (isSimd && sameCount.every(f => patternExpectsGpr(f.operands[i]))) {
            return {
                match: false,
                countMatch: true,
                typeError: `operand ${i + 1}: expected GPR, got SIMD register`,
                flags: [],
            };
        }
        // A register or immediate where every form requires a memory operand.
        const isRegOrImm = actualType === 'gpr' || isSimd || actualType === 'k' || actualType === 'imm';
        if (isRegOrImm && sameCount.every(f => patternExpectsMem(f.operands[i]))) {
            return {
                match: false,
                countMatch: true,
                typeError: `operand ${i + 1}: expected memory operand, got ${actualType === 'imm' ? 'immediate' : 'register'}`,
                flags: [],
            };
        }
    }

    // Collect flags present in every matching form
    const flagCounts = new Map<string, number>();
    for (const form of sameCount) {
        for (const flag of form.flags) {
            flagCounts.set(flag, (flagCounts.get(flag) || 0) + 1);
        }
    }
    const commonFlags: string[] = [];
    for (const [flag, count] of flagCounts) {
        if (count === sameCount.length) commonFlags.push(flag);
    }

    return { match: true, countMatch: true, typeError: null, flags: commonFlags };
}
