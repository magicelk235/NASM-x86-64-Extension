import * as vscode from 'vscode';
import { maskStrings, STRING_REGEX, X86_REGISTERS, DEFINE_DIRECTIVE_REGEX, PREFIX_REGEX, DIRECTIVES } from './constants';
import { readSettings } from './config';
import { InstructionSet } from './x86';
import { Arm64Bundle, ARM64_REGISTERS } from './arm64';
import { KnowledgeBase, SymbolInfo, SymbolManager, discoverUndefinedSymbolsInDocument } from './symbols';

const TOKEN_TYPES = ['keyword', 'operator', 'parameter', 'function', 'variable', 'string', 'comment'];
const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, []);

interface ProviderContext {
    instructionSet: InstructionSet;
    arm64: Arm64Bundle;
    kb: KnowledgeBase;
    symbolManager: SymbolManager;
}

// Nearest preceding non-local label definition (`name:`), which scopes '.locals'.
const PARENT_LABEL_RE = /^\s*([a-zA-Z_?][a-zA-Z0-9_$#@~?]*):/;

function parentLabelAt(document: vscode.TextDocument, line: number): string | null {
    for (let i = Math.min(line, document.lineCount - 1); i >= 0; i--) {
        const m = document.lineAt(i).text.match(PARENT_LABEL_RE);
        if (m) return m[1];
    }
    return null;
}

// ---------- Completion ----------

function makeCompletionProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerCompletionItemProvider('nasm', {
        provideCompletionItems(document, position) {
            const itemsMap = new Map<string, vscode.CompletionItem>();
            const wordRange = document.getWordRangeAtPosition(position, /[%a-zA-Z0-9_$#@~.?]+/);
            const word = wordRange ? document.getText(wordRange) : '';
            const arch = readSettings().arch;

            if (arch === 'x86-64') {
                for (const key in ctx.instructionSet) {
                    const instr = ctx.instructionSet[key];
                    const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Function);
                    item.detail = instr.summary;
                    if (wordRange) item.range = wordRange;
                    itemsMap.set(key.toLowerCase(), item);
                }
                X86_REGISTERS.forEach(reg => {
                    if (itemsMap.has(reg)) return;
                    const item = new vscode.CompletionItem(reg, vscode.CompletionItemKind.Variable);
                    if (wordRange) item.range = wordRange;
                    itemsMap.set(reg, item);
                });
            } else {
                for (const mn in ctx.arm64.db) {
                    const item = new vscode.CompletionItem(mn, vscode.CompletionItemKind.Function);
                    item.detail = ctx.arm64.summaries[mn] || '';
                    const features = [...new Set(
                        ctx.arm64.db[mn].map(f => f.featureSet).filter(Boolean)
                    )];
                    if (features.length) {
                        item.documentation = new vscode.MarkdownString(`*Feature set:* ${features.join(', ')}`);
                    }
                    if (wordRange) item.range = wordRange;
                    itemsMap.set(mn, item);
                }
                ARM64_REGISTERS.forEach(reg => {
                    if (itemsMap.has(reg)) return;
                    const item = new vscode.CompletionItem(reg, vscode.CompletionItemKind.Variable);
                    if (wordRange) item.range = wordRange;
                    itemsMap.set(reg, item);
                });
            }

            for (const key in ctx.kb) {
                if (key.startsWith('%') && !word.startsWith('%')) continue;
                if (itemsMap.has(key.toLowerCase())) continue;

                const kind = key.startsWith('%')
                    ? vscode.CompletionItemKind.Keyword
                    : X86_REGISTERS.has(key.toLowerCase())
                        ? vscode.CompletionItemKind.Variable
                        : vscode.CompletionItemKind.Function;
                const item = new vscode.CompletionItem(key, kind);
                item.documentation = new vscode.MarkdownString(ctx.kb[key]);
                if (wordRange) item.range = wordRange;
                itemsMap.set(key.toLowerCase(), item);
            }

            // NASM directives (section, global, extern, db, ...) — '%'-directives
            // already arrive via the knowledge base above.
            DIRECTIVES.forEach(dir => {
                if (itemsMap.has(dir)) return;
                const item = new vscode.CompletionItem(dir, vscode.CompletionItemKind.Keyword);
                if (wordRange) item.range = wordRange;
                itemsMap.set(dir, item);
            });

            const cursorParent = parentLabelAt(document, position.line);
            ctx.symbolManager.getSymbols().forEach(sym => {
                // A local '.label' is only in scope under the parent it was defined beneath.
                if (sym.name.startsWith('.') && sym.uri.toString() === document.uri.toString()) {
                    const symParent = parentLabelAt(document, sym.range.start.line);
                    if (symParent !== cursorParent) return;
                }
                const item = new vscode.CompletionItem(sym.name, sym.kind);
                if (sym.description) item.documentation = new vscode.MarkdownString(sym.description);
                if (wordRange) item.range = wordRange;
                if (sym.kind === vscode.CompletionItemKind.Snippet && sym.macroParams) {
                    const snippet = macroSnippet(sym.name, sym.macroParams);
                    if (snippet) {
                        item.insertText = snippet;
                        item.detail = `%macro ${sym.name} ${sym.macroParams}`;
                    }
                }
                itemsMap.set(sym.name.toLowerCase(), item);
            });

            const dynamicSymbols = discoverUndefinedSymbolsInDocument(document, new Set(itemsMap.keys()), ctx.kb);
            dynamicSymbols.forEach(sym => {
                if (itemsMap.has(sym.name.toLowerCase())) return;
                // Local labels are scoped; defer to SymbolManager's scoped entries above.
                if (sym.name.startsWith('.')) return;
                const item = new vscode.CompletionItem(sym.name, sym.kind);
                if (wordRange) item.range = wordRange;
                itemsMap.set(sym.name.toLowerCase(), item);
            });

            return Array.from(itemsMap.values());
        },
    }, '%', '.');
}

// Build a tab-stop snippet for a macro invocation from its param spec.
// "2" -> `name ${1:%1}, ${2:%2}`; "1-3" uses the minimum (1) placeholder count.
function macroSnippet(name: string, spec: string): vscode.SnippetString | undefined {
    const m = spec.match(/^(\d+)(?:-(\d+))?(\+)?$/);
    if (!m) return undefined;
    const count = parseInt(m[1], 10);
    if (count === 0) return undefined; // no args: plain text completion is fine
    const parts: string[] = [];
    for (let p = 0; p < count; p++) parts.push(`\${${p + 1}:%${p + 1}}`);
    return new vscode.SnippetString(`${name} ${parts.join(', ')}`);
}

// ---------- Hover ----------

// Describe an x86-64 or AArch64 register: width + class. Returns null if not a register.
function describeRegister(reg: string, arch: string): string | null {
    const r = reg.toLowerCase();
    if (arch === 'x86-64') {
        if (!X86_REGISTERS.has(r)) return null;
        if (/^(?:ip|eip|rip)$/.test(r)) return 'instruction pointer';
        if (/^r(?:[a-d]x|si|di|bp|sp)$/.test(r) || /^r(?:[89]|1[0-5])$/.test(r)) return '64-bit general-purpose register';
        if (/^e(?:[a-d]x|si|di|bp|sp)$/.test(r) || /^r(?:[89]|1[0-5])d$/.test(r)) return '32-bit general-purpose register';
        if (/^(?:[a-d]x|si|di|bp|sp)$/.test(r) || /^r(?:[89]|1[0-5])w$/.test(r)) return '16-bit general-purpose register';
        if (/^(?:[a-d][lh]|sil|dil|bpl|spl)$/.test(r) || /^r(?:[89]|1[0-5])b$/.test(r)) return '8-bit general-purpose register';
        if (/^zmm\d+$/.test(r)) return '512-bit SIMD vector register (AVX-512)';
        if (/^ymm\d+$/.test(r)) return '256-bit SIMD vector register (AVX)';
        if (/^xmm\d+$/.test(r)) return '128-bit SIMD vector register (SSE)';
        if (/^mm\d+$/.test(r))  return '64-bit MMX register';
        if (/^st\d+$/.test(r))  return '80-bit x87 FPU stack register';
        if (/^k[0-7]$/.test(r))  return 'AVX-512 opmask register';
        if (/^(?:cs|ds|es|fs|gs|ss)$/.test(r)) return '16-bit segment register';
        if (/^cr\d+$/.test(r))  return 'control register';
        if (/^dr\d+$/.test(r))  return 'debug register';
        return 'register';
    }
    if (!ARM64_REGISTERS.has(r)) return null;
    if (/^x(?:\d|[12]\d|30)$/.test(r)) return '64-bit general-purpose register';
    if (/^w(?:\d|[12]\d|30)$/.test(r)) return '32-bit general-purpose register';
    if (/^q\d+$/.test(r)) return '128-bit SIMD/FP register';
    if (/^d\d+$/.test(r)) return '64-bit SIMD/FP register';
    if (/^s\d+$/.test(r)) return '32-bit SIMD/FP register';
    if (/^h\d+$/.test(r)) return '16-bit SIMD/FP register';
    if (/^b\d+$/.test(r)) return '8-bit SIMD/FP register';
    if (/^v\d+$/.test(r)) return '128-bit SIMD vector register';
    if (/^z\d+$/.test(r)) return 'SVE scalable vector register';
    if (/^p\d+$/.test(r)) return 'SVE predicate register';
    if (r === 'sp' || r === 'wsp') return 'stack pointer';
    if (r === 'xzr' || r === 'wzr') return 'zero register';
    if (r === 'lr') return 'link register (x30)';
    if (r === 'pc') return 'program counter';
    return 'register';
}

// NASM data unit sizes in bytes.
const DATA_SIZES: Record<string, { bytes: number; name: string }> = {
    db: { bytes: 1,  name: 'byte' },      resb: { bytes: 1,  name: 'byte' },
    dw: { bytes: 2,  name: 'word' },      resw: { bytes: 2,  name: 'word' },
    dd: { bytes: 4,  name: 'doubleword' }, resd: { bytes: 4,  name: 'doubleword' },
    dq: { bytes: 8,  name: 'quadword' },  resq: { bytes: 8,  name: 'quadword' },
    dt: { bytes: 10, name: 'tword (80-bit)' }, rest: { bytes: 10, name: 'tword (80-bit)' },
    do: { bytes: 16, name: 'oword (128-bit)' }, reso: { bytes: 16, name: 'oword (128-bit)' },
    dy: { bytes: 32, name: 'yword (256-bit)' }, resy: { bytes: 32, name: 'yword (256-bit)' },
    dz: { bytes: 64, name: 'zword (512-bit)' }, resz: { bytes: 64, name: 'zword (512-bit)' },
};

const HOVER_WORD_RE = /(?:[+-]?0x[0-9a-fA-F]+|[+-]?\$[0-9a-fA-F]+|[+-]?[0-9][0-9a-fA-F]*h|[+-]?0b[01]+|[+-]?[01]+[by]|[+-]?\d+\.\d*(?:[eE][+-]?\d+)?|[+-]?\.\d+(?:[eE][+-]?\d+)?|[+-]?\d+[dt]?|(?:%%|%\?|%\*|%\$|%#|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*)/i;

const HEX_RE   = /^[+-]?(?:0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9][0-9a-fA-F]*h)$/i;
const BIN_RE   = /^[+-]?(?:0b[01]+|[01]+[by])$/i;
const DEC_RE   = /^[+-]?\d+[dt]?$/i;
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/i;

function extendHoverRange(document: vscode.TextDocument, range: vscode.Range): vscode.Range {
    if (range.start.character === 0) return range;
    const lineText = document.lineAt(range.start.line).text;
    const startChar = range.start.character;
    let extendBy = 0;

    if (startChar >= 2 && lineText.substring(startChar - 2, startChar) === '%%') {
        extendBy = 2;
    } else if (lineText[startChar - 1] === '%') {
        extendBy = 1;
    } else if (lineText[startChar - 1] === '-' || lineText[startChar - 1] === '+') {
        const wordText = document.getText(range);
        if (/^(?:0x[0-9a-fA-F]|0b[01]|\$[0-9a-fA-F]|[0-9])/.test(wordText)) extendBy = 1;
    }

    if (extendBy === 0) return range;
    return new vscode.Range(new vscode.Position(range.start.line, startChar - extendBy), range.end);
}

function numericHover(word: string, wordLower: string, range: vscode.Range): vscode.Hover | undefined {
    let val: bigint | null = null;
    let type: 'hex' | 'bin' | 'dec' | 'float' | null = null;

    const stripSign = (s: string): [string, string] => {
        if (s.startsWith('-')) return ['-', s.substring(1)];
        if (s.startsWith('+')) return ['',  s.substring(1)];
        return ['', s];
    };

    if (HEX_RE.test(word)) {
        type = 'hex';
        const [sign, body] = stripSign(wordLower);
        let s = body;
        if (s.startsWith('0x'))      s = s.substring(2);
        else if (s.startsWith('$'))  s = s.substring(1);
        else if (s.endsWith('h'))    s = s.substring(0, s.length - 1);
        try { val = BigInt('0x' + s); if (sign === '-') val = -val; }
        catch { return; }
    } else if (BIN_RE.test(word)) {
        type = 'bin';
        const [sign, body] = stripSign(wordLower);
        let s = body;
        if (s.startsWith('0b')) s = s.substring(2);
        else                    s = s.substring(0, s.length - 1);
        try { val = BigInt('0b' + s); if (sign === '-') val = -val; }
        catch { return; }
    } else if (DEC_RE.test(word)) {
        type = 'dec';
        let s = wordLower;
        if (s.endsWith('d') || s.endsWith('t')) s = s.substring(0, s.length - 1);
        try { val = BigInt(s); } catch { return; }
    } else if (FLOAT_RE.test(word)) {
        const f = parseFloat(word);
        const arr = new Float64Array(1); arr[0] = f;
        const bits = new BigUint64Array(arr.buffer)[0];

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`Hex: \`0x${bits.toString(16).toUpperCase().padStart(16, '0')}\`  \n`);
        const b = bits.toString(2).padStart(64, '0');
        md.appendMarkdown(`Bin: \`${b.match(/.{1,8}/g)?.join(' ') || b}\``);
        return new vscode.Hover(md, range);
    }

    if (val === null || type === null) return;

    const md = new vscode.MarkdownString();
    if (type !== 'dec') md.appendMarkdown(`Dec: \`${val.toString(10)}\`  \n`);

    // Printable-ASCII rendering for byte-range values, handy for `db` constants.
    if (val >= BigInt(0x20) && val <= BigInt(0x7e)) {
        const ch = String.fromCharCode(Number(val));
        // A literal backtick can't sit inside a markdown code span; widen the fence.
        const span = ch === '`' ? '`` ` ``' : `\`'${ch}'\``;
        md.appendMarkdown(`Char: ${span}  \n`);
    }

    const isNeg = val < BigInt(0);
    if (type !== 'hex') {
        const hex = isNeg
            ? BigInt.asUintN(64, val).toString(16).toUpperCase().padStart(16, '0')
            : val.toString(16).toUpperCase();
        md.appendMarkdown(`Hex: \`0x${hex}\`  \n`);
    }
    if (type !== 'bin') {
        let b: string;
        if (isNeg) {
            b = BigInt.asUintN(64, val).toString(2).padStart(64, '0');
        } else {
            b = val.toString(2);
            const paddedLen = Math.max(8, Math.ceil(b.length / 8) * 8);
            b = b.padStart(paddedLen, '0');
        }
        md.appendMarkdown(`Bin: \`${b.match(/.{1,8}/g)?.join(' ') || b}\``);
    }
    return new vscode.Hover(md, range);
}

// Resolve a user symbol the way NASM scoping works: local '.labels' match
// case-sensitively within their parent-label scope in the current file; other
// symbols match by exact name across files. Falls back to a case-insensitive
// match so hover still surfaces docs when the user's casing differs slightly.
function resolveSymbol(
    ctx: ProviderContext,
    document: vscode.TextDocument,
    position: vscode.Position,
    word: string,
): SymbolInfo | undefined {
    const symbols = ctx.symbolManager.getSymbols();
    if (word.startsWith('.')) {
        const scope = parentLabelAt(document, position.line);
        return symbols.find(s =>
            s.name === word &&
            s.uri.toString() === document.uri.toString() &&
            parentLabelAt(document, s.range.start.line) === scope);
    }
    return symbols.find(s => s.name === word)
        ?? symbols.find(s => s.name.toLowerCase() === word.toLowerCase());
}

function makeHoverProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerHoverProvider('nasm', {
        provideHover(document, position) {
            let range = document.getWordRangeAtPosition(position, HOVER_WORD_RE);
            if (!range) return;
            range = extendHoverRange(document, range);

            const word = document.getText(range);
            const wordLower = word.toLowerCase();
            const arch = readSettings().arch;

            const dynamicSym = resolveSymbol(ctx, document, position, word);
            if (dynamicSym) {
                const md = new vscode.MarkdownString();
                if (dynamicSym.macroParams) {
                    md.appendCodeblock(`%macro ${dynamicSym.name} ${dynamicSym.macroParams}`, 'nasm');
                } else if (dynamicSym.constValue) {
                    md.appendCodeblock(`${dynamicSym.name} = ${dynamicSym.constValue}`, 'nasm');
                }
                if (dynamicSym.description) {
                    if (md.value) md.appendMarkdown('\n\n');
                    md.appendMarkdown(dynamicSym.description);
                }
                if (md.value) return new vscode.Hover(md, range);
            }

            const isNumeric = HEX_RE.test(word) || BIN_RE.test(word) || DEC_RE.test(word) || FLOAT_RE.test(word);

            if (!isNumeric && DATA_SIZES[wordLower]) {
                const d = DATA_SIZES[wordLower];
                const verb = wordLower.startsWith('res') ? 'reserves' : 'declares';
                return new vscode.Hover(
                    new vscode.MarkdownString(`**${wordLower}** — ${verb} ${d.name} (${d.bytes} byte${d.bytes === 1 ? '' : 's'})`),
                    range);
            }

            if (!isNumeric) {
                const regDesc = describeRegister(wordLower, arch);
                if (regDesc) {
                    return new vscode.Hover(new vscode.MarkdownString(`**${wordLower}** — ${regDesc}`), range);
                }
            }

            if (!isNumeric && arch === 'arm64') {
                const armSummary = ctx.arm64.summaries[wordLower];
                if (armSummary) {
                    const md = new vscode.MarkdownString(`**${wordLower}** — ${armSummary}`);
                    const forms = ctx.arm64.db[wordLower];
                    if (forms && forms.length > 0) {
                        const counts = [...new Set(forms.map(f => f.operands.length))].sort((a, b) => a - b).join(', ');
                        md.appendMarkdown(`  \n*operands:* ${counts} · *feature:* ${forms[0].featureSet || 'V8'}`);
                    }
                    return new vscode.Hover(md, range);
                }
            }

            const instrInfo = ctx.instructionSet[wordLower];
            if (instrInfo && !isNumeric && arch === 'x86-64') {
                return new vscode.Hover(
                    new vscode.MarkdownString(`**${wordLower}** — ${instrInfo.summary}`),
                    range
                );
            }

            if (ctx.kb[wordLower] && !isNumeric) {
                return new vscode.Hover(new vscode.MarkdownString(ctx.kb[wordLower]), range);
            }

            return numericHover(word, wordLower, range);
        },
    });
}

// ---------- Definition ----------

const SYMBOL_WORD_RE = /(?:%%|%\?|%\*|%\$|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*/;

function makeDefinitionProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerDefinitionProvider('nasm', {
        provideDefinition(document, position) {
            const range = document.getWordRangeAtPosition(position, SYMBOL_WORD_RE);
            if (!range) return;
            const word = document.getText(range);
            const symbols = ctx.symbolManager.getSymbols();

            // Local labels ('.loop') are scoped to their parent label and are
            // case-sensitive; resolve them within the current file's scope only.
            if (word.startsWith('.')) {
                const scope = parentLabelAt(document, position.line);
                const local = symbols.find(s =>
                    s.name === word &&
                    s.uri.toString() === document.uri.toString() &&
                    parentLabelAt(document, s.range.start.line) === scope);
                return local ? new vscode.Location(local.uri, local.range) : undefined;
            }

            const sym = symbols.find(s => s.name === word);
            return sym ? new vscode.Location(sym.uri, sym.range) : undefined;
        },
    });
}

// ---------- References / Rename shared scan ----------

// Find every exact-case occurrence of `name` as a standalone identifier,
// skipping string literals and comments. NASM identifiers are case-sensitive.
// For a local '.label', pass `scopeParent` to restrict matches to the lines
// under that parent label (locals with the same text are distinct per parent).
function findOccurrences(
    document: vscode.TextDocument,
    name: string,
    scopeParent?: string | null
): vscode.Range[] {
    const scoped = name.startsWith('.') && scopeParent !== undefined;
    const ranges: vscode.Range[] = [];
    const lines = document.getText().split(/\r?\n/);
    const idRe = new RegExp(SYMBOL_WORD_RE.source, 'g');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const commentIdx = maskStrings(line).indexOf(';');
        const codeLimit = commentIdx === -1 ? line.length : commentIdx;
        const codeMasked = maskStrings(line.substring(0, codeLimit));

        idRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = idRe.exec(codeMasked)) !== null) {
            if (m[0] !== name) continue;
            if (scoped && parentLabelAt(document, i) !== scopeParent) continue;
            ranges.push(new vscode.Range(i, m.index, i, m.index + m[0].length));
        }
    }
    return ranges;
}

function makeReferenceProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerReferenceProvider('nasm', {
        provideReferences(document, position, context) {
            const range = document.getWordRangeAtPosition(position, SYMBOL_WORD_RE);
            if (!range) return;
            const word = document.getText(range);
            const scope = parentLabelAt(document, position.line);
            const occurrences = findOccurrences(document, word, scope);

            // Exclude the declaration when not requested. Match case-sensitively
            // and (for locals) within the same parent scope, like findOccurrences.
            const sym = ctx.symbolManager.getSymbols().find(s =>
                s.name === word &&
                s.uri.toString() === document.uri.toString() &&
                (!word.startsWith('.') || parentLabelAt(document, s.range.start.line) === scope));

            const results = occurrences.filter(r =>
                context.includeDeclaration || !(sym && r.isEqual(sym.range)));
            return results.map(r => new vscode.Location(document.uri, r));
        },
    });
}

// ---------- Document highlight ----------

function makeDocumentHighlightProvider(): vscode.Disposable {
    return vscode.languages.registerDocumentHighlightProvider('nasm', {
        provideDocumentHighlights(document, position) {
            const range = document.getWordRangeAtPosition(position, SYMBOL_WORD_RE);
            if (!range) return;
            const word = document.getText(range);
            return findOccurrences(document, word)
                .map(r => new vscode.DocumentHighlight(r, vscode.DocumentHighlightKind.Text));
        },
    });
}

// ---------- CodeLens (reference counts) ----------

function makeCodeLensProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerCodeLensProvider('nasm', {
        provideCodeLenses(document) {
            const lenses: vscode.CodeLens[] = [];
            for (const sym of ctx.symbolManager.getSymbols(document.uri)) {
                const scopeParent = sym.name.startsWith('.')
                    ? parentLabelAt(document, sym.range.start.line) : undefined;
                const occurrences = findOccurrences(document, sym.name, scopeParent);
                const refs = occurrences.filter(r => !r.isEqual(sym.range));
                lenses.push(new vscode.CodeLens(sym.range, {
                    title: refs.length === 1 ? '1 reference' : `${refs.length} references`,
                    command: refs.length > 0 ? 'editor.action.showReferences' : '',
                    arguments: refs.length > 0
                        ? [document.uri, sym.range.start, refs.map(r => new vscode.Location(document.uri, r))]
                        : [],
                }));
            }
            return lenses;
        },
    });
}

// ---------- Rename ----------

function makeRenameProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerRenameProvider('nasm', {
        prepareRename(document, position) {
            const range = document.getWordRangeAtPosition(position, SYMBOL_WORD_RE);
            if (!range) throw new Error('You cannot rename this element.');
            const word = document.getText(range);
            // Rename only rewrites the current document, so require the definition
            // to live here (case-sensitively) — avoids misleading partial renames
            // of symbols defined in other files.
            const known = ctx.symbolManager.getSymbols(document.uri)
                .some(s => s.name === word);
            if (!known) throw new Error('Only labels, macros, and defines defined in this file can be renamed.');
            return { range, placeholder: word };
        },
        provideRenameEdits(document, position, newName) {
            const range = document.getWordRangeAtPosition(position, SYMBOL_WORD_RE);
            if (!range) return;
            if (!new RegExp(`^${SYMBOL_WORD_RE.source}$`).test(newName)) {
                throw new Error(`'${newName}' is not a valid NASM identifier.`);
            }
            const word = document.getText(range);
            const scopeParent = parentLabelAt(document, position.line);
            const edit = new vscode.WorkspaceEdit();
            for (const r of findOccurrences(document, word, scopeParent)) {
                edit.replace(document.uri, r, newName);
            }
            return edit;
        },
    });
}

// ---------- Signature help (macro invocations) ----------

// Parse a NASM macro param spec ("2", "1-3", "0-1+") into a max param count and
// whether it is variadic (trailing '+'). Returns null if unparseable.
function parseMacroParams(spec: string): { max: number; variadic: boolean } | null {
    const m = spec.match(/^(\d+)(?:-(\d+))?(\+)?$/);
    if (!m) return null;
    const lo = parseInt(m[1], 10);
    const hi = m[2] !== undefined ? parseInt(m[2], 10) : lo;
    return { max: Math.max(lo, hi), variadic: m[3] === '+' };
}

function makeSignatureHelpProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerSignatureHelpProvider('nasm', {
        provideSignatureHelp(document, position) {
            const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
            // Match: optional indent, an optional leading `label:`, the macro name,
            // then a space and any args typed so far.
            const m = linePrefix.match(
                /^\s*(?:[a-zA-Z_?][a-zA-Z0-9_$#@~.?]*:\s*)?([a-zA-Z_?][a-zA-Z0-9_$#@~.?]*)\s+(.*)$/);
            if (!m) return;

            const macroName = m[1];
            const argsText = m[2];
            const sym = ctx.symbolManager.getSymbols()
                .find(s => s.kind === vscode.CompletionItemKind.Snippet &&
                           s.name.toLowerCase() === macroName.toLowerCase() &&
                           s.macroParams !== undefined);
            if (!sym || !sym.macroParams) return;

            const spec = parseMacroParams(sym.macroParams);
            if (!spec) return;

            const count = spec.variadic ? spec.max + 1 : spec.max;
            if (count === 0) return; // 0-arg macro: nothing to hint
            const params: vscode.ParameterInformation[] = [];
            for (let p = 0; p < count; p++) {
                const isRest = spec.variadic && p === spec.max;
                params.push(new vscode.ParameterInformation(isRest ? `...rest` : `%${p + 1}`));
            }

            const sig = new vscode.SignatureInformation(
                `${macroName} ${params.map(p => p.label).join(', ')}`
            );
            sig.parameters = params;
            if (sym.description) sig.documentation = new vscode.MarkdownString(sym.description);

            const help = new vscode.SignatureHelp();
            help.signatures = [sig];
            help.activeSignature = 0;
            // Count top-level commas already typed to pick the active parameter.
            const typed = countTopLevelCommas(argsText);
            help.activeParameter = Math.min(typed, params.length - 1);
            return help;
        },
    }, ' ', ',');
}

function countTopLevelCommas(s: string): number {
    let depth = 0;
    let commas = 0;
    for (const ch of s) {
        if (ch === '[' || ch === '{' || ch === '(') depth++;
        else if (ch === ']' || ch === '}' || ch === ')') depth--;
        else if (ch === ',' && depth === 0) commas++;
    }
    return commas;
}

// ---------- Code actions (quick fixes) ----------

function makeCodeActionProvider(): vscode.Disposable {
    return vscode.languages.registerCodeActionsProvider('nasm', {
        provideCodeActions(document, _range, context) {
            const actions: vscode.CodeAction[] = [];
            for (const diag of context.diagnostics) {
                const text = document.getText(diag.range);

                if (diag.code === 'deprecatedHexPrefix' && text.startsWith('$')) {
                    const fix = new vscode.CodeAction(`Replace '$' with '0x'`, vscode.CodeActionKind.QuickFix);
                    fix.edit = new vscode.WorkspaceEdit();
                    fix.edit.replace(document.uri, diag.range, '0x' + text.substring(1));
                    fix.diagnostics = [diag];
                    actions.push(fix);
                } else if (diag.code === 'labelOrphan') {
                    const fix = new vscode.CodeAction(`Add ':' to make '${text}' a label`, vscode.CodeActionKind.QuickFix);
                    fix.edit = new vscode.WorkspaceEdit();
                    fix.edit.insert(document.uri, diag.range.end, ':');
                    fix.diagnostics = [diag];
                    actions.push(fix);
                } else if (diag.code === 'undefinedSymbol') {
                    const fix = new vscode.CodeAction(`Declare '${text}' as extern`, vscode.CodeActionKind.QuickFix);
                    fix.edit = new vscode.WorkspaceEdit();
                    fix.edit.insert(document.uri, new vscode.Position(0, 0), `extern ${text}\n`);
                    fix.diagnostics = [diag];
                    actions.push(fix);
                }
            }
            return actions;
        },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });
}

// ---------- Document links (%include / incbin) ----------

function makeDocumentLinkProvider(): vscode.Disposable {
    // %include "f", %incbin "f", incbin "f"  — quote may be ' " or `.
    const INCLUDE_RE = /(?:^|\s)(?:%include|%incbin|incbin)\s+(["'`])([^"'`]+)\1/gi;
    return vscode.languages.registerDocumentLinkProvider('nasm', {
        provideDocumentLinks(document) {
            const links: vscode.DocumentLink[] = [];
            const docDir = vscode.Uri.joinPath(document.uri, '..');
            const lines = document.getText().split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                INCLUDE_RE.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = INCLUDE_RE.exec(lines[i])) !== null) {
                    const file = m[2];
                    const pathStart = m.index + m[0].indexOf(file);
                    const range = new vscode.Range(i, pathStart, i, pathStart + file.length);
                    const target = /^(?:\/|[a-zA-Z]:[\\/])/.test(file)
                        ? vscode.Uri.file(file)
                        : vscode.Uri.joinPath(docDir, file);
                    const link = new vscode.DocumentLink(range, target);
                    link.tooltip = `Open ${file}`;
                    links.push(link);
                }
            }
            return links;
        },
    });
}

// ---------- Inlay hints (resolved constant values) ----------

// Evaluate a NASM constant expression to a BigInt, resolving symbolic constants
// through `consts`. Supports + - * / % << >> & | ^ ~ and parens over integer
// literals (dec/hex/bin/octal) and other constants. Returns null if anything is
// unrecognized (labels, $, registers, strings, float, division by zero, cycles).
function evalConstExpr(
    expr: string,
    consts: Map<string, string>,
    seen: Set<string>
): bigint | null {
    const tokens = tokenizeExpr(expr);
    if (!tokens) return null;
    let pos = 0;

    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function parsePrimary(): bigint | null {
        const t = peek();
        if (t === undefined) return null;
        if (t === '(') {
            next();
            const v = parseBitOr();
            if (peek() !== ')') return null;
            next();
            return v;
        }
        if (t === '-') { next(); const v = parsePrimary(); return v === null ? null : -v; }
        if (t === '+') { next(); return parsePrimary(); }
        if (t === '~') { next(); const v = parsePrimary(); return v === null ? null : ~v; }

        next();
        const lit = parseIntLiteral(t);
        if (lit !== null) return lit;
        // Symbolic constant.
        const name = t.toLowerCase();
        if (seen.has(name)) return null; // cycle
        const rhs = consts.get(name);
        if (rhs === undefined) return null;
        return evalConstExpr(rhs, consts, new Set([...seen, name]));
    }
    function parseMul(): bigint | null {
        let left = parsePrimary();
        while (left !== null && (peek() === '*' || peek() === '/' || peek() === '%')) {
            const op = next();
            const right = parsePrimary();
            if (right === null) return null;
            if ((op === '/' || op === '%') && right === BigInt(0)) return null;
            left = op === '*' ? left * right : op === '/' ? left / right : left % right;
        }
        return left;
    }
    function parseAdd(): bigint | null {
        let left = parseMul();
        while (left !== null && (peek() === '+' || peek() === '-')) {
            const op = next();
            const right = parseMul();
            if (right === null) return null;
            left = op === '+' ? left + right : left - right;
        }
        return left;
    }
    function parseShift(): bigint | null {
        let left = parseAdd();
        while (left !== null && (peek() === '<<' || peek() === '>>')) {
            const op = next();
            const right = parseAdd();
            if (right === null || right < BigInt(0)) return null;
            left = op === '<<' ? left << right : left >> right;
        }
        return left;
    }
    function parseBitAnd(): bigint | null {
        let left = parseShift();
        while (left !== null && peek() === '&') { next(); const r = parseShift(); if (r === null) return null; left = left & r; }
        return left;
    }
    function parseBitXor(): bigint | null {
        let left = parseBitAnd();
        while (left !== null && peek() === '^') { next(); const r = parseBitAnd(); if (r === null) return null; left = left ^ r; }
        return left;
    }
    function parseBitOr(): bigint | null {
        let left = parseBitXor();
        while (left !== null && peek() === '|') { next(); const r = parseBitXor(); if (r === null) return null; left = left | r; }
        return left;
    }

    const result = parseBitOr();
    return pos === tokens.length ? result : null;
}

function tokenizeExpr(expr: string): string[] | null {
    const tokens: string[] = [];
    const re = /\s*(<<|>>|[-+*/%&|^~()]|(?:0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9][0-9a-fA-F]*h|0b[01]+|[01]+[by]|0o?[0-7]+q?|\d+)|(?:\.[a-zA-Z_?]|[a-zA-Z_?])[a-zA-Z0-9_$#@~.?]*)/iy;
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(expr)) !== null) {
        tokens.push(m[1]);
        lastIndex = re.lastIndex;
    }
    // Reject if any non-whitespace remained unmatched (e.g. a string, '$', float dot).
    if (expr.substring(lastIndex).trim() !== '') return null;
    return tokens.length ? tokens : null;
}

function parseIntLiteral(tok: string): bigint | null {
    const t = tok.toLowerCase();
    try {
        if (/^0x[0-9a-f]+$/.test(t)) return BigInt(t);
        if (/^\$[0-9a-f]+$/.test(t)) return BigInt('0x' + t.substring(1));
        if (/^[0-9][0-9a-f]*h$/.test(t)) return BigInt('0x' + t.substring(0, t.length - 1));
        if (/^0b[01]+$/.test(t)) return BigInt(t);
        if (/^[01]+[by]$/.test(t)) return BigInt('0b' + t.substring(0, t.length - 1));
        if (/^0o[0-7]+$/.test(t)) return BigInt(t);
        if (/^0[0-7]+q$/.test(t)) return BigInt('0o' + t.substring(1, t.length - 1));
        if (/^\d+$/.test(t)) return BigInt(t);
    } catch { return null; }
    return null;
}

function makeInlayHintsProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerInlayHintsProvider('nasm', {
        provideInlayHints(document, range) {
            const symbols = ctx.symbolManager.getSymbols(document.uri)
                .flatMap(s => s.kind === vscode.CompletionItemKind.Constant && s.constValue
                    ? [{ name: s.name, constValue: s.constValue, range: s.range }]
                    : []);

            const consts = new Map<string, string>();
            for (const s of symbols) consts.set(s.name.toLowerCase(), s.constValue);

            const hints: vscode.InlayHint[] = [];
            for (const s of symbols) {
                if (!range.contains(s.range.start)) continue;
                // Skip when the literal already is a plain decimal — no value to add.
                const value = evalConstExpr(s.constValue, consts, new Set([s.name.toLowerCase()]));
                if (value === null) continue;
                if (/^[+-]?\d+$/.test(s.constValue.trim())) continue;

                const hint = new vscode.InlayHint(
                    s.range.end,
                    ` = ${value.toString()}`,
                    vscode.InlayHintKind.Type
                );
                hint.paddingLeft = true;
                hints.push(hint);
            }
            return hints;
        },
    });
}

// ---------- Folding ----------

function makeFoldingProvider(): vscode.Disposable {
    const OPEN_DIRECTIVE  = /^\s*%(if\w*|i?r?macro|rep|while)\b/i;
    const CLOSE_DIRECTIVE = /^\s*%(endif|endmacro|endrep|endwhile)\b/i;
    const MID_DIRECTIVE   = /^\s*%(else|elif\w*)\b/i;
    const SECTION_RE      = /^\s*(section|segment)\b/i;
    // A top-level (non-local) label definition; its body folds until the next one.
    const TOP_LABEL_RE    = /^[ \t]*([a-zA-Z_?][a-zA-Z0-9_$#@~?]*):/;

    return vscode.languages.registerFoldingRangeProvider('nasm', {
        provideFoldingRanges(document) {
            const ranges: vscode.FoldingRange[] = [];
            const lines = document.getText().split(/\r?\n/);
            const stack: { line: number; kind: 'block' | 'mid' }[] = [];
            let sectionStart = -1;
            let commentStart = -1;
            let labelStart = -1;
            let labelLastCode = -1; // last non-blank line within the current label body

            const flushLabel = (end: number) => {
                if (labelStart !== -1 && labelLastCode > labelStart) {
                    ranges.push(new vscode.FoldingRange(labelStart, Math.min(end, labelLastCode)));
                }
                labelStart = -1;
            };

            const flushComments = (end: number) => {
                if (commentStart !== -1 && end - commentStart >= 1) {
                    ranges.push(new vscode.FoldingRange(commentStart, end, vscode.FoldingRangeKind.Comment));
                }
                commentStart = -1;
            };

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                // Track runs of consecutive comment-only lines (>=2 lines fold).
                if (/^\s*;/.test(line)) {
                    if (commentStart === -1) commentStart = i;
                } else {
                    flushComments(i - 1);
                }

                if (line.trim() && !/^\s*;/.test(line)) labelLastCode = i;

                if (SECTION_RE.test(line)) {
                    flushLabel(i - 1);
                    if (sectionStart !== -1 && i - 1 > sectionStart) {
                        ranges.push(new vscode.FoldingRange(sectionStart, i - 1, vscode.FoldingRangeKind.Region));
                    }
                    sectionStart = i;
                    continue;
                }

                if (TOP_LABEL_RE.test(line)) {
                    flushLabel(i - 1);
                    labelStart = i;
                }

                if (OPEN_DIRECTIVE.test(line)) {
                    stack.push({ line: i, kind: 'block' });
                } else if (MID_DIRECTIVE.test(line)) {
                    const top = stack[stack.length - 1];
                    if (top) {
                        if (i - 1 > top.line) ranges.push(new vscode.FoldingRange(top.line, i - 1));
                        top.line = i;
                    }
                } else if (CLOSE_DIRECTIVE.test(line)) {
                    const top = stack.pop();
                    if (top && i > top.line) ranges.push(new vscode.FoldingRange(top.line, i));
                }
            }

            flushComments(lines.length - 1);
            flushLabel(lines.length - 1);
            if (sectionStart !== -1 && lines.length - 1 > sectionStart) {
                ranges.push(new vscode.FoldingRange(sectionStart, lines.length - 1, vscode.FoldingRangeKind.Region));
            }
            return ranges;
        },
    });
}

// ---------- Workspace symbols ----------

function symbolKindFor(kind: vscode.CompletionItemKind): vscode.SymbolKind {
    return kind === vscode.CompletionItemKind.Snippet  ? vscode.SymbolKind.Function :
           kind === vscode.CompletionItemKind.Constant ? vscode.SymbolKind.Constant :
           kind === vscode.CompletionItemKind.Function ? vscode.SymbolKind.Function :
                                                          vscode.SymbolKind.Variable;
}

function makeWorkspaceSymbolProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerWorkspaceSymbolProvider({
        provideWorkspaceSymbols(query) {
            const q = query.toLowerCase();
            return ctx.symbolManager.getSymbols()
                .filter(s => !q || s.name.toLowerCase().includes(q))
                .map(s => new vscode.SymbolInformation(
                    s.name, symbolKindFor(s.kind),
                    s.uri.path.split('/').pop() || '',   // file name as container, for context
                    new vscode.Location(s.uri, s.range),
                ));
        },
    });
}

// ---------- Document symbols ----------

function makeDocumentSymbolProvider(ctx: ProviderContext): vscode.Disposable {
    return vscode.languages.registerDocumentSymbolProvider('nasm', {
        provideDocumentSymbols(document) {
            // Symbols are parsed in document order; nest local '.labels' under the
            // most recent top-level label so the Outline view shows structure.
            const roots: vscode.DocumentSymbol[] = [];
            let parent: vscode.DocumentSymbol | undefined;

            for (const sym of ctx.symbolManager.getSymbols(document.uri)) {
                const ds = new vscode.DocumentSymbol(
                    sym.name, '', symbolKindFor(sym.kind), sym.range, sym.range);

                if (sym.name.startsWith('.') && parent) {
                    parent.children.push(ds);
                    // Grow the parent's range to enclose its nested children.
                    parent.range = new vscode.Range(parent.range.start, sym.range.end);
                    continue;
                }

                roots.push(ds);
                parent = sym.kind === vscode.CompletionItemKind.Function ? ds : undefined;
            }
            return roots;
        },
    });
}

// ---------- Semantic tokens ----------

// Directives that turn a preceding colon-less identifier into a defined symbol
// (`NAME db 0`, `LEN equ 5`). Excludes `times`/`incbin`, which don't define one.
const DATA_LABEL_DEF_DIRECTIVES = new Set<string>([
    'db', 'dw', 'dd', 'dq', 'dt', 'do', 'dy', 'dz',
    'resb', 'resw', 'resd', 'resq', 'rest', 'reso', 'resy', 'resz',
    'equ',
]);

function makeSemanticTokensProvider(ctx: ProviderContext): vscode.Disposable {
    const NUMBER_RE = /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|\b[0-9][0-9a-fA-F]*h|0b[01]+|\b[01]+[by]|\b\d+[dt]?\b/g;
    const ID_RE   = /(?:%%|%\?|%\*|%\$|%#|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*/g;
    const PUNCT_RE = /[[\])(,]/g;

    return vscode.languages.registerDocumentSemanticTokensProvider('nasm', {
        provideDocumentSemanticTokens(document) {
            const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
            const lines = document.getText().split(/\r?\n/);
            const macroNames = new Set(
                ctx.symbolManager.getSymbols()
                    .filter(s => s.kind === vscode.CompletionItemKind.Snippet
                              || s.kind === vscode.CompletionItemKind.Constant)
                    .map(s => s.name.toLowerCase())
            );

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) continue;

                const lineTokens: { start: number; length: number; type: string }[] = [];
                const commentIdx = maskStrings(line).indexOf(';');
                if (commentIdx !== -1) {
                    lineTokens.push({ start: commentIdx, length: line.length - commentIdx, type: 'comment' });
                }

                const codeLimit = commentIdx === -1 ? line.length : commentIdx;
                const codePartOriginal = line.substring(0, codeLimit);

                const strRe = new RegExp(STRING_REGEX.source, 'g');
                let strMatch: RegExpExecArray | null;
                while ((strMatch = strRe.exec(codePartOriginal)) !== null) {
                    lineTokens.push({ start: strMatch.index, length: strMatch[0].length, type: 'string' });
                }

                const codePartMasked = maskStrings(codePartOriginal);

                const numberPositions = new Set<number>();
                const numRe = new RegExp(NUMBER_RE.source, 'g');
                let numMatch: RegExpExecArray | null;
                while ((numMatch = numRe.exec(codePartMasked)) !== null) {
                    for (let n = 0; n < numMatch[0].length; n++) numberPositions.add(numMatch.index + n);
                }

                const punctRe = new RegExp(PUNCT_RE.source, 'g');
                let punctMatch: RegExpExecArray | null;
                while ((punctMatch = punctRe.exec(codePartMasked)) !== null) {
                    lineTokens.push({ start: punctMatch.index, length: 1, type: 'operator' });
                }

                const idRe = new RegExp(ID_RE.source, 'g');
                let idMatch: RegExpExecArray | null;
                let instructionSlotTaken = false;
                let defineNamePending = false;
                while ((idMatch = idRe.exec(codePartMasked)) !== null) {
                    if (numberPositions.has(idMatch.index)) continue;

                    const word = idMatch[0];
                    const wordLower = word.toLowerCase();
                    const isPrefix = PREFIX_REGEX.test(word);
                    const isDefineDirective = DEFINE_DIRECTIVE_REGEX.test(word);
                    const remaining = codePartMasked.substring(idMatch.index + word.length).trimStart();
                    const isLabelDef = remaining.startsWith(':');

                    if (isLabelDef) {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'function' });
                        continue;
                    }
                    if (word === '%') {
                        lineTokens.push({ start: idMatch.index, length: 1, type: 'operator' });
                        continue;
                    }
                    if (defineNamePending) {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'function' });
                        defineNamePending = false;
                        continue;
                    }
                    if (X86_REGISTERS.has(wordLower) || ARM64_REGISTERS.has(wordLower)) {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'parameter' });
                        if (!instructionSlotTaken) instructionSlotTaken = true;
                    } else if (macroNames.has(wordLower)) {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'keyword' });
                        if (!instructionSlotTaken) instructionSlotTaken = true;
                    } else if (!instructionSlotTaken) {
                        // Colon-less definition: `NAME equ ...` / `NAME db ...`.
                        // The identifier is the symbol; the directive is the keyword.
                        const nextWord = (remaining.match(/^[a-zA-Z_?][a-zA-Z0-9_$#@~.?]*/) || [''])[0].toLowerCase();
                        if (DATA_LABEL_DEF_DIRECTIVES.has(nextWord)) {
                            lineTokens.push({ start: idMatch.index, length: word.length, type: 'function' });
                            continue;
                        }
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'keyword' });
                        if (!isPrefix) instructionSlotTaken = true;
                        if (isDefineDirective) defineNamePending = true;
                    } else {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'variable' });
                    }
                }

                lineTokens.sort((a, b) => a.start - b.start);
                lineTokens.forEach(t =>
                    builder.push(new vscode.Range(i, t.start, i, t.start + t.length), t.type)
                );
            }
            return builder.build();
        },
    }, SEMANTIC_LEGEND);
}

// ---------- Formatter ----------

interface AsmLine {
    raw: string;
    label: string;      // includes trailing ':' if present, else ''
    mnemonic: string;
    operands: string;
    comment: string;    // includes leading ';', else ''
    isDirectiveLine: boolean; // %if/%macro/section etc — keep mnemonic but no operand column align
    dataLabel: boolean;       // colon-less label (`msg db 0`) — keep inline, don't break to own line
    blank: boolean;
}

const LABEL_DEF_RE = /^(\s*)((?:\.[a-zA-Z_?]|[a-zA-Z_?])[a-zA-Z0-9_$#@~.?]*:)/;

// Directives that conventionally sit flush at column 0 (no operand-column alignment).
const COL0_DIRECTIVES = new Set<string>([
    'section', 'segment', 'global', 'extern', 'common', 'bits',
    'default', 'cpu', 'use16', 'use32', 'use64', 'org', 'group',
]);

// Directives that may follow a colon-less label: `name db 0`, `len equ 5`.
const DATA_LABEL_DIRECTIVES = new Set<string>([
    'db', 'dw', 'dd', 'dq', 'dt', 'do', 'dy', 'dz',
    'resb', 'resw', 'resd', 'resq', 'rest', 'reso', 'resy', 'resz',
    'equ', 'times', 'incbin',
]);

function splitAsmLine(raw: string): AsmLine {
    if (!raw.trim()) {
        return { raw, label: '', mnemonic: '', operands: '', comment: '', isDirectiveLine: false, dataLabel: false, blank: true };
    }

    const commentIdx = maskStrings(raw).indexOf(';');
    let code = commentIdx === -1 ? raw : raw.substring(0, commentIdx);
    const comment = commentIdx === -1 ? '' : raw.substring(commentIdx).trimEnd();

    let label = '';
    let dataLabel = false;
    const labelMatch = code.match(LABEL_DEF_RE);
    if (labelMatch) {
        label = labelMatch[2];
        code = code.substring(labelMatch[0].length);
    } else {
        // Colon-less label preceding a data/equ directive: `name db 0`, `len equ $-x`.
        const dl = code.match(/^(\s*)((?:\.[a-zA-Z_?]|[a-zA-Z_?])[a-zA-Z0-9_$#@~.?]*)\s+(\S+)/);
        if (dl && DATA_LABEL_DIRECTIVES.has(dl[3].toLowerCase())) {
            label = dl[2];
            dataLabel = true;
            code = code.substring(dl[1].length + dl[2].length);
        }
    }

    code = code.trim();
    let mnemonic = '';
    let operands = '';
    if (code) {
        const sp = code.search(/\s/);
        if (sp === -1) {
            mnemonic = code;
        } else {
            mnemonic = code.substring(0, sp);
            operands = code.substring(sp).trim();
        }
    }

    const isDirectiveLine = mnemonic.startsWith('%') || COL0_DIRECTIVES.has(mnemonic.toLowerCase());
    return { raw, label, mnemonic, operands, comment, isDirectiveLine, dataLabel, blank: false };
}

function normalizeOperands(operands: string): string {
    // Collapse whitespace, put one space after each top-level comma.
    let depth = 0;
    let out = '';
    for (let i = 0; i < operands.length; i++) {
        const ch = operands[i];
        if (ch === '[' || ch === '{' || ch === '(') depth++;
        else if (ch === ']' || ch === '}' || ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            out = out.replace(/\s+$/, '') + ', ';
            while (operands[i + 1] === ' ' || operands[i + 1] === '\t') i++;
        } else if (ch === ' ' || ch === '\t') {
            if (!out.endsWith(' ')) out += ' ';
        } else {
            out += ch;
        }
    }
    return out.trim();
}

// Alignment columns are derived from the whole document so a formatted
// selection still lines up with the surrounding, unformatted code.
function computeColumns(parsed: AsmLine[]): { mnemonicCol: number; dataLabelCol: number } {
    let mnemonicWidth = 0;
    let dataLabelWidth = 0;
    for (const p of parsed) {
        if (p.blank) continue;
        if (p.dataLabel) {
            if (p.label.length > dataLabelWidth) dataLabelWidth = p.label.length;
        } else if (!p.isDirectiveLine && p.mnemonic) {
            if (p.mnemonic.length > mnemonicWidth) mnemonicWidth = p.mnemonic.length;
        }
    }
    return { mnemonicCol: mnemonicWidth + 1, dataLabelCol: dataLabelWidth + 1 };
}

function rebuildLine(p: AsmLine, tab: string, mnemonicCol: number, dataLabelCol: number): string {
    if (p.isDirectiveLine) {
        // Directives and sections sit at column 0, no operand alignment.
        const body = [p.mnemonic, normalizeOperands(p.operands)].filter(Boolean).join(' ');
        let rebuilt = (p.label ? p.label + ' ' : '') + body;
        if (p.comment) rebuilt = (rebuilt ? rebuilt + ' ' : '') + p.comment;
        return rebuilt;
    }
    if (p.dataLabel) {
        // Colon-less data label: `msg<pad>db ...`, kept on one line at column 0.
        const ops = normalizeOperands(p.operands);
        let rebuilt = p.label + ' '.repeat(dataLabelCol - p.label.length) + p.mnemonic;
        if (ops) rebuilt += ' ' + ops;
        if (p.comment) rebuilt += ' ' + p.comment;
        return rebuilt;
    }
    if (!p.mnemonic) {
        // Label-only line.
        let rebuilt = p.label;
        if (p.comment) rebuilt = (rebuilt ? rebuilt + ' ' : '') + p.comment;
        return rebuilt;
    }
    const ops = normalizeOperands(p.operands);
    let body = p.mnemonic;
    if (ops) body += ' '.repeat(mnemonicCol - p.mnemonic.length) + ops;
    let rebuilt = tab + body;
    if (p.label) rebuilt = p.label + '\n' + rebuilt;
    if (p.comment) rebuilt = rebuilt + ' ' + p.comment;
    return rebuilt;
}

function formatLines(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    fromLine: number,
    toLine: number,
): vscode.TextEdit[] {
    const tab = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
    const lines = document.getText().split(/\r?\n/);
    const parsed = lines.map(splitAsmLine);
    const { mnemonicCol, dataLabelCol } = computeColumns(parsed);

    const edits: vscode.TextEdit[] = [];
    for (let i = fromLine; i <= toLine; i++) {
        const p = parsed[i];
        if (p.blank) continue;
        const rebuilt = rebuildLine(p, tab, mnemonicCol, dataLabelCol);
        if (rebuilt !== p.raw) {
            edits.push(vscode.TextEdit.replace(new vscode.Range(i, 0, i, lines[i].length), rebuilt));
        }
    }
    return edits;
}

function makeFormatter(): vscode.Disposable {
    return vscode.languages.registerDocumentFormattingEditProvider('nasm', {
        provideDocumentFormattingEdits(document, options) {
            return formatLines(document, options, 0, document.lineCount - 1);
        },
    });
}

function makeRangeFormatter(): vscode.Disposable {
    return vscode.languages.registerDocumentRangeFormattingEditProvider('nasm', {
        provideDocumentRangeFormattingEdits(document, range, options) {
            return formatLines(document, options, range.start.line, range.end.line);
        },
    });
}

// ---------- Aggregator ----------

export function registerAllProviders(ctx: ProviderContext): vscode.Disposable[] {
    return [
        makeCompletionProvider(ctx),
        makeHoverProvider(ctx),
        makeDefinitionProvider(ctx),
        makeReferenceProvider(ctx),
        makeRenameProvider(ctx),
        makeDocumentHighlightProvider(),
        makeCodeLensProvider(ctx),
        makeSignatureHelpProvider(ctx),
        makeCodeActionProvider(),
        makeInlayHintsProvider(ctx),
        makeDocumentLinkProvider(),
        makeWorkspaceSymbolProvider(ctx),
        makeDocumentSymbolProvider(ctx),
        makeSemanticTokensProvider(ctx),
        makeFoldingProvider(),
        makeFormatter(),
        makeRangeFormatter(),
    ];
}
