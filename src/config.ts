import * as vscode from 'vscode';

export type Arch = 'x86-64' | 'arm64';
export type DiagLevel = 'error' | 'warning' | 'info' | 'off';

export type X86DiagKey =
    | 'memoryToMemory' | 'operandCount' | 'operandType'
    | 'obsolete' | 'undocumented' | 'notInLongMode';
export type X86WarnKey = 'prefixLockXchg' | 'prefixLockError';
export type Arm64DiagKey = 'unknownInstruction' | 'operandCount' | 'operandType' | 'alias';
export type NasmWarnKey =
    | 'dbEmpty' | 'labelOrphan' | 'deprecatedHexPrefix'
    | 'unterminatedString' | 'repNegative' | 'userDirective'
    | 'duplicateLabel' | 'undefinedSymbol';

export function severityFor(level: DiagLevel): vscode.DiagnosticSeverity | null {
    switch (level) {
        case 'error':   return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'info':    return vscode.DiagnosticSeverity.Information;
        case 'off':     return null;
    }
}

export interface NasmSettings {
    arch: Arch;
    diagEnabled: boolean;
    x86_64: Record<X86DiagKey, DiagLevel> & Record<X86WarnKey, DiagLevel>;
    arm64: Record<Arm64DiagKey, DiagLevel>;
    warnings: Record<NasmWarnKey, DiagLevel>;
}

export function readSettings(): NasmSettings {
    const root = vscode.workspace.getConfiguration('nasm');
    const arch = (root.get<string>('arch', 'x86-64') as Arch);
    const diagEnabled = vscode.workspace
        .getConfiguration('nasm.diagnostics')
        .get<boolean>('enabled', true);

    const x86  = vscode.workspace.getConfiguration('nasm.x86_64.diagnostics');
    const x86w = vscode.workspace.getConfiguration('nasm.x86_64.warnings');
    const arm  = vscode.workspace.getConfiguration('nasm.arm64.diagnostics');
    const warn = vscode.workspace.getConfiguration('nasm.warnings');

    const x86Get  = (k: X86DiagKey, def: DiagLevel) => x86.get<DiagLevel>(k) ?? def;
    const x86Wget = (k: X86WarnKey, def: DiagLevel) => x86w.get<DiagLevel>(k) ?? def;
    const armGet  = (k: Arm64DiagKey, def: DiagLevel) => arm.get<DiagLevel>(k) ?? def;
    const wGet    = (k: NasmWarnKey, def: DiagLevel) => warn.get<DiagLevel>(k) ?? def;

    return {
        arch,
        diagEnabled,
        x86_64: {
            memoryToMemory:  x86Get('memoryToMemory', 'error'),
            operandCount:    x86Get('operandCount', 'error'),
            operandType:     x86Get('operandType', 'error'),
            obsolete:        x86Get('obsolete', 'warning'),
            undocumented:    x86Get('undocumented', 'info'),
            notInLongMode:   x86Get('notInLongMode', 'warning'),
            prefixLockXchg:  x86Wget('prefixLockXchg', 'warning'),
            prefixLockError: x86Wget('prefixLockError', 'warning'),
        },
        arm64: {
            unknownInstruction: armGet('unknownInstruction', 'off'),
            operandCount:       armGet('operandCount', 'error'),
            operandType:        armGet('operandType', 'error'),
            alias:              armGet('alias', 'off'),
        },
        warnings: {
            dbEmpty:             wGet('dbEmpty', 'warning'),
            labelOrphan:         wGet('labelOrphan', 'warning'),
            deprecatedHexPrefix: wGet('deprecatedHexPrefix', 'warning'),
            unterminatedString:  wGet('unterminatedString', 'error'),
            repNegative:         wGet('repNegative', 'warning'),
            userDirective:       wGet('userDirective', 'info'),
            duplicateLabel:      wGet('duplicateLabel', 'error'),
            undefinedSymbol:     wGet('undefinedSymbol', 'off'),
        },
    };
}
