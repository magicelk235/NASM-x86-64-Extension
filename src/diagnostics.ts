import * as vscode from 'vscode';
import {
    STRING_REGEX, DIRECTIVES, PREFIXES, DATA_DECL, X86_REGISTERS,
} from './constants';
import {
    Arm64DiagKey, NasmWarnKey, X86DiagKey, X86WarnKey,
    readSettings, severityFor,
} from './config';
import { InstructionDatabase, matchOperandPattern } from './x86';
import { Arm64Database, ARM64_REGISTERS, matchArm64Form } from './arm64';
import { SymbolManager } from './symbols';

export function parseOperands(operandStr: string): string[] {
    const operands: string[] = [];
    if (!operandStr) return operands;
    let depth = 0;
    let current = '';
    for (const char of operandStr) {
        if (char === '[' || char === '{' || char === '(') depth++;
        else if (char === ']' || char === '}' || char === ')') depth--;
        if (char === ',' && depth === 0) {
            if (current.trim()) operands.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) operands.push(current.trim());
    return operands;
}

// Identifier reference: leading letter/underscore/'?' or a local '.label'.
// Excludes numbers (digit-leading), %-macros, and $-relative tokens.
const REF_ID_RE = /(?:\.[a-zA-Z_?]|[a-zA-Z_?])[a-zA-Z0-9_$#@~.?]*/g;

// Operand keywords that are not symbols: size specifiers and address modifiers.
const OPERAND_KEYWORDS = new Set<string>([
    'byte', 'word', 'dword', 'qword', 'tword', 'oword', 'yword', 'zword',
    'ptr', 'short', 'near', 'far', 'rel', 'abs', 'strict', 'seg', 'wrt', 'nosplit',
]);

export function hasUnterminatedString(s: string): boolean {
    const stripped = s.replace(STRING_REGEX, '');
    return /(?<!\\)["'`]/.test(stripped);
}

export interface DiagnosticsContext {
    instructionDb: InstructionDatabase;
    arm64Db: Arm64Database;
    symbolManager: SymbolManager;
    diagnosticCollection: vscode.DiagnosticCollection;
}

export function createUpdateDiagnostics(ctx: DiagnosticsContext) {
    const { instructionDb, arm64Db, symbolManager, diagnosticCollection } = ctx;

    return function updateDiagnostics(document: vscode.TextDocument): void {
        if (document.languageId !== 'nasm') return;

        const settings = readSettings();
        if (!settings.diagEnabled) {
            diagnosticCollection.delete(document.uri);
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];

        const emit = (sev: vscode.DiagnosticSeverity | null, code: string, range: vscode.Range, message: string): boolean => {
            if (sev === null) return false;
            const diag = new vscode.Diagnostic(range, message, sev);
            diag.code = code;
            diagnostics.push(diag);
            return true;
        };
        const pushX86 = (key: X86DiagKey, range: vscode.Range, message: string): boolean =>
            emit(severityFor(settings.x86_64[key]), key, range, message);
        const pushX86Warn = (key: X86WarnKey, range: vscode.Range, message: string): boolean =>
            emit(severityFor(settings.x86_64[key]), key, range, message);
        const pushArm = (key: Arm64DiagKey, range: vscode.Range, message: string): boolean =>
            emit(severityFor(settings.arm64[key]), key, range, message);
        const pushWarn = (key: NasmWarnKey, range: vscode.Range, message: string): boolean =>
            emit(severityFor(settings.warnings[key]), key, range, message);

        const lines = document.getText().split(/\r?\n/);
        const symbolNames = new Set(symbolManager.getSymbols().map(s => s.name.toLowerCase()));
        const arch = settings.arch;
        const lineRange = (i: number, start: number, end: number) =>
            new vscode.Range(i, start, i, end);

        const undefSev = severityFor(settings.warnings.undefinedSymbol);

        // Symbols declared external/global/common — referenceable but not defined here.
        const externNames = new Set<string>();
        for (const raw of lines) {
            const m = raw.replace(STRING_REGEX, ' ')
                .match(/^\s*(?:extern|global|common)\s+(.+)$/i);
            if (!m) continue;
            for (const part of m[1].split(',')) {
                const id = part.trim().split(/[\s:]/)[0];   // common may have `name size`
                if (id) externNames.add(id.toLowerCase());
            }
        }

        // Duplicate definition detection: non-local labels and constants only.
        // (Local '.labels' legitimately repeat; macros may overload by arg count.)
        const dupSev = severityFor(settings.warnings.duplicateLabel);
        if (dupSev !== null) {
            const seenDef = new Map<string, vscode.Range>();
            for (const sym of symbolManager.getSymbols(document.uri)) {
                const dupable = sym.kind === vscode.CompletionItemKind.Constant
                             || sym.kind === vscode.CompletionItemKind.Function
                             || sym.kind === vscode.CompletionItemKind.Variable;
                if (!dupable) continue;
                if (sym.name.startsWith('.')) continue;
                const key = sym.name.toLowerCase();
                if (seenDef.has(key)) {
                    const diag = new vscode.Diagnostic(sym.range,
                        `'${sym.name}' is defined more than once`, dupSev);
                    diag.code = 'duplicateLabel';
                    diagnostics.push(diag);
                } else {
                    seenDef.set(key, sym.range);
                }
            }
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const maskedLine = line.replace(STRING_REGEX, m => ' '.repeat(m.length));
            const commentIdx = maskedLine.indexOf(';');
            const codePart = commentIdx === -1 ? maskedLine : maskedLine.substring(0, commentIdx);

            // NASM warning: unterminated string
            if (hasUnterminatedString(line.substring(0, commentIdx === -1 ? line.length : commentIdx))) {
                pushWarn('unterminatedString', lineRange(i, 0, line.length), `unterminated string literal`);
            }

            // NASM warning: deprecated $hex prefix
            {
                const dollarHex = /(?<![\w$.])\$[0-9a-fA-F]+\b/g;
                let m: RegExpExecArray | null;
                while ((m = dollarHex.exec(codePart)) !== null) {
                    pushWarn('deprecatedHexPrefix', lineRange(i, m.index, m.index + m[0].length),
                        `'$' prefix for hex is deprecated; use 0x${m[0].substring(1)}`);
                }
            }

            // NASM warning: %warning directive
            {
                const userMatch = codePart.match(/^\s*%warning\b\s*(.*)$/i);
                if (userMatch) {
                    const start = codePart.indexOf('%warning');
                    const len = 8 + (userMatch[1] ? userMatch[1].length + 1 : 0);
                    pushWarn('userDirective', lineRange(i, start, start + len),
                        `%warning: ${userMatch[1].replace(/^["'`]|["'`]$/g, '').trim() || '(empty)'}`);
                }
            }

            // NASM warning: %rep with negative count
            {
                const repMatch = codePart.match(/^\s*%rep\b\s+(-\d+)\b/i);
                if (repMatch) {
                    const start = codePart.indexOf(repMatch[1]);
                    pushWarn('repNegative', lineRange(i, start, start + repMatch[1].length),
                        `%rep count is negative (${repMatch[1]})`);
                }
            }

            if (!codePart.trim()) continue;

            const labelMatch = codePart.match(/^\s*([a-zA-Z_?.][a-zA-Z0-9_$#@~.?]*):/);
            const codeAfterLabel = labelMatch ? codePart.substring(labelMatch[0].length) : codePart;

            // NASM warning: orphan label (identifier alone, no colon)
            if (!labelMatch) {
                const orphan = codePart.match(/^\s*([a-zA-Z_?][a-zA-Z0-9_$#@~.?]*)\s*$/);
                if (orphan) {
                    const name = orphan[1].toLowerCase();
                    const known = DIRECTIVES.has(name) || PREFIXES.has(name)
                        || instructionDb[name] !== undefined || arm64Db[name] !== undefined
                        || X86_REGISTERS.has(name) || ARM64_REGISTERS.has(name);
                    if (!known) {
                        const start = codePart.indexOf(orphan[1]);
                        pushWarn('labelOrphan', lineRange(i, start, start + orphan[1].length),
                            `label '${orphan[1]}' has no trailing ':'`);
                    }
                }
            }

            if (!codeAfterLabel.trim()) continue;

            const tokens = codeAfterLabel.trim().split(/[\s,]+/).filter(t => t && !/^[,[\]]$/.test(t));
            if (tokens.length === 0) continue;

            let instrIdx = 0;
            if (arch === 'x86-64') {
                while (instrIdx < tokens.length && PREFIXES.has(tokens[instrIdx].toLowerCase())) instrIdx++;
            }
            if (instrIdx >= tokens.length) continue;

            const instr = tokens[instrIdx].toLowerCase();
            const instrStart = codeAfterLabel.toLowerCase().indexOf(instr);
            const lineOffset = codePart.length - codeAfterLabel.length;
            const range = new vscode.Range(i, lineOffset + instrStart, i, lineOffset + instrStart + instr.length);

            // NASM warning: empty data declaration
            if (DATA_DECL.has(instr)) {
                const after = codeAfterLabel.substring(codeAfterLabel.toLowerCase().indexOf(instr) + instr.length).trim();
                if (!after) pushWarn('dbEmpty', range, `${instr}: no operand`);
            }

            if (instr.startsWith('%') || DIRECTIVES.has(instr) || symbolNames.has(instr)) continue;

            // x86-only: LOCK prefix checks
            if (arch === 'x86-64' && instrIdx > 0) {
                const usedPrefixes = tokens.slice(0, instrIdx).map(t => t.toLowerCase());
                if (usedPrefixes.includes('lock')) {
                    if (instr === 'xchg') {
                        pushX86Warn('prefixLockXchg', range, `superfluous LOCK on XCHG (always locking)`);
                    } else {
                        const forms = instructionDb[instr];
                        if (forms && forms.length > 0 && !forms.some(f => f.flags.includes('LOCK'))) {
                            pushX86Warn('prefixLockError', range, `LOCK prefix not valid on ${instr}`);
                        }
                    }
                }
            }

            const operandStr = codeAfterLabel.substring(codeAfterLabel.toLowerCase().indexOf(instr) + instr.length).trim();
            const operands = parseOperands(operandStr);

            // Undefined-symbol detection over the operand region.
            if (undefSev !== null) {
                const opRegionStart = lineOffset + codeAfterLabel.toLowerCase().indexOf(instr) + instr.length;
                const opSource = codePart.substring(opRegionStart);
                const regs = arch === 'arm64' ? ARM64_REGISTERS : X86_REGISTERS;
                let rm: RegExpExecArray | null;
                REF_ID_RE.lastIndex = 0;
                while ((rm = REF_ID_RE.exec(opSource)) !== null) {
                    const ref = rm[0];
                    const refLower = ref.toLowerCase();
                    if (ref.startsWith('%') || ref.startsWith('$')) continue;
                    if (regs.has(refLower) || symbolNames.has(refLower) || externNames.has(refLower)) continue;
                    if (DIRECTIVES.has(refLower) || PREFIXES.has(refLower)) continue;
                    if (OPERAND_KEYWORDS.has(refLower)) continue;
                    if (instructionDb[refLower] || arm64Db[refLower]) continue;
                    const start = opRegionStart + rm.index;
                    pushWarn('undefinedSymbol', lineRange(i, start, start + ref.length),
                        `'${ref}' is not defined`);
                }
            }

            if (arch === 'x86-64') {
                const forms = instructionDb[instr];
                if (!forms || forms.length === 0) continue;

                // x86 forbids 2+ memory operands. Implicit string-op forms (0 operands) won't trip this.
                if (operands.length >= 2 && operands.filter(op => /\[/.test(op)).length >= 2) {
                    if (pushX86('memoryToMemory', range, `${instr}: memory-to-memory operations not allowed`)) continue;
                }

                const result = matchOperandPattern(operands, forms);
                if (!result.countMatch) {
                    const validCounts = [...new Set(forms.map(f => f.operands.length))].sort((a, b) => a - b).join(', ');
                    pushX86('operandCount', range, `${instr}: expected ${validCounts} operand(s), got ${operands.length}`);
                } else if (result.typeError) {
                    pushX86('operandType', range, `${instr}: ${result.typeError}`);
                } else {
                    if (result.flags.includes('OBSOLETE')) pushX86('obsolete', range, `${instr} is obsolete`);
                    if (result.flags.includes('UNDOC'))    pushX86('undocumented', range, `${instr} is undocumented`);
                    if (result.flags.includes('NOLONG'))   pushX86('notInLongMode', range, `${instr} not available in 64-bit mode`);
                }
            } else {
                const forms = arm64Db[instr];
                if (!forms || forms.length === 0) {
                    pushArm('unknownInstruction', range, `${instr}: unknown AArch64 mnemonic`);
                    continue;
                }
                const result = matchArm64Form(operands, forms);
                if (!result.countMatch) {
                    const validCounts = [...new Set(forms.map(f => f.operands.length))].sort((a, b) => a - b).join(', ');
                    pushArm('operandCount', range, `${instr}: expected ${validCounts} operand(s), got ${operands.length}`);
                } else if (result.typeError) {
                    pushArm('operandType', range, `${instr}: ${result.typeError}`);
                } else if (result.aliasOnly) {
                    pushArm('alias', range, `${instr} is an alias`);
                }
            }
        }

        diagnosticCollection.set(document.uri, diagnostics);
    };
}
