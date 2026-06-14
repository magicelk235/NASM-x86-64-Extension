import * as fs from 'fs';

export type Arm64OperandClass =
    | 'INT_REG' | 'FP_REG' | 'SIMD_REG' | 'SISD_REG' | 'SIMD_ELEMENT' | 'SIMD_REGLIST'
    | 'PRED_REG' | 'SVE_REG' | 'SVE_REGLIST'
    | 'IMMEDIATE' | 'ADDRESS' | 'COND' | 'MODIFIED_REG' | 'SYSTEM' | 'ZA_ACCESS';

export interface Arm64OperandSpec {
    kind: string;
    cls: Arm64OperandClass;
    qualifiers: string[];
}

export interface Arm64Form {
    operands: Arm64OperandSpec[];
    isAlias: boolean;
    hasAlias: boolean;
    description: string;
    featureSet: string;
}

export interface Arm64Database {
    [mnemonic: string]: Arm64Form[];
}

export interface Arm64Bundle {
    db: Arm64Database;
    summaries: { [mnemonic: string]: string };
}

export function parseArm64Instructions(jsonPath: string): Arm64Bundle {
    const db: Arm64Database = {};
    const summaries: { [m: string]: string } = {};
    if (!fs.existsSync(jsonPath)) return { db, summaries };

    try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (!Array.isArray(raw)) return { db, summaries };
        for (const ins of raw) {
            const mn = (ins.mnemonic || '').toLowerCase();
            if (!mn) continue;
            const flags = String(ins.flags || '').split('|');
            const form: Arm64Form = {
                operands: (ins.operands || []).map((o: any) => ({
                    kind: String(o.kind || ''),
                    cls: String(o.class || 'IMMEDIATE') as Arm64OperandClass,
                    qualifiers: Array.isArray(o.qualifiers) ? o.qualifiers.map(String) : [],
                })),
                isAlias: flags.includes('IS_ALIAS'),
                hasAlias: flags.includes('HAS_ALIAS'),
                description: String(ins.description || ''),
                featureSet: String(ins.feature_set || ''),
            };
            if (!db[mn]) db[mn] = [];
            db[mn].push(form);
            if (!summaries[mn]) summaries[mn] = form.description;
        }
    } catch (e) {
        console.error('Failed to parse ARM64 instructions JSON:', e);
    }
    return { db, summaries };
}

// ARM64 register pattern matchers

const ARM64_GPR_REGEX    = /^(?:[wx](?:[0-9]|[12][0-9]|30)|wsp|wzr|xzr|sp)$/i;
const ARM64_FP_REGEX     = /^[bhsdq](?:[0-9]|[12][0-9]|3[01])$/i;
const ARM64_VEC_REGEX    = /^v(?:[0-9]|[12][0-9]|3[01])(?:\.(?:\d+)?[bhsdq])?$/i;
// Element-indexed vector operand: `v0.s[1]`, `v3.4h[2]`.
const ARM64_VEC_ELEM_REGEX = /^v(?:[0-9]|[12][0-9]|3[01])\.(?:\d+)?[bhsdq]\[\d+\]$/i;
const ARM64_VLIST_REGEX  = /^\{[^}]+\}$/;
const ARM64_PRED_REGEX   = /^p(?:[0-9]|1[0-5])(?:\/[mz])?$/i;
const ARM64_SVE_REGEX    = /^z(?:[0-9]|[12][0-9]|3[01])(?:\.[bhsdq])?$/i;
const ARM64_COND_REGEX   = /^(?:eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al|nv)$/i;

export const ARM64_REGISTERS = new Set<string>();
for (let i = 0; i <= 30; i++) {
    ARM64_REGISTERS.add(`w${i}`);
    ARM64_REGISTERS.add(`x${i}`);
}
ARM64_REGISTERS.add('wsp');
ARM64_REGISTERS.add('wzr');
ARM64_REGISTERS.add('xzr');
ARM64_REGISTERS.add('sp');
for (let i = 0; i <= 31; i++) {
    ARM64_REGISTERS.add(`b${i}`);
    ARM64_REGISTERS.add(`h${i}`);
    ARM64_REGISTERS.add(`s${i}`);
    ARM64_REGISTERS.add(`d${i}`);
    ARM64_REGISTERS.add(`q${i}`);
    ARM64_REGISTERS.add(`v${i}`);
    ARM64_REGISTERS.add(`z${i}`);
}
for (let i = 0; i <= 15; i++) ARM64_REGISTERS.add(`p${i}`);

export function classifyArm64Operand(op: string): Arm64OperandClass | 'UNKNOWN' {
    const t = op.trim();
    if (!t) return 'UNKNOWN';
    if (t.startsWith('[')) return 'ADDRESS';
    if (t.startsWith('#')) return 'IMMEDIATE';
    if (ARM64_VLIST_REGEX.test(t)) return 'SIMD_REGLIST';
    const low = t.toLowerCase();
    if (ARM64_COND_REGEX.test(low)) return 'COND';
    if (ARM64_GPR_REGEX.test(low))  return 'INT_REG';
    if (ARM64_FP_REGEX.test(low))   return 'FP_REG';
    if (ARM64_VEC_ELEM_REGEX.test(low)) return 'SIMD_ELEMENT';
    if (ARM64_VEC_REGEX.test(low))  return 'SIMD_REG';
    if (ARM64_PRED_REGEX.test(low)) return 'PRED_REG';
    if (ARM64_SVE_REGEX.test(low))  return 'SVE_REG';
    if (/^[+-]?(?:0x[0-9a-f]+|[0-9]+)$/i.test(low)) return 'IMMEDIATE';
    return 'UNKNOWN';
}

function arm64OperandMatches(actual: Arm64OperandClass | 'UNKNOWN', expected: Arm64OperandClass): boolean {
    if (actual === 'UNKNOWN') return true; // labels/symbols
    if (actual === expected) return true;
    if (expected === 'SISD_REG' && (actual === 'FP_REG' || actual === 'SIMD_REG')) return true;
    if (expected === 'FP_REG' && actual === 'SISD_REG') return true;
    if (expected === 'MODIFIED_REG' && actual === 'INT_REG') return true;
    if (expected === 'SIMD_ELEMENT' && actual === 'SIMD_REG') return true;
    if (expected === 'SIMD_REG' && actual === 'SIMD_ELEMENT') return true;
    return false;
}

export interface Arm64MatchResult {
    countMatch: boolean;
    typeError: string | null;
    aliasOnly: boolean;
}

export function matchArm64Form(actualOps: string[], forms: Arm64Form[]): Arm64MatchResult {
    const sameCount = forms.filter(f => f.operands.length === actualOps.length);
    if (sameCount.length === 0) return { countMatch: false, typeError: null, aliasOnly: false };

    const actualClasses = actualOps.map(classifyArm64Operand);
    let firstError: string | null = null;
    for (const form of sameCount) {
        let bad = -1;
        for (let i = 0; i < form.operands.length; i++) {
            if (!arm64OperandMatches(actualClasses[i], form.operands[i].cls)) { bad = i; break; }
        }
        if (bad === -1) {
            const aliasOnly = sameCount.every(f => f.isAlias);
            return { countMatch: true, typeError: null, aliasOnly };
        }
        if (firstError === null) {
            firstError = `operand ${bad + 1}: expected ${form.operands[bad].cls}, got ${actualClasses[bad]}`;
        }
    }
    return { countMatch: true, typeError: firstError, aliasOnly: false };
}
