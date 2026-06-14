section .text
global _start

_start:
    mov rax, 1
    adc rbx, rcx
    xor eax, eax
    syscall
