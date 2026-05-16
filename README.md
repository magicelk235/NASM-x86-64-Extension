# NASM x86-64 for VS Code

Writing assembly shouldn't mean fighting your editor. This extension gives you proper syntax highlighting, hover docs, and autocomplete for NASM x86-64 — the kind of tooling you'd expect for any modern language.

## What You Get

**Colors that make sense.** Instructions are purple, registers are blue, labels are yellow. Macros you define get treated like instructions, not random text. Your code looks consistent whether you're using `mov` or your own `print_string` macro.

**Hover over anything.** Put your cursor on `jne` and see what it does. Hover over `0x1F3A` and get decimal, hex, and binary conversions without opening a calculator. The extension knows 684 x86-64 instructions and NASM directives.

**Cross-file awareness.** Labels and macros from any open assembly tab show up in autocomplete. Define `my_function` in one file, use it in another — the editor knows.

**Local labels work properly.** NASM's `.local_label` syntax is fully supported. Type `.` and see suggestions for labels in the current scope.

## Number Hover Examples

| You write | You see |
|-----------|---------|
| `0xFF` | 255, 0xFF, 0b11111111 |
| `3.14` | IEEE 754 bit representation |
| `100b` | Binary to decimal/hex |

Supports all NASM number formats: `0x`, `$`, `h` suffix, `0b`, `b` suffix, plain decimals.

## Quick Tips

- Type `%` for preprocessor directive suggestions
- Type `.` for local label suggestions  
- Keep related `.asm` files open for cross-file symbol discovery

## Install

**[Get it from the Marketplace](https://marketplace.visualstudio.com/items?itemName=Magicelk235.nasm-x64)** or search "NASM x64" in VS Code extensions.

**Manual:** Copy to `~/.vscode/extensions/` and restart.
