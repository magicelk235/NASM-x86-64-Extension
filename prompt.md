**Role:** Act as an expert TypeScript developer specializing in VSCode Extension API and Language Server Protocol (LSP).

**Task:** Create a VSCode extension for the NASM x86-64 assembly language. The extension must provide robust syntax highlighting and intelligent code completion. 

Please generate the necessary files (`package.json`, `syntaxes/nasm.tmLanguage.json`, and `src/extension.ts`) based on the following strict requirements:

**Part 1: Syntax Highlighting (TextMate Grammar)**
Define semantic scopes so they map well to standard VSCode themes, but enforce the following specific color overrides in the `package.json` `contributes.configurationDefaults` via `editor.tokenColorCustomizations`:
*   **Labels:** Assign a distinct custom color. Match both standard labels (`label:`) and local labels (`.local_label:`).
*   **Registers:** Assign a distinct custom color. Match standard x86-64 registers (rax, rsp, etc.) AND all SIMD registers (xmm0-xmm15, ymm0-ymm15, zmm0-zmm31).
*   **Instructions:** Assign a distinct custom color for standard mnemonics.
*   **Strings:** Override the standard string scope to use a specific custom greenish color (e.g., `#A8CE93` or similar).
*   **Built-in Macros & Directives:** Assign a distinct color. Ensure the regex comprehensively captures standard NASM directives starting with `%` (e.g., `%macro`, `%define`, `%if`), as well as Context Stack and NASM 3.x features (e.g., `%push`, `%pop`, `%local`, `%is`, `%isid`, `%substr`).

**Part 2: IntelliSense & Hover Providers (TypeScript)**
Implement `vscode.CompletionItemProvider` and `vscode.HoverProvider` with the following logic:
*   **Static Knowledge Base:** Ingest the provided `@List of x86 instructions - Wikipedia.html` and `@nasmdoc.txt` files (assume I have parsed them into a JSON map of `{ "keyword": "description" }`). Use this map to suggest standard x86-64 instructions and NASM macros with their full descriptions on hover and autocomplete.
*   **Dynamic Document Parsing:** When a user types a new label or defines a custom macro within the active document, dynamically parse the current file. 
*   **Comment Extraction:** If a label or macro definition is preceded or followed by a comment (starting with `;`), extract that comment. Bind the extracted comment text to that specific macro/label as its Markdown documentation, so it appears in the hover widget and completion suggestion when the user types it later in the file.

Ensure the code is modular, well-commented, and handles edge cases like multi-line macros (`%macro` ... `%endmacro`).