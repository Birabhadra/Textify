# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Textify is a VS Code extension (`vscode:^1.125.0`) that provides AI-powered **inline completions** using an
`InlineCompletionItemProvider`. Unlike simple ghost-text autocomplete, it is a *replacement-style* completion
engine: the model is asked to output what a "replace region" (the text from the cursor to the end of the
current statement) should become, and the extension diffs old vs. new text to compute a minimal edit — which
may delete existing code (shown with a strikethrough decoration) as well as insert new code.

## Commands

```bash
npm install              # install deps (also fetches tree-sitter grammar packages)
npm run compile          # tsc -p ./  (src/ -> out/)
npm run watch            # tsc -watch -p ./
npm run lint             # eslint src
npm run pretest          # compile + lint (runs automatically before `test`)
npm run test             # vscode-test (runs out/test/**/*.test.js in a real VS Code instance)
```

There is no single-test filter wired up; `vscode-test` runs whatever matches `out/test/**/*.test.js` per
`.vscode-test.mjs`. To run the extension itself, open the project in VS Code and press `F5` to launch an
Extension Development Host.

`scripts/copy-grammar.js` copies `web-tree-sitter.wasm` and the per-language tree-sitter grammar `.wasm` files
from `node_modules` into `grammars/` (which is committed to the repo and loaded at runtime by `ASTService`).
It is **not** wired into any npm script — run it manually (`node scripts/copy-grammar.js`) after
adding/upgrading a `tree-sitter-*` dependency in `package.json`.

## Configuration

All settings live under the `textify.*` namespace (see `package.json` → `contributes.configuration`) and are
read through the `ConfigurationService` singleton (`src/services/configurationService.ts`), which caches
`vscode.workspace.getConfiguration('textify')` and live-reloads on `onDidChangeConfiguration`, notifying
registered listeners (used by `LspService` and `CompletionCache` to resize their bounded caches when
`lspCacheMaxEntries` / `completionCacheMaxEntries` change).

An API key must be set for one of three OpenAI-compatible providers — `openrouterApiKey`, `groqApiKey`, or
`fireworksApiKey`. `ApiClient.getActiveProvider()` picks the first configured key in that priority order
(openrouter > groq > fireworks); there is no explicit provider-selection setting.

## Completion pipeline architecture

Entry point `src/extension.ts` creates one shared `ASTService` (tree-sitter) and one `InlineCompletionProvider`,
registered as a wildcard (`{ pattern: '**' }`) inline completion provider. It also registers
`textify.acceptCompletion` (bound to `Tab`) and `textify.rejectCompletion` (bound to `Escape`) — these
keybindings apply whenever `editorTextFocus` is true, globally overriding default Tab/Escape behavior; accept
falls back to executing VS Code's built-in `tab` command when there's no pending Textify edit.

`InlineCompletionProvider.provideInlineCompletionItems` (`src/providers/inlineCompletionProvider.ts`) is the
orchestrator, in order:

1. **Existing pending completion** — if the cursor is still at the position of an already-offered edit,
   re-serve it without any new work.
2. **Continue prediction** — if the user has kept typing text that matches the previously offered suggestion
   character-by-character, stream the remaining suffix as ghost text with no model call at all
   (`tryContinuePrediction`, keyed off `lastCompletionText`/`lastCompletionPosition`).
3. **Completion cache** — `CompletionCache` (`src/cache/completionCache.ts`) keyed on document URI + a content
   hash of the whole document + cursor position + a hash of recent edit history (from `IntentTracker`); TTL and
   max-size configurable, invalidated per-document on close.
4. **Context gathering** (`ContextGatherer.gatherContext`, see below) → **prompt building**
   (`PromptBuilder.buildPrompt`) → **streamed API call** (`ApiClient.complete`) → text cleanup (strips code
   fences / trailing "explanation" comments).
5. **Deduplication** (`DeduplicationService.check`) — trims any leading lines of the completion that just
   repeat code already above the cursor, and rejects completions that would duplicate code already below the
   cursor (structural overlap via Levenshtein-based similarity, or exact trailing overlap).
6. **Minimal diff** — `computeMinimalReplacement` does a common-prefix/common-suffix diff between the old text
   of the replace region and the new model output, producing a `ReplacementEdit { deleteRange, insertText,
   deletedText }`. This — not the raw model output — is what gets cached and shown.
7. **Activation** — shows the insert text as inline ghost text at `deleteRange`, and if any old text is being
   deleted, shows it struck through via `DeletionDecoration` (`src/ui/deletionDecoration.ts`).

Accepting (`Tab`) applies the `ReplacementEdit` with `editor.edit(...).replace(...)` and records the acceptance
in `IntentTracker`; rejecting (`Escape`) just records the rejection (VS Code's normal Escape behavior handles
dismissing the ghost text itself).

### Context gathering (`src/services/contextGatherer.ts` + `src/services/contextStages/`)

Four independent stages feed into a single `CompletionContext`:

- **`ReplacementRegionStage`** — starts as the rest of the current line after the cursor. If that text looks
  syntactically incomplete (unbalanced brackets, or ends with a continuation operator like `,`, `&&`, `.`), it
  extends the region using tree-sitter (`ASTService.withParsedTree` + `findStatementEnd` in
  `src/services/astAnalysis.ts`) up to the end of the enclosing statement, bounded to 3 extra lines / 200 chars.
- **`PrefixStage`** — builds the code *before* the cursor that's sent to the model:
  - If the cursor is within the first 150 lines of the file, it just uses the verbatim text from line 0.
  - Otherwise it uses LSP document symbols (via `LspService`, itself cached) to find the enclosing
    function/class, and builds a *scoped* prefix: class header line(s) + function body up to the cursor, plus
    only the import statements whose bound local names are actually referenced in that scope (via
    `src/utils/importAnalysis.ts` + `extractIdentifiers`), plus "same-file dependencies" — other top-level
    symbols referenced by identifiers in scope, and the superclass/interface (resolved via
    `LspService.getSuperTypeNames` / VS Code's type hierarchy provider) — gathered by
    `LocalDependencyResolver`.
  - For very large functions (cursor >150 lines from the function start), only the first 30 lines (setup) plus
    the last 100 lines near the cursor are kept, joined with a language-appropriate truncation-marker comment
    for the skipped middle.
- **`SuffixStage`** — a handful of lines *after* the replace region, but only trivial "closing punctuation"
  lines (e.g. closing braces/brackets); stops as soon as it hits a line with real code.
- **`CrossFileService`** (`src/services/crossFile/`) — surfaces relevant symbols from *other* open/saved files:
  - `SymbolIndex` incrementally indexes every opened/saved file's document symbols via LSP, cached per document
    version in a `BoundedCache`.
  - `ReferenceExtractor` scans the last ~15 lines of the built prefix for identifiers that aren't already
    declared locally (via tree-sitter `extractDeclaredNames`), resolving any import aliases back to their
    original names.
  - `CrossFileService.getRelevantSymbols` intersects those referenced names against the global symbol index
    (excluding the current file, and excluding methods/constructors), and `SignatureProvider` strips each
    matched symbol down to a body-less signature using tree-sitter (`extractSignatureFromAST`), cached per
    symbol.

`PromptBuilder` (`src/services/promptBuilder.ts`) assembles all of the above into an XML-tagged prompt
(`<file>` → `<types>`, `<recent_edits>`, `<prefix>` with an inline `<cursor />` marker, `<replace_region>`,
`<suffix>`) with a fixed system prompt instructing the model to output *only* the raw replacement text for
`<replace_region>`. It fits everything to a rough character/4-per-token budget split across sections (current
file ~6000 tokens, imported signatures ~3000, edit history ~1500), trimming prefix/suffix proportionally if the
current-file budget is exceeded.

### Supporting services

- **`ASTService`** (`src/services/astService.ts`) — thin wrapper around `web-tree-sitter`. Loads grammar
  `.wasm` files lazily per `languageId` from `grammars/` (see `LANGUAGE_MAP`), caches loaded `Language`
  objects, and reuses a single `Parser` instance across languages via `setLanguage`. `astAnalysis.ts` contains
  the actual tree-walking logic (statement-end detection, declared-name extraction, signature extraction) and
  is VS Code-agnostic — symbol kinds are matched against hardcoded numeric `SymbolKind` constants rather than
  importing `vscode`.
- **`IntentTracker`** (`src/services/intentTracker.ts`) — passively observes `onDidChangeTextDocument` and
  buffers a rolling history of recent edits (classified as `added` / `pasted` / `edited`, plus explicit
  `accepted` / `rejected` entries recorded from the Tab/Escape commands), merging nearby/overlapping edits
  within a short time window. Serializes the last 35 entries as `<recent_edits>` in the prompt, and its hash is
  part of the completion cache key — so cache entries go stale as soon as the recent-edit context changes.
- **`BoundedCache<V>`** (`src/cache/boundedCache.ts`) — generic size-bounded cache (evicts by a
  recency/frequency score) with optional per-entry TTL and `groupKey`-based bulk invalidation (e.g. invalidate
  every cache entry for a document URI when it changes or closes). Backs `CompletionCache`, `LspService`,
  `SymbolIndex`, and `SignatureProvider`.
- **`languageUtils.ts` / `importAnalysis.ts`** (`src/utils/`) — pure string/regex-based, per-language (JS/TS,
  Python, Rust, Go, Java, C/C++) helpers for keyword lists, a hand-rolled identifier scanner, import-statement
  span detection, and import alias-binding parsing. These are intentionally independent of tree-sitter/LSP so
  they can run cheaply without a parsed tree.

### Note on the README

`README.md` documents the intended architecture and project structure at a high level (including mermaid
diagrams) and is exercised directly by `src/test/extension.test.ts`, which asserts on the presence of specific
README/CHANGELOG/quickstart sections — keep those section headers in sync if editing those docs. Its listed
`src/crossFile/` path is out of date; cross-file code actually lives under `src/services/crossFile/`.
