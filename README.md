# Textify

![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)
![VS Code](https://img.shields.io/badge/vscode-%5E1.125.0-brightgreen.svg)
![Status](https://img.shields.io/badge/status-Active-success.svg)

AI-powered VS Code extension that provides inline code completions with replacement support.

Unlike simple insert-at-cursor completion, Textify can replace existing code by using context from the current file, cross-file symbols, and recent edit history.

## Overview

Textify is built for high-quality, low-friction coding assistance directly in the editor.
It streams completions as ghost text and supports replacement-style edits, so it can:

- fix typos
- complete partial expressions
- rewrite statements with minimal diffs

## How It Works

1. As you type, Textify gathers context: prefix code, replacement region, suffix, cross-file signatures, and recent edits.
2. The context is sent to an LLM (OpenRouter, Groq, or Fireworks) using a structured prompt and token budget.
3. The response is deduplicated, diffed, and shown as ghost text. Any to-be-removed code can be decorated with red strikethrough.
4. Press Tab to accept or Escape to reject.

## Features

- AI-Powered Completions: Streaming LLM responses with automatic provider selection.
- Replacement-Style Edits: Suggestions can replace existing code, not only insert.
- Tree-Sitter AST Analysis: WASM parsing for statement boundaries and signature extraction.
- Cross-File Context: Workspace symbol indexing, import alias resolution, external signature capture.
- Smart Prefix Construction: Scoped prefix for large files (imports, local dependencies, class/function context).
- Edit History Tracking: Tracks recent adds/edits/pastes/accepts/rejects to preserve user intent.
- Deduplication: Multi-strategy dedup to avoid repeating existing content.
- Completion Caching: Fast cache hit path for repeated triggers at the same location.
- Deletion Decoration: Strikethrough styling for code that will be removed by replacement.
- Continuation Prediction: If typed text matches a prior completion prefix, remaining text is reused without a new API call.
- Multi-Language Import Parsing: Language-aware import extraction and filtering.
- Token Budget Management: Prompt sections are budgeted to stay within model limits.

## Supported Languages

TypeScript, TSX, JavaScript, Python, Rust, Go, Java, C, C++

## Extension Settings

### Core Settings (Current)

| Setting | Default | Description |
|---|---|---|
| `textify.openrouterApiKey` | `""` | OpenRouter API key |
| `textify.groqApiKey` | `""` | Groq API key |
| `textify.fireworksApiKey` | `""` | Fireworks API key |
| `textify.model` | `"qwen/qwen3-32b"` | Model used for completions |
| `textify.maxTokens` | `500` | Maximum tokens to generate |

### Advanced Settings (Planned)

| Setting | Default | Description |
|---|---|---|
| `textify.completionCacheMaxEntries` | `100` | Max completion cache entries |
| `textify.completionCacheTtlMs` | `30000` | Completion cache TTL in milliseconds |
| `textify.lspCacheMaxEntries` | `100` | Max LSP cache entries |

Example settings:

```json
{
	"textify.openrouterApiKey": "YOUR_OPENROUTER_KEY",
	"textify.model": "qwen/qwen3-32b",
	"textify.maxTokens": 500
}
```

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Open the project in VS Code and press F5 to launch the Extension Development Host.
3. Add at least one API key in VS Code settings (for example `textify.openrouterApiKey`).
4. Start typing in a supported language file to see inline completions.

## Keybindings

| Key | Action |
|---|---|
| Tab | Accept current completion (falls back to normal Tab when no completion is pending) |
| Escape | Reject current completion |

## Architecture

Current codebase:

```text
src/
	extension.ts
	api/
		apiClient.ts
	providers/
		inlineCompletionProvider.ts
	services/
		configurationService.ts
		intentTracker.ts
	utils/
		types.ts
	test/
		extension.test.ts
```

Target architecture direction:

```text
src/
	extension.ts
	api/
		apiClient.ts
	cache/
		boundedCache.ts
		completionCache.ts
	providers/
		inlineCompletionProvider.ts
	services/
		astAnalysis.ts
		astService.ts
		configurationService.ts
		contextGatherer.ts
		deduplicationService.ts
		intentTracker.ts
		lspService.ts
		promptBuilder.ts
		contextStages/
			prefixStage.ts
			suffixStage.ts
			replacementRegionStage.ts
			localDependencyResolver.ts
		crossFile/
			crossFileService.ts
			referenceExtractor.ts
			signatureProvider.ts
			symbolIndex.ts
	ui/
		deletionDecoration.ts
	utils/
		types.ts
		importAnalysis.ts
		languageUtils.ts
```

## Development

```bash
npm run compile
npm run watch
npm run lint
npm run test
```

## Known Issues

- `textify.helloWorld` is declared in package metadata but not currently wired in runtime activation.
- Intent tracking exists but is not yet fully integrated into completion prompts.
- Some advanced architecture modules listed above are planned and not yet present in this repository.

## Resources

- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- VS Code Extension API: https://code.visualstudio.com/api

## Contributing

1. Create a feature branch.
2. Make your changes.
3. Run lint and tests.
4. Open a pull request with clear notes and reproduction steps.

