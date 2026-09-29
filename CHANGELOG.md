# Changelog

All notable changes to the Textify VS Code extension are documented in this file.

---

## [0.0.5] - Unreleased

### Added

- Claude (Anthropic) provider via the official `@anthropic-ai/sdk`, with per-model request tuning and prompt caching of the system prompt
- Custom providers: add any OpenAI-compatible or Anthropic-compatible endpoint from the settings panel, with URL normalization and a Test connection button
- API key dropdown in the settings panel covering builtin and custom providers
- Custom instructions: global, per-language, and workspace `.textify/instructions.md`, in `append` or `replace` mode (output-format rules always kept)
- `textify.temperature`, `textify.debounceMs`, `textify.debugLogging` settings
- Latency instrumentation, rolling p50/p90 in the panel, `Textify: Measure Completion Latency` command, and `scripts/benchmark-latency.js`
- Local server provider format (Ollama, LM Studio, llama.cpp, vLLM): keyless, with model auto-detection
- Upload a file into the custom instructions box (append or replace)
- Usage metrics in the Claude Code `/cost` style: provider-reported tokens incl. cache read/write, cost, API/wall time, acceptance rate, lines changed; session and all-time, in the status bar, panel, and `Textify: Show Usage`
- Cost for every provider: provider-reported cost, your per-provider/per-model prices (editable in the panel), Claude list prices, $0 for local servers, and OpenRouter's public price catalog matched by model name; costs are recomputed when prices change

### Changed

- Lower completion latency: connection pre-warming when typing resumes, keystroke debounce, streams drained to EOF so sockets stay pooled, full-prompt logging only when `debugLogging` is on
- Completion cache key now includes the instructions, provider, and model

### Fixed

- `textify.completionCacheMaxEntries` was registered as `CompletionCacheMaxEntries`, so the panel could not save it
- Inline completion provider is now disposed on deactivate

---

## [0.0.1] - 2026-09-02

### Added

- Initial release of the Textify extension
- Inline AI completion provider for VS Code
- Replacement-aware edit support for code regions
- Context gathering for prefix, suffix, and statement boundaries
- Cross-file symbol and import awareness
- Completion caching and deduplication pipeline
- Built-in support for OpenRouter, Groq, and Fireworks providers
- Tree-sitter-based language parsing for multiple editor languages
- VS Code settings for provider keys and generation limits

---

## [Unreleased]

### Planned

- Rate limiting and usage visibility
- More advanced inline completion optimization and context scoring
- Additional language coverage and editing heuristics