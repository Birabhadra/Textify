# Textify Extension Quickstart

This project is a VS Code extension that provides inline AI code completions with replacement-aware editing. The quickstart below covers the local workflow for running, debugging, and testing the extension.

---

## 1. Install dependencies

```bash
npm install
```

---

## 2. Run the extension

1. Open the workspace in VS Code.
2. Press `F5` to launch a new Extension Development Host window.
3. Open any supported source file.
4. Start typing to trigger inline completions.

You can also run the watch task from the VS Code task runner if you want TypeScript recompilation during development.

---

## 3. Configure provider keys

Set one or more of the following settings in your VS Code `settings.json` file:

```json
{
  "textify.openrouterApiKey": "YOUR_OPENROUTER_KEY",
  "textify.groqApiKey": "YOUR_GROQ_KEY",
  "textify.fireworksApiKey": "YOUR_FIREWORKS_KEY",
  "textify.model": "qwen/qwen3-32b",
  "textify.maxTokens": 500
}
```

The extension chooses an available backend based on the configured provider settings and current completion flow.

---

## 4. Debugging

- Set breakpoints in `src/extension.ts` and other runtime files.
- Use the Debug panel to launch the extension host.
- Watch logs in the Developer Tools / Debug Console while testing completion behavior.

For a more detailed debugging flow, inspect the extension entry points under `src/` and follow the completion lifecycle from provider registration to prompt construction and insertion.

---

## 5. Testing

Run the project checks with:

```bash
npm run compile
npm run lint
npm run test
```

The test runner picks up files matching `**.test.ts`, and the core test entry point lives under `src/test`.

---

## 6. Project layout

```text
src/
├── extension.ts
├── api/
├── cache/
├── providers/
├── services/
├── ui/
├── utils/
├── test/
└── ...
```

The main extension runtime begins in `src/extension.ts`, while completion logic and context gathering are split into the provider and service layers.

---

## 7. Suggested next enhancements

- Add a model selection dropdown in the extension UI
- Add rate-limiting and usage tracking for provider requests
- Provide more visible settings controls in the editor UI
- Add automatic fallback between models when one provider is exhausted
- Investigate more advanced inline rewrite behavior and import insertion flows

---

## 8. Useful links

- [README.md](./README.md)
- [CHANGELOG.md](./CHANGELOG.md)
- [VS Code Extension API docs](https://code.visualstudio.com/api)

---

## Diagram space

The extension architecture can be expanded here with a high-level flow diagram, UI pipeline, or provider selection diagram as the product matures.

```mermaid
flowchart LR
    A[Editor Input] --> B[Textify Provider]
    B --> C[Context Discovery]
    C --> D[Prompt Builder]
    D --> E[AI Model Provider]
    E --> F[Completion Validation]
    F --> G[Inline Suggestion]
```
