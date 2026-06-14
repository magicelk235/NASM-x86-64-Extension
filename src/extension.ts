import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { parseInsnsDat, parseInstructionSet } from './x86';
import { lazyArm64Bundle } from './arm64';
import { KnowledgeBase, SymbolManager } from './symbols';
import { createUpdateDiagnostics } from './diagnostics';
import { registerAllProviders } from './providers';

function loadKnowledgeBase(extensionPath: string): KnowledgeBase {
    const kbPath = path.join(extensionPath, 'kb.json');
    if (!fs.existsSync(kbPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(kbPath, 'utf8'));
    } catch (e) {
        console.error('Failed to load KB:', e);
        return {};
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const kb = loadKnowledgeBase(context.extensionPath);
    const instructionSet = parseInstructionSet(path.join(context.extensionPath, 'x86_64_instructions.xml'));
    const instructionDb  = parseInsnsDat(path.join(context.extensionPath, 'insns.dat'));
    const arm64          = lazyArm64Bundle(path.join(context.extensionPath, 'aarch64_instructions.json'));

    const diagnosticCollection = vscode.languages.createDiagnosticCollection('nasm');
    context.subscriptions.push(diagnosticCollection);

    // Status bar: shows the target arch for NASM files; click to toggle.
    const archStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    archStatus.command = 'nasm.toggleArchitecture';
    context.subscriptions.push(archStatus);
    const updateArchStatus = () => {
        if (vscode.window.activeTextEditor?.document.languageId === 'nasm') {
            const arch = vscode.workspace.getConfiguration('nasm').get<string>('arch', 'x86-64');
            archStatus.text = `$(chip) ${arch}`;
            archStatus.tooltip = 'NASM target architecture — click to toggle';
            archStatus.show();
        } else {
            archStatus.hide();
        }
    };
    updateArchStatus();

    const symbolManager = new SymbolManager();
    vscode.workspace.textDocuments.forEach(doc => symbolManager.updateCache(doc));

    const updateDiagnostics = createUpdateDiagnostics({
        instructionDb,
        arm64,
        symbolManager,
        diagnosticCollection,
    });

    vscode.workspace.textDocuments.forEach(updateDiagnostics);

    context.subscriptions.push(
        vscode.commands.registerCommand('nasm.toggleArchitecture', async () => {
            const config = vscode.workspace.getConfiguration('nasm');
            const next = config.get<string>('arch', 'x86-64') === 'arm64' ? 'x86-64' : 'arm64';
            const target = vscode.workspace.workspaceFolders
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
            await config.update('arch', next, target);
            vscode.window.setStatusBarMessage(`NASM architecture: ${next}`, 3000);
        }),
        vscode.workspace.onDidOpenTextDocument(doc => {
            symbolManager.updateCache(doc);
            updateDiagnostics(doc);
        }),
        vscode.workspace.onDidChangeTextDocument(e => {
            symbolManager.updateCache(e.document);
            updateDiagnostics(e.document);
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            symbolManager.clear(doc.uri);
            diagnosticCollection.delete(doc.uri);
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('nasm')) {
                vscode.workspace.textDocuments.forEach(updateDiagnostics);
                updateArchStatus();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(updateArchStatus),
        ...registerAllProviders({ instructionSet, arm64, kb, symbolManager }),
    );
}
