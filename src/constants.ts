// Shared constants and helpers used across the extension.

export const STRING_REGEX = /(["'`])(?:\\.|(?!\1).)*\1/g;

export const maskStrings = (line: string): string =>
    line.replace(STRING_REGEX, m => ' '.repeat(m.length));

export const DIRECTIVES = new Set<string>([
    'absolute', 'align', 'alignb', 'at', 'bits', 'common', 'cpu',
    'db', 'dd', 'do', 'dq', 'dt', 'dw', 'dy', 'dz',
    'default', 'equ', 'extern', 'global', 'iend', 'incbin', 'istruc',
    'resb', 'resd', 'reso', 'resq', 'rest', 'resw', 'resy', 'resz',
    'section', 'segment', 'strict', 'struc', 'endstruc', 'times',
    'use16', 'use32', 'use64',
]);

export const PREFIXES = new Set<string>([
    'a16', 'a32', 'a64', 'bnd', 'lock', 'o16', 'o32', 'o64',
    'rep', 'repe', 'repne', 'repnz', 'repz', 'xacquire', 'xrelease',
]);

export const DATA_DECL = new Set<string>([
    'db', 'dw', 'dd', 'dq', 'dt', 'do', 'dy', 'dz',
    'resb', 'resw', 'resd', 'resq', 'rest', 'reso', 'resy', 'resz',
]);

export const X86_REGISTERS = new Set<string>([
    // 64-bit GPR
    'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp',
    'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
    // 32-bit GPR
    'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp',
    'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d',
    // 16-bit GPR
    'ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp',
    'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w',
    // 8-bit GPR
    'al', 'ah', 'bl', 'bh', 'cl', 'ch', 'dl', 'dh',
    'sil', 'dil', 'bpl', 'spl',
    'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b',
    // Segment
    'cs', 'ds', 'es', 'fs', 'gs', 'ss',
    // Instruction pointer
    'ip', 'eip', 'rip',
    // Control / debug
    'cr0', 'cr2', 'cr3', 'cr4', 'cr8',
    'dr0', 'dr1', 'dr2', 'dr3', 'dr6', 'dr7',
]);
for (let i = 0; i < 32; i++) {
    X86_REGISTERS.add(`xmm${i}`);
    X86_REGISTERS.add(`ymm${i}`);
    X86_REGISTERS.add(`zmm${i}`);
}
for (let i = 0; i < 8; i++) {
    X86_REGISTERS.add(`mm${i}`);
    X86_REGISTERS.add(`st${i}`);
    X86_REGISTERS.add(`k${i}`);
}

export const PREFIX_REGEX = /^(?:lock|rep|repe|repz|repne|repnz|bnd|xacquire|xrelease)$/i;
export const DEFINE_DIRECTIVE_REGEX =
    /^%(?:i?x?define|i?def(?:str|tok)|i?assign|macro|[ri]?macro|strlen|substr)$/i;
