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
    uri?: vscode.Uri;
}

const tokenTypes = ['keyword', 'function', 'parameter', 'variable'];
const tokenModifiers = ['declaration', 'definition', 'readonly'];
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

    const completionProvider = vscode.languages.registerCompletionItemProvider('nasm', {
        provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
            const itemsMap = new Map<string, vscode.CompletionItem>();
            const wordRange = document.getWordRangeAtPosition(position, /[%a-zA-Z0-9_$#@~.?]+/);
            
            for (const key in kb) {
                const item = new vscode.CompletionItem(key, 
                    key.startsWith('%') ? vscode.CompletionItemKind.Keyword : 
                    registers.has(key.toLowerCase()) ? vscode.CompletionItemKind.Variable : 
                    vscode.CompletionItemKind.Function);
                item.documentation = new vscode.MarkdownString(kb[key]);
                if (wordRange) item.range = wordRange;
                itemsMap.set(key.toLowerCase(), item);
            }

            const allSymbols = getAllSymbolsFromOpenFiles();
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
            const range = document.getWordRangeAtPosition(position, /(?:0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9][0-9a-fA-F]*h|0b[01]+|[01]+[by]|\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[a-zA-Z_?%.][a-zA-Z0-9_$#@~.?]*)/i);
            if (!range) return;

            const word = document.getText(range);
            const wordLower = word.toLowerCase();
            
            // 1. Symbols/KB check
            const allSymbols = getAllSymbolsFromOpenFiles();
            const dynamicSym = allSymbols.find(s => s.name.toLowerCase() === wordLower);
            if (dynamicSym && dynamicSym.description) return new vscode.Hover(new vscode.MarkdownString(dynamicSym.description));
            if (kb[wordLower]) return new vscode.Hover(new vscode.MarkdownString(kb[wordLower]));
            if (kb['%' + wordLower]) return new vscode.Hover(new vscode.MarkdownString(kb['%' + wordLower]));

            // 2. Number check
            const hexRegex = /^(?:0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|[0-9][0-9a-fA-F]*h)$/i;
            const binRegex = /^(?:0b[01]+|[01]+[by])$/i;
            const decRegex = /^\d+[dt]?$/i;
            const floatRegex = /^(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/i;

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

    const semanticTokensProvider = vscode.languages.registerDocumentSemanticTokensProvider('nasm', {
        provideDocumentSemanticTokens(document: vscode.TextDocument) {
            const builder = new vscode.SemanticTokensBuilder(legend);
            const lines = document.getText().split(/\r?\n/);
            const allSymbols = getAllSymbolsFromOpenFiles();
            const macroNames = new Set(allSymbols.filter(s => s.kind === vscode.CompletionItemKind.Snippet || s.kind === vscode.CompletionItemKind.Constant).map(s => s.name.toLowerCase()));
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const commentIdx = line.indexOf(';');
                let codePart = commentIdx === -1 ? line : line.substring(0, commentIdx);
                codePart = codePart.replace(/(["'`])(?:\\.|[^\1])*?\1/g, (match) => ' '.repeat(match.length));

                const numberRegex = /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|\b[0-9][0-9a-fA-F]*h|0b[01]+|\b[01]+[by]|\b\d+[dt]?\b/g;
                const idRegex = /(?:%%|%\?|%\*|%\$|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*/g;

                const numberPositions = new Set<number>();
                let numMatch;
                while ((numMatch = numberRegex.exec(codePart)) !== null) {
                    for (let n = 0; n < numMatch[0].length; n++) numberPositions.add(numMatch.index + n);
                }

                let idMatch;
                let instructionSlotTaken = false;
                while ((idMatch = idRegex.exec(codePart)) !== null) {
                    if (numberPositions.has(idMatch.index)) continue;

                    const word = idMatch[0];
                    const wordLower = word.toLowerCase();
                    const startPos = new vscode.Position(i, idMatch.index);
                    const range = new vscode.Range(startPos, new vscode.Position(i, idMatch.index + word.length));
                    const remaining = codePart.substring(idMatch.index + word.length).trimStart();
                    const isLabelDef = remaining.startsWith(':');

                    if (registers.has(wordLower)) {
                        builder.push(range, 'parameter');
                        instructionSlotTaken = true;
                    } else if (word.startsWith('%') && !word.startsWith('%%') && !word.startsWith('%$') && !word.startsWith('%?') && !word.startsWith('%*')) {
                        builder.push(range, 'keyword');
                        instructionSlotTaken = true;
                    } else if (isLabelDef) {
                        builder.push(range, 'function');
                    } else if (!instructionSlotTaken) {
                        builder.push(range, 'keyword');
                        instructionSlotTaken = true;
                    } else if (kb[wordLower] || macroNames.has(wordLower)) {
                        builder.push(range, 'keyword');
                    } else {
                        builder.push(range, 'variable');
                    }
                }
            }
            return builder.build();
        }
    }, legend);

    context.subscriptions.push(completionProvider, hoverProvider, semanticTokensProvider);
}

function getAllSymbolsFromOpenFiles(): SymbolInfo[] {
    const allSymbols: SymbolInfo[] = [];
    vscode.workspace.textDocuments.forEach(doc => {
        if (doc.languageId === 'nasm') allSymbols.push(...parseDocumentSymbols(doc));
    });
    return allSymbols;
}

function discoverUndefinedSymbolsInDocument(document: vscode.TextDocument, seenNames: Set<string>, kb: KnowledgeBase): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const localSeen = new Set<string>();
    const text = document.getText();
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
        const commentIdx = line.indexOf(';');
        let codePart = commentIdx === -1 ? line : line.substring(0, commentIdx);
        codePart = codePart.replace(/(["'`])(?:\\.|[^\1])*?\1/g, (match) => ' '.repeat(match.length));
        
        const numberRegex = /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?|0x[0-9a-fA-F]+|\$[0-9a-fA-F]+|\b[0-9][0-9a-fA-F]*h|0b[01]+|\b[01]+[by]|\b\d+[dt]?\b/g;
        const idRegex = /(?:%%|%\?|%\*|%\$|\.[a-zA-Z_?]|[a-zA-Z_?%])[a-zA-Z0-9_$#@~.?]*/g;

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
            if (seenNames.has(wordLower) || localSeen.has(wordLower) || kb[wordLower] || registers.has(wordLower) || /^\d/.test(word)) {
                if (!isLabelDef) instructionSlotTaken = true;
                continue;
            }
            symbols.push({
                name: word,
                description: '',
                kind: (!isLabelDef && !instructionSlotTaken) ? vscode.CompletionItemKind.Snippet : vscode.CompletionItemKind.Variable
            });
            localSeen.add(wordLower);
            if (!isLabelDef) instructionSlotTaken = true;
        }
    }
    return symbols;
}

function parseDocumentSymbols(document: vscode.TextDocument): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const lines = document.getText().split(/\r?\n/);
    const idRegex = /(?:%%|%\?|%\*|%\$|\.[a-zA-Z_?]|[a-zA-Z_?])[a-zA-Z0-9_$#@~.?]*/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const labelMatch = line.match(new RegExp(`^\\s*(${idRegex.source}):`));
        if (labelMatch) {
            const name = labelMatch[1];
            symbols.push({ name, description: extractComment(lines, i), kind: (name.startsWith('.') || name.startsWith('%')) ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Function, uri: document.uri });
            continue;
        }
        const macroMatch = line.match(new RegExp(`^\\s*%(?:macro|rmacro|imacro|irmacro)\\s+(${idRegex.source})`, 'i'));
        if (macroMatch) {
            const name = macroMatch[1];
            symbols.push({ name, description: extractComment(lines, i), kind: vscode.CompletionItemKind.Snippet, uri: document.uri });
            continue;
        }
        const defineMatch = line.match(new RegExp(`^\\s*%(?:i?x?define|i?def(?:str|tok)|strlen|substr)\\s+(${idRegex.source})`, 'i'));
        if (defineMatch) {
            const name = defineMatch[1];
            symbols.push({ name, description: extractComment(lines, i), kind: vscode.CompletionItemKind.Constant, uri: document.uri });
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
    const parts = lines[index].split(';');
    if (parts.length > 1) sameLine.push(parts.slice(1).join(';').trim());
    return [...preceding, ...sameLine].join('  \n').trim();
}
