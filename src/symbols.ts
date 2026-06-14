import * as vscode from 'vscode';
import { maskStrings, X86_REGISTERS } from './constants';

export interface KnowledgeBase {
    [key: string]: string;
}

export interface SymbolInfo {
    name: string;
    description: string;
    kind: vscode.CompletionItemKind;
    range: vscode.Range;
    uri: vscode.Uri;
    macroParams?: string;   // raw NASM param spec for %macro, e.g. "2", "1-3", "0-1+"
    constValue?: string;    // raw RHS of an equ/%define/%assign, for inlay-hint evaluation
}

const ID_REGEX_SOURCE = '(?:%%|%\\?|%\\*|%\\$|%#|\\.[a-zA-Z_?]|[a-zA-Z_?])[a-zA-Z0-9_$#@~.?]*';

const LABEL_RE  = new RegExp(`^\\s*(${ID_REGEX_SOURCE}):`);
const MACRO_RE  = new RegExp(`^\\s*%(?:macro|rmacro|imacro|irmacro)\\s+(${ID_REGEX_SOURCE})\\s+(\\d+(?:-\\d+)?\\+?)`, 'i');
const DEFINE_RE = new RegExp(
    `^\\s*%(?:i?x?define|i?def(?:str|tok)|i?assign|strlen|substr)\\s+(${ID_REGEX_SOURCE})(\\([^)]*\\))?(.*)$`,
    'i'
);
// NASM `name equ value` — a colon-less symbolic constant.
const EQU_RE = new RegExp(`^\\s*(${ID_REGEX_SOURCE})\\s+equ\\s+(.+)$`, 'i');
// NASM `name db ...` / `name resq ...` — a colon-less data label.
const DATA_LABEL_RE = new RegExp(
    `^\\s*(${ID_REGEX_SOURCE})\\s+(d[bwdqtoyz]|res[bwdqtoyz])\\b`,
    'i'
);

export class SymbolManager {
    private cache = new Map<string, { version: number; symbols: SymbolInfo[] }>();

    public updateCache(document: vscode.TextDocument): void {
        if (document.languageId !== 'nasm') return;
        this.cache.set(document.uri.toString(), {
            version: document.version,
            symbols: this.parseDocumentSymbols(document),
        });
    }

    public getSymbols(uri?: vscode.Uri): SymbolInfo[] {
        if (uri) {
            const cached = this.cache.get(uri.toString());
            return cached ? cached.symbols : [];
        }
        const all: SymbolInfo[] = [];
        for (const entry of this.cache.values()) all.push(...entry.symbols);
        return all;
    }

    public clear(uri: vscode.Uri): void {
        this.cache.delete(uri.toString());
    }

    private parseDocumentSymbols(document: vscode.TextDocument): SymbolInfo[] {
        const symbols: SymbolInfo[] = [];
        const lines = document.getText().split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            const labelMatch = line.match(LABEL_RE);
            if (labelMatch) {
                const name = labelMatch[1];
                const startIdx = line.indexOf(name);
                symbols.push({
                    name,
                    description: extractComment(lines, i),
                    kind: (name.startsWith('.') || name.startsWith('%'))
                        ? vscode.CompletionItemKind.Field
                        : vscode.CompletionItemKind.Function,
                    uri: document.uri,
                    range: new vscode.Range(i, startIdx, i, startIdx + name.length),
                });
                continue;
            }

            const macroMatch = line.match(MACRO_RE);
            if (macroMatch) {
                const name = macroMatch[1];
                const startIdx = line.indexOf(name);
                symbols.push({
                    name,
                    description: extractComment(lines, i),
                    kind: vscode.CompletionItemKind.Snippet,
                    uri: document.uri,
                    range: new vscode.Range(i, startIdx, i, startIdx + name.length),
                    macroParams: macroMatch[2],
                });
                continue;
            }

            const defineMatch = line.match(DEFINE_RE);
            if (defineMatch) {
                const name = defineMatch[1];
                const args = defineMatch[2] || '';
                const startIdx = line.indexOf(name);
                let description = extractComment(lines, i);
                if (args) {
                    description = description ? `${description}  \n${name}${args}` : `${name}${args}`;
                }
                // Only plain %define/%assign (no args) carry an evaluable value.
                const isPlainDefine = /^\s*%(?:i?x?define|i?assign)\b/i.test(line);
                const value = !args && isPlainDefine ? stripComment(defineMatch[3] || '').trim() : '';
                symbols.push({
                    name,
                    description,
                    kind: vscode.CompletionItemKind.Constant,
                    uri: document.uri,
                    range: new vscode.Range(i, startIdx, i, startIdx + name.length),
                    constValue: value || undefined,
                });
                continue;
            }

            const equMatch = line.match(EQU_RE);
            if (equMatch && !PREFIX_RE.test(equMatch[1]) && !DYN_KEYWORDS_RE.test(equMatch[1])) {
                const name = equMatch[1];
                const startIdx = line.indexOf(name);
                symbols.push({
                    name,
                    description: extractComment(lines, i),
                    kind: vscode.CompletionItemKind.Constant,
                    uri: document.uri,
                    range: new vscode.Range(i, startIdx, i, startIdx + name.length),
                    constValue: stripComment(equMatch[2]).trim() || undefined,
                });
                continue;
            }

            const dataMatch = line.match(DATA_LABEL_RE);
            if (dataMatch && !PREFIX_RE.test(dataMatch[1]) && !DYN_KEYWORDS_RE.test(dataMatch[1])) {
                const name = dataMatch[1];
                const startIdx = line.indexOf(name);
                symbols.push({
                    name,
                    description: extractComment(lines, i),
                    kind: vscode.CompletionItemKind.Variable,
                    uri: document.uri,
                    range: new vscode.Range(i, startIdx, i, startIdx + name.length),
                });
            }
        }
        return symbols;
    }
}

function stripComment(s: string): string {
    const idx = maskStrings(s).indexOf(';');
    return idx === -1 ? s : s.substring(0, idx);
}

export function extractComment(lines: string[], index: number): string {
    const preceding: string[] = [];
    let p = index - 1;
    while (p >= 0) {
        const line = lines[p].trim();
        if (line.startsWith(';')) { preceding.unshift(line.substring(1).trim()); p--; }
        else if (line === '') p--;
        else break;
    }
    const line = lines[index];
    const commentIdx = maskStrings(line).indexOf(';');
    const sameLine = commentIdx === -1 ? [] : [line.substring(commentIdx + 1).trim()];
    return [...preceding, ...sameLine].join('  \n').trim();
}

const DYN_KEYWORDS_RE =
    /^(SECTION|SEGMENT|ABSOLUTE|EXTERN|GLOBAL|COMMON|CPU|BITS|USE16|USE32|USE64|DEFAULT|STRICT|EQU|TIMES|ALIGN|STRUC|ENDSTRUC|ISTRUC|AT|IEND|INCBIN|DB|DW|DD|DQ|DT|DO|DY|DZ|RESB|RESW|RESD|RESQ|REST|RESO|RESY|RESZ|BYTE|WORD|DWORD|QWORD|TWORD|OWORD|YWORD|ZWORD|PTR|SHORT|NEAR|FAR|REL|ABS)$/i;

const NUM_RE = /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|\b[0-9][0-9a-fA-F]*h|0b[01]+|\b[01]+[by]|\b\d+[dt]?\b/g;
const ID_RE  = /(?:%%|%\?|%\*|%\$|%#|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*/g;
const PREFIX_RE = /^(lock|rep|repe|repz|repne|repnz|bnd|xacquire|xrelease)$/i;

export function discoverUndefinedSymbolsInDocument(
    document: vscode.TextDocument,
    seenNames: Set<string>,
    kb: KnowledgeBase
): { name: string; kind: vscode.CompletionItemKind }[] {
    const symbols: { name: string; kind: vscode.CompletionItemKind }[] = [];
    const localSeen = new Set<string>();
    const lines = document.getText().split(/\r?\n/);

    for (const line of lines) {
        const commentIdx = maskStrings(line).indexOf(';');
        let codePart = commentIdx === -1 ? line : line.substring(0, commentIdx);
        codePart = maskStrings(codePart);

        const numberPositions = new Set<number>();
        const numRe = new RegExp(NUM_RE.source, 'g');
        let numMatch: RegExpExecArray | null;
        while ((numMatch = numRe.exec(codePart)) !== null) {
            for (let n = 0; n < numMatch[0].length; n++) numberPositions.add(numMatch.index + n);
        }

        const idRe = new RegExp(ID_RE.source, 'g');
        let match: RegExpExecArray | null;
        let instructionSlotTaken = false;
        while ((match = idRe.exec(codePart)) !== null) {
            if (numberPositions.has(match.index)) continue;
            const word = match[0];
            const wordLower = word.toLowerCase();
            const remaining = codePart.substring(match.index + word.length).trimStart();
            const isLabelDef = remaining.startsWith(':');
            const isPrefix = PREFIX_RE.test(word);

            if (isLabelDef) continue;
            if (word === '%') {
                if (!instructionSlotTaken && !isPrefix) instructionSlotTaken = true;
                continue;
            }

            const isKnown = seenNames.has(wordLower)
                || localSeen.has(wordLower)
                || kb[wordLower] !== undefined
                || X86_REGISTERS.has(wordLower)
                || /^\d/.test(word)
                || DYN_KEYWORDS_RE.test(word);

            if (isKnown) {
                if (!instructionSlotTaken && !isPrefix) instructionSlotTaken = true;
                continue;
            }

            symbols.push({
                name: word,
                kind: !instructionSlotTaken
                    ? vscode.CompletionItemKind.Snippet
                    : vscode.CompletionItemKind.Variable,
            });
            localSeen.add(wordLower);
            if (!instructionSlotTaken && !isPrefix) instructionSlotTaken = true;
        }
    }
    return symbols;
}
