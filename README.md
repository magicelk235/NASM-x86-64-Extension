# NASM x86-64 Assembly for VSCode

A high-performance, intelligent extension for NASM x86-64 assembly development. Designed for clarity, speed, and accuracy, this extension provides professional-grade syntax highlighting and IntelliSense that actually understands the structure of your code.

## Key Features

### 🧠 Intelligent Semantic Highlighting
Unlike basic extensions that just color words, this uses a semantic engine to distinguish between:
- **Instructions:** Always Purple (`#C586C0`), whether they are standard mnemonics or user-defined macros.
- **Registers:** Consistently Blue (`#569CD6`).
- **Labels & Symbols:** Yellow (`#FFCC00`) for easy visual tracking of program flow.
- **Preprocessor:** Directives like `%macro` and `%define` share the instruction color for a unified "command" feel.

### 🔍 Project-Wide Symbol Discovery
- **Cross-File Support:** Labels and macros defined in any open assembly tab are automatically shared. No more "undefined symbol" errors for code in your other files.
- **Local Label Intelligence:** Full support for NASM local labels (starting with `.`).
- **Dynamic Suggestions:** Real-time completion suggestions for instructions, registers, and your own custom symbols.

### 🔢 Numeric Hover & Conversion
Hover over any number to see instant conversions without opening a calculator:
- **Integers:** View Decimal, Hex, and Binary equivalents (with 8-bit grouping).
- **Float64:** Hover over floating-point numbers to see the exact 64-bit IEEE 754 bit representation in Hex and Binary.
- **NASM Formats:** Supports `0x`, `$`, `h` suffix for Hex; `0b`, `b` suffix for Binary; and standard decimals.

### 📚 Comprehensive Knowledge Base
Includes a distilled dictionary of **684 x86-64 instructions and NASM directives**.
- Hover over any instruction for a concise 1-2 sentence explanation.
- No more tab-switching to Wikipedia or the NASM manual for basic mnemonic lookups.

### 💬 Human-Centric Documentation
- Automatically extracts comments from preceding lines or the same line.
- Displays documentation in a clean, compact format with "soft" newlines for maximum readability.

## Installation

1. Copy the project folder to your extensions directory:
   `~/.vscode/extensions/` (or your platform's equivalent).
2. Restart VSCode.

## Configuration

The extension comes with pre-configured token colors to ensure the assembly aesthetic is preserved regardless of your theme. These can be customized in your `settings.json` under `editor.semanticTokenColorCustomizations`.

## Usage Tips

- **Local Labels:** Type `.` to immediately trigger suggestions for local labels.
- **Preprocessor:** Type `%` to see a full list of NASM preprocessor directives and macros.
- **Multi-File:** Keep related assembly files open in tabs to enable cross-file symbol discovery.

---
**Maintained by magicelk235**
