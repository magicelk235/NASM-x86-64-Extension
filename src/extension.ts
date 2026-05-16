import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface KnowledgeBase {
    [key: string]: string;
}

interface SymbolInfo {
    name: string;
    description: string;
    kind: vscode.CompletionItemKind;
    range: vscode.Range;
    uri: vscode.Uri;
}

class SymbolManager {
    private cache = new Map<string, { version: number, symbols: SymbolInfo[] }>();

    public updateCache(document: vscode.TextDocument) {
        if (document.languageId === 'nasm') {
            this.cache.set(document.uri.toString(), {
                version: document.version,
                symbols: this.parseDocumentSymbols(document)
            });
        }
    }

    public getSymbols(uri?: vscode.Uri): SymbolInfo[] {
        if (uri) {
            const cached = this.cache.get(uri.toString());
            return cached ? cached.symbols : [];
        }
        const all: SymbolInfo[] = [];
        for (const entry of this.cache.values()) {
            all.push(...entry.symbols);
        }
        return all;
    }

    private parseDocumentSymbols(document: vscode.TextDocument): SymbolInfo[] {
        const symbols: SymbolInfo[] = [];
        const lines = document.getText().split(/\r?\n/);
        const idRegex = /(?:%%|%\?|%\*|%\$|%#|\.[a-zA-Z_?]|[a-zA-Z_?])[a-zA-Z0-9_$#@~.?]*/;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const labelMatch = line.match(new RegExp(`^\\s*(${idRegex.source}):`));
            if (labelMatch) {
                const name = labelMatch[1];
                const startIdx = line.indexOf(name);
                symbols.push({
                    name,
                    description: extractComment(lines, i),
                    kind: (name.startsWith('.') || name.startsWith('%')) ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Function,
                    uri: document.uri,
                    range: new vscode.Range(i, startIdx, i, startIdx + name.length)
                });
                continue;
            }
            const macroMatch = line.match(new RegExp(`^\\s*%(?:macro|rmacro|imacro|irmacro)\\s+(${idRegex.source})`, 'i'));
            if (macroMatch) {
                const name = macroMatch[1];
                const startIdx = line.indexOf(name);
                symbols.push({
                    name,
                    description: extractComment(lines, i),
                    kind: vscode.CompletionItemKind.Snippet,
                    uri: document.uri,
                    range: new vscode.Range(i, startIdx, i, startIdx + name.length)
                });
                continue;
            }
            const defineMatch = line.match(new RegExp(`^\\s*%(?:i?x?define|i?def(?:str|tok)|i?assign|strlen|substr)\\s+(${idRegex.source})(\\([^)]*\\))?`, 'i'));
            if (defineMatch) {
                const name = defineMatch[1];
                const args = defineMatch[2] || '';
                const startIdx = line.indexOf(name);
                let description = extractComment(lines, i);
                if (args) {
                    description = description ? `${description}  \n${name}${args}` : `${name}${args}`;
                }
                symbols.push({
                    name,
                    description,
                    kind: vscode.CompletionItemKind.Constant,
                    uri: document.uri,
                    range: new vscode.Range(i, startIdx, i, startIdx + name.length)
                });
            }
        }
        return symbols;
    }

    public clear(uri: vscode.Uri) {
        this.cache.delete(uri.toString());
    }
}

const tokenTypes = ['keyword', 'operator', 'parameter', 'function', 'variable', 'string', 'comment'];
const tokenModifiers: string[] = [];
const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

const registers = new Set([
    'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
    'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d',
    'ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w',
    'al', 'bl', 'cl', 'dl', 'sil', 'dil', 'bpl', 'spl', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b',
    'ah', 'bh', 'ch', 'dh', 'cs', 'ds', 'es', 'fs', 'gs', 'ss',
    'cr0', 'cr2', 'cr3', 'cr4', 'cr8', 'dr0', 'dr1', 'dr2', 'dr3', 'dr6', 'dr7'
]);
for (let i = 0; i < 32; i++) {
    registers.add(`xmm${i}`);
    registers.add(`ymm${i}`);
    registers.add(`zmm${i}`);
}

export function activate(context: vscode.ExtensionContext) {
    let kb: KnowledgeBase = {};
    const kbPath = path.join(context.extensionPath, 'kb.json');
    if (fs.existsSync(kbPath)) {
        try {
            kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
        } catch (e) {
            console.error('Failed to load KB:', e);
        }
    }

    const symbolManager = new SymbolManager();
    vscode.workspace.textDocuments.forEach(doc => symbolManager.updateCache(doc));

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => symbolManager.updateCache(doc)),
        vscode.workspace.onDidChangeTextDocument(e => symbolManager.updateCache(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => symbolManager.clear(doc.uri))
    );

    const completionProvider = vscode.languages.registerCompletionItemProvider('nasm', {
        provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
            const itemsMap = new Map<string, vscode.CompletionItem>();
            const wordRange = document.getWordRangeAtPosition(position, /[%a-zA-Z0-9_$#@~.?]+/);
            const word = wordRange ? document.getText(wordRange) : '';

            for (const key in kb) {
                if (key.startsWith('%') && !word.startsWith('%')) continue;
                
                const item = new vscode.CompletionItem(key, 
                    key.startsWith('%') ? vscode.CompletionItemKind.Keyword : 
                    registers.has(key.toLowerCase()) ? vscode.CompletionItemKind.Variable : 
                    vscode.CompletionItemKind.Function);
                item.documentation = new vscode.MarkdownString(kb[key]);
                if (wordRange) item.range = wordRange;
                itemsMap.set(key.toLowerCase(), item);
            }

            const allSymbols = symbolManager.getSymbols();
            allSymbols.forEach(sym => {
                const item = new vscode.CompletionItem(sym.name, sym.kind);
                if (sym.description) item.documentation = new vscode.MarkdownString(sym.description);
                if (wordRange) item.range = wordRange;
                itemsMap.set(sym.name.toLowerCase(), item);
            });

            const dynamicSymbols = discoverUndefinedSymbolsInDocument(document, new Set(itemsMap.keys()), kb);
            dynamicSymbols.forEach(sym => {
                const item = new vscode.CompletionItem(sym.name, sym.kind);
                if (wordRange) item.range = wordRange;
                if (!itemsMap.has(sym.name.toLowerCase())) {
                    itemsMap.set(sym.name.toLowerCase(), item);
                }
            });

            return Array.from(itemsMap.values());
        }
    }, '%', '.');

    const hoverProvider = vscode.languages.registerHoverProvider('nasm', {
        provideHover(document: vscode.TextDocument, position: vscode.Position) {
            const range = document.getWordRangeAtPosition(position, /(?:0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9][0-9a-fA-F]*h|0b[01]+|[01]+[by]|\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+[dt]?|(?:%%|%\?|%\*|%\$|%#|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*)/i);
            if (!range) return;

            const word = document.getText(range);
            const wordLower = word.toLowerCase();
            
            const allSymbols = symbolManager.getSymbols();
            const dynamicSym = allSymbols.find(s => s.name.toLowerCase() === wordLower);
            if (dynamicSym && dynamicSym.description) return new vscode.Hover(new vscode.MarkdownString(dynamicSym.description));

            const hexRegex = /^(?:0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9][0-9a-fA-F]*h)$/i;
            const binRegex = /^(?:0b[01]+|[01]+[by])$/i;
            const decRegex = /^\d+[dt]?$/i;
            const floatRegex = /^(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/i;

            const isNumeric = hexRegex.test(word) || binRegex.test(word) || decRegex.test(word) || floatRegex.test(word);

            if (kb[wordLower] && !isNumeric) {
                return new vscode.Hover(new vscode.MarkdownString(kb[wordLower]));
            }

            let val: bigint | null = null;
            let type: 'hex' | 'bin' | 'dec' | 'float' | null = null;

            if (hexRegex.test(word)) {
                type = 'hex';
                let s = wordLower;
                if (s.startsWith('0x')) s = s.substring(2);
                else if (s.startsWith('$')) s = s.substring(1);
                else if (s.endsWith('h')) s = s.substring(0, s.length - 1);
                try { val = BigInt('0x' + s); } catch (e) { return; }
            } else if (binRegex.test(word)) {
                type = 'bin';
                let s = wordLower;
                if (s.startsWith('0b')) s = s.substring(2);
                else s = s.substring(0, s.length - 1);
                try { val = BigInt('0b' + s); } catch (e) { return; }
            } else if (decRegex.test(word)) {
                type = 'dec';
                let s = wordLower;
                if (s.endsWith('d') || s.endsWith('t')) s = s.substring(0, s.length - 1);
                try { val = BigInt(s); } catch (e) { return; }
            } else if (floatRegex.test(word)) {
                const f = parseFloat(word);
                const arr = new Float64Array(1);
                arr[0] = f;
                const uint64 = new BigUint64Array(arr.buffer);
                const bits = uint64[0];
                
                const hoverText = new vscode.MarkdownString();
                hoverText.appendMarkdown(`Hex: \`0x${bits.toString(16).toUpperCase().padStart(16, '0')}\`  \n`);
                const b = bits.toString(2).padStart(64, '0');
                const formattedBin = b.match(/.{1,8}/g)?.join(' ') || b;
                hoverText.appendMarkdown(`Bin: \`${formattedBin}\``);
                return new vscode.Hover(hoverText);
            }

            if (val !== null && type !== null) {
                const hoverText = new vscode.MarkdownString();
                if (type !== 'dec') hoverText.appendMarkdown(`Dec: \`${val.toString(10)}\`  \n`);
                if (type !== 'hex') hoverText.appendMarkdown(`Hex: \`0x${val.toString(16).toUpperCase()}\`  \n`);
                if (type !== 'bin') {
                    let b = val.toString(2);
                    const paddedLen = Math.max(8, Math.ceil(b.length / 8) * 8);
                    b = b.padStart(paddedLen, '0');
                    const formattedBin = b.match(/.{1,8}/g)?.join(' ') || b;
                    hoverText.appendMarkdown(`Bin: \`${formattedBin}\``);
                }
                return new vscode.Hover(hoverText);
            }

            return;
        }
    });

    const definitionProvider = vscode.languages.registerDefinitionProvider('nasm', {
        provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
            const range = document.getWordRangeAtPosition(position, /(?:%%|%\?|%\*|%\$|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*/);
            if (!range) return;
            const word = document.getText(range).toLowerCase();
            const sym = symbolManager.getSymbols().find(s => s.name.toLowerCase() === word);
            if (sym) return new vscode.Location(sym.uri, sym.range);
            return;
        }
    });

    const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider('nasm', {
        provideDocumentSymbols(document: vscode.TextDocument) {
            return symbolManager.getSymbols(document.uri).map(sym => {
                return new vscode.DocumentSymbol(
                    sym.name,
                    '',
                    sym.kind === vscode.CompletionItemKind.Snippet ? vscode.SymbolKind.Function :
                    sym.kind === vscode.CompletionItemKind.Constant ? vscode.SymbolKind.Constant :
                    sym.kind === vscode.CompletionItemKind.Function ? vscode.SymbolKind.Function :
                    vscode.SymbolKind.Variable,
                    sym.range,
                    sym.range
                );
            });
        }
    });

    const semanticTokensProvider = vscode.languages.registerDocumentSemanticTokensProvider('nasm', {
        provideDocumentSemanticTokens(document: vscode.TextDocument) {
            const builder = new vscode.SemanticTokensBuilder(legend);
            const lines = document.getText().split(/\r?\n/);
            const allSymbols = symbolManager.getSymbols();
            const macroNames = new Set(allSymbols.filter(s => s.kind === vscode.CompletionItemKind.Snippet || s.kind === vscode.CompletionItemKind.Constant).map(s => s.name.toLowerCase()));
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) continue;

                const lineTokens: { start: number, length: number, type: string }[] = [];
                
                const stringRegex = /(["'`])(?:\\.|(?!\1).)*\1/g;
                const maskedForComment = line.replace(stringRegex, (match) => ' '.repeat(match.length));
                const commentIdx = maskedForComment.indexOf(';');

                if (commentIdx !== -1) {
                    lineTokens.push({ start: commentIdx, length: line.length - commentIdx, type: 'comment' });
                }

                const codeLimit = commentIdx === -1 ? line.length : commentIdx;
                const codePartOriginal = line.substring(0, codeLimit);
                
                let strMatch;
                const stringRegexForExec = /(["'`])(?:\\.|(?!\1).)*\1/g;
                while ((strMatch = stringRegexForExec.exec(codePartOriginal)) !== null) {
                    lineTokens.push({ start: strMatch.index, length: strMatch[0].length, type: 'string' });
                }

                const codePartMasked = codePartOriginal.replace(stringRegex, (match) => ' '.repeat(match.length));

                const numberRegex = /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|\b[0-9][0-9a-fA-F]*h|0b[01]+|\b[01]+[by]|\b\d+[dt]?\b/g;
                const idRegex = /(?:%%|%\?|%\*|%\$|%#|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*/g;
                const punctRegex = /[\[\]\(\),]/g;

                const numberPositions = new Set<number>();
                let numMatch;
                while ((numMatch = numberRegex.exec(codePartMasked)) !== null) {
                    for (let n = 0; n < numMatch[0].length; n++) numberPositions.add(numMatch.index + n);
                }

                let punctMatch;
                while ((punctMatch = punctRegex.exec(codePartMasked)) !== null) {
                    lineTokens.push({ start: punctMatch.index, length: 1, type: 'operator' });
                }

                let idMatch;
                let instructionSlotTaken = false;
                let defineNamePending = false;
                while ((idMatch = idRegex.exec(codePartMasked)) !== null) {
                    if (numberPositions.has(idMatch.index)) continue;

                    const word = idMatch[0];
                    const wordLower = word.toLowerCase();
                    const isPrefix = /^(lock|rep|repe|repz|repne|repnz|bnd|xacquire|xrelease)$/i.test(word);
                    const isDefineDirective = /^%(?:i?x?define|i?def(?:str|tok)|i?assign|macro|[ri]?macro|strlen|substr)$/i.test(word);
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

                    if (registers.has(wordLower)) {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'parameter' });
                        if (!instructionSlotTaken) instructionSlotTaken = true;
                    } else if (macroNames.has(wordLower)) {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'keyword' });
                        if (!instructionSlotTaken) instructionSlotTaken = true;
                    } else if (!instructionSlotTaken) {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'keyword' });
                        if (!isPrefix) instructionSlotTaken = true;
                        if (isDefineDirective) defineNamePending = true;
                    } else {
                        lineTokens.push({ start: idMatch.index, length: word.length, type: 'variable' });
                    }
                }

                lineTokens.sort((a, b) => a.start - b.start);
                lineTokens.forEach(t => {
                    builder.push(new vscode.Range(i, t.start, i, t.start + t.length), t.type);
                });
            }
            return builder.build();
        }
    }, legend);

    context.subscriptions.push(completionProvider, hoverProvider, definitionProvider, documentSymbolProvider, semanticTokensProvider);
}

function discoverUndefinedSymbolsInDocument(document: vscode.TextDocument, seenNames: Set<string>, kb: KnowledgeBase): { name: string, kind: vscode.CompletionItemKind }[] {
    const symbols: { name: string, kind: vscode.CompletionItemKind }[] = [];
    const localSeen = new Set<string>();
    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const stringRegex = /(["'`])(?:\\.|(?!\1).)*\1/g;

    for (const line of lines) {
        const commentIdx = line.replace(stringRegex, (match) => ' '.repeat(match.length)).indexOf(';');
        let codePart = commentIdx === -1 ? line : line.substring(0, commentIdx);
        codePart = codePart.replace(stringRegex, (match) => ' '.repeat(match.length));
        
        const numberRegex = /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|\b[0-9][0-9a-fA-F]*h|0b[01]+|\b[01]+[by]|\b\d+[dt]?\b/g;
        const idRegex = /(?:%%|%\?|%\*|%\$|%#|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*/g;

        const numberPositions = new Set<number>();
        let numMatch;
        while ((numMatch = numberRegex.exec(codePart)) !== null) {
            for (let n = 0; n < numMatch[0].length; n++) numberPositions.add(numMatch.index + n);
        }
        let match;
        let instructionSlotTaken = false;
        while ((match = idRegex.exec(codePart)) !== null) {
            if (numberPositions.has(match.index)) continue;
            const word = match[0];
            const wordLower = word.toLowerCase();
            const remaining = codePart.substring(match.index + word.length).trimStart();
            const isLabelDef = remaining.startsWith(':');
            const isPrefix = /^(lock|rep|repe|repz|repne|repnz|bnd|xacquire|xrelease)$/i.test(word);

            if (isLabelDef) {
                continue;
            }

            if (word === '%') {
                if (!instructionSlotTaken && !isPrefix) instructionSlotTaken = true;
                continue;
            }

            if (seenNames.has(wordLower) || localSeen.has(wordLower) || kb[wordLower] || registers.has(wordLower) || /^\d/.test(word) || /^(SECTION|SEGMENT|ABSOLUTE|EXTERN|GLOBAL|COMMON|CPU|BITS|USE16|USE32|USE64|DEFAULT|STRICT|EQU|TIMES|ALIGN|STRUC|ENDSTRUC|ISTRUC|AT|IEND|INCBIN|DB|DW|DD|DQ|DT|DO|DY|DZ|RESB|RESW|RESD|RESQ|REST|RESO|RESY|RESZ|BYTE|WORD|DWORD|QWORD|TWORD|OWORD|YWORD|ZWORD|PTR|SHORT|NEAR|FAR|REL|ABS)$/i.test(word)) {
                if (!instructionSlotTaken && !isPrefix) {
                    instructionSlotTaken = true;
                }
                continue;
            }

            symbols.push({
                name: word,
                kind: !instructionSlotTaken ? vscode.CompletionItemKind.Snippet : vscode.CompletionItemKind.Variable
            });
            localSeen.add(wordLower);

            if (!instructionSlotTaken && !isPrefix) {
                instructionSlotTaken = true;
            }
        }
    }
    return symbols;
}

function extractComment(lines: string[], index: number): string {
    const preceding: string[] = [];
    let p = index - 1;
    while (p >= 0) {
        const line = lines[p].trim();
        if (line.startsWith(';')) { preceding.unshift(line.substring(1).trim()); p--; }
        else if (line === '') p--;
        else break;
    }
    const sameLine: string[] = [];
    const line = lines[index];
    const stringRegex = /(["'`])(?:\\.|(?!\1).)*\1/g;
    const commentIdx = line.replace(stringRegex, (match) => ' '.repeat(match.length)).indexOf(';');
    if (commentIdx !== -1) {
        sameLine.push(line.substring(commentIdx + 1).trim());
    }
    return [...preceding, ...sameLine].join('  \n').trim();
}
