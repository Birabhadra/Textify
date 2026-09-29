# Textify — Actual Implementation Order

This is the phased build-out plan for Textify beyond the current inline-completion engine. Phases are meant to
be done roughly in order — later phases depend on infrastructure built in earlier ones (e.g. RAG depends on a
stable completion pipeline; model routing depends on the provider abstraction; LangGraph is deliberately last).

See [CLAUDE.md](CLAUDE.md) for how the current codebase is structured.

**Legend:** ✅ done · 🟡 partly done (what exists is noted) · no mark = not started.

## Progress snapshot (v0.0.5)

v0.0.5 worked ahead on parts of Phases 2, 3 and 10 because they were needed for Claude/custom/local providers,
custom instructions, and usage metrics. **Phase 0 is still open and still gates the larger phases** (RAG, routing,
etc.). Only what's needed to keep those new features working is outside Phase 0.

| Area | Status | What shipped |
| --- | --- | --- |
| Provider abstraction (Phase 2) | ✅ | `providers.ts` + `transports.ts`: OpenRouter, Groq, Fireworks, Gemini, Claude (Anthropic SDK), custom OpenAI/Anthropic-compatible, local servers |
| Settings panel (Phase 3) | 🟡 | API-key dropdown, provider/model, custom providers, instructions, latency, usage, model prices; no RAG/privacy settings yet |
| Custom instructions *(new)* | ✅ | Global, per-language, workspace `.textify/instructions.md`, file upload, append/replace |
| Latency (Phases 10, 12) | 🟡 | Debounce, connection pre-warming, pooled connections, per-stage timings, p50/p90, benchmark command + script |
| Usage & cost (Phases 10, 11) | 🟡 | `/cost`-style metrics: tokens incl. cache, cost for every provider, API/wall time, acceptance rate, lines changed |
| Local models (Phase 15) | 🟡 | Local server format with model detection; no privacy routing or local fallback |
| Tests (Phase 0) | 🟡 | 28 → 100 tests, including end-to-end completions against a local mock provider |

## Phase 0 — Clean and stabilize current code

Do these first. Do not add new features until this is stable.

- 🟡 Fix existing bugs/typos. *(fixed: `completionCacheMaxEntries` setting casing, provider not disposed on deactivate)*
- Fix indentation handling.
- Fix completion acceptance/rejection flow.
- Fix pending completion behavior.
- 🟡 Fix cache invalidation edge cases. *(cache key now includes instructions, provider and model; changing instructions clears the cache)*
- 🟡 Improve existing tests. *(provider, prompt, transport, usage and end-to-end pipeline tests; acceptance/pending flows still need coverage)*
- Make sure current tutorial pipeline works reliably end-to-end.

## Phase 1 — Finish the core autocomplete engine

- Finish LSP + AST integration.
- Finish same-file dependency resolution.
- Finish cross-file symbol/indexing.
- Finish replacement-region logic.
- Finish suffix/prefix handling.
- Improve minimal-diff generation.
- Improve duplicate detection.
- 🟡 Improve streaming/cancellation. *(cancellation aborts the request promptly; finished streams are drained so connections are reused)*
- Improve prediction continuation.

At the end, this is the stable V1 pipeline:

```
VS Code
 ↓
Context gathering
 ↓
AST/LSP/cross-file context
 ↓
Prompt
 ↓
LLM
 ↓
Cleaning
 ↓
Deduplication
 ↓
Minimal edit
 ↓
Ghost text
```

## Phase 2 — Model/provider system

✅ Create a proper `ModelProvider` abstraction — `src/api/providers.ts` (registry) + `src/api/transports.ts` (wire formats):

```
ModelProvider
 ├── OpenRouter            (OpenAI-compatible)
 ├── Groq                  (OpenAI-compatible)
 ├── Fireworks             (OpenAI-compatible)
 ├── Gemini                (OpenAI-compatible)
 ├── Claude                (Anthropic SDK)
 ├── Custom providers      (OpenAI- or Anthropic-compatible, e.g. OpenAI, Together, DeepSeek, proxies)
 └── Local servers         (Ollama, LM Studio, llama.cpp, vLLM)
```

- ✅ Allow users to configure API keys/providers. *(API-key dropdown for every provider; custom providers with URL normalization; Test connection)*
- ✅ Add model selection.
- ✅ Add model dropdown. *(suggested models per provider; switching provider switches to a compatible model)*
- ✅ Add provider dropdown.
- 🟡 Add "Auto" model selection. *(`auto` picks the first provider with a key; no quality/latency-based choice yet)*
- ✅ Store provider/model configuration cleanly.

Only after this should you do:

- OpenRouter model discovery.
- 🟡 Fetch available models dynamically. *(local servers only: `/v1/models`, falling back to Ollama `/api/tags`)*
- 🟡 Display available models in the UI. *(local servers only)*
- Display model capabilities where useful.
- 🟡 Handle unavailable/failed models. *(errors are surfaced and counted as failed requests; no automatic switch)*
- Handle rate-limit responses.
- Handle exhausted quota/credits where the provider exposes that information.
- 🟡 Implement automatic fallback to another configured model. *(Claude Opus 5 uses Anthropic's server-side refusal fallback; nothing cross-provider yet)*

Target:

```
                 Request
                    ↓
              Model Router
                    ↓
       ┌────────────┼────────────┐
       ▼            ▼            ▼
    Model A      Model B       Model C
       │            │            │
       └────────────┼────────────┘
                    ↓
               Best available
```

**Important:** don't make LangChain responsible for this yet. Build the provider abstraction manually first.

## Phase 3 — Settings/customization UI

- ✅ Add Textify Activity Bar/sidebar.
- ✅ Create Textify settings page.
- ✅ Add master Enable/Disable Textify toggle.
- 🟡 Add small bottom/status-bar Textify toggle. *(status bar item shows session tokens/cost and opens the usage report; no on/off toggle yet)*
- ✅ Add model dropdown.
- ✅ Add provider selection.
- ✅ Add completion settings. *(max tokens, temperature, debounce)*
- ✅ Add context settings.
- ✅ Add cache settings.
- Add RAG settings.
- Add privacy settings.
- ✅ Add advanced settings. *(debug prompt logging)*
- ✅ Add reset-to-default settings. *(with confirmation, since it also clears keys and custom providers)*

Added beyond the original plan:

- ✅ Custom instructions: global, per-language, workspace `.textify/instructions.md`, file upload, append/replace mode.
- ✅ Custom provider and local server management (add / edit / remove / detect models / test).
- ✅ Latency section (rolling p50/p90, benchmark) and Usage section (session / all time, per-model breakdown).
- ✅ Model price editor (per provider or per model, with the price source shown).

Suggested UI:

```
Textify
│
├── General
│   └── Enable Textify
│
├── Completion
│   ├── Trigger delay
│   ├── Completion length
│   └── Multi-line
│
├── Models
│   ├── Provider
│   ├── Model
│   └── Auto routing
│
├── Instructions          (added in v0.0.5)
│
├── Latency / Usage       (added in v0.0.5)
│
├── Context
│   ├── AST
│   ├── LSP
│   ├── Cross-file
│   └── RAG
│
├── Cache
│
├── Privacy
│
└── Advanced
```

## Phase 4 — Improve the actual coding experience

JumpTab / automatic missing imports:

- Research how Cursor handles import insertion.
- Implement import detection.
- Implement automatic import insertion.
- Make import insertion safe with AST/LSP.
- Handle duplicate imports.
- Handle import formatting.
- Handle language-specific imports.

Then:

- Improve indentation handling.
- Improve multiline completions.
- Improve cursor-position handling.
- Improve replacement/deletion decorations.
- Improve acceptance/rejection tracking.

JumpTab/import insertion should come after the basic completion engine is stable because it depends heavily on
the AST/LSP/code-understanding infrastructure.

## Phase 5 — RAG / Repository Intelligence

This is the biggest architectural upgrade.

- Define repository indexing architecture.
- Build repository file index.
- Build symbol index.
- Build dependency/reference graph.
- Add semantic embeddings.
- Add vector storage.
- Add lexical retrieval.
- Add semantic retrieval.
- Add structural/symbol retrieval.
- Combine them into hybrid retrieval.
- Add retrieval ranking.
- Add re-ranking.
- Integrate RAG into `ContextGatherer`.
- Add context relevance scoring.
- Add context deduplication.
- Add token-budget-aware context selection.
- Add repository re-indexing on file changes.

Final retrieval pipeline:

```
Current Code
     │
     ├── AST/LSP
     ├── Symbol Search
     ├── Dependency Search
     ├── Lexical Search
     └── Semantic Search
              │
              ▼
       Hybrid Retriever
              │
              ▼
          Re-ranker
              │
              ▼
       Context Selector
              │
              ▼
        Token Budget
              │
              ▼
             LLM
```

Do RAG before LangGraph.

## Phase 6 — Intelligent caching

Textify already has LRU/LFU-style completion caching (`BoundedCache`) — extend it rather than rebuilding it.

- Exact completion cache.
- Prefix-aware cache.
- Context-aware cache.
- Repository-aware cache.
- Semantic cache.
- Cache invalidation based on file changes.
- Cache invalidation based on repository changes.
- 🟡 Measure cache hit rate. *(suggestions served from cache are counted in usage metrics)*
- 🟡 Measure inference requests avoided. *(same counter; not yet broken down by cache layer)*
- Measure latency reduction.
- Measure cost reduction.

Architecture:

```
Request
 ↓
L1 Exact Cache
 ↓ miss
L2 Prefix Cache
 ↓ miss
L3 Context Cache
 ↓ miss
L4 Semantic Cache
 ↓ miss
Model
```

## Phase 7 — Intelligent model routing

Now combine the model system + RAG + cache.

- Build request complexity analysis.
- Classify completion difficulty.
- Add fast-path deterministic/symbol completion.
- Add fast model.
- Add strong model.
- Implement automatic model routing.
- Add latency-aware routing.
- Add cost-aware routing.
- Add quality-aware routing.
- Add fallback routing.

Final:

```
                   Request
                      ↓
               Complexity Analysis
                      ↓
             ┌────────┼────────┐
             ▼        ▼        ▼
          Trivial   Normal   Complex
             │        │        │
             ▼        ▼        ▼
           Cache   Fast LLM  Strong LLM
```

## Phase 8 — OpenRouter intelligence

Now build specifically around OpenRouter.

- Fetch available models.
- Show models in Textify UI.
- Show supported capabilities where available.
- Track model failures.
- Track rate limits.
- 🟡 Track usage/quota information where available through the provider. *(OpenRouter-reported cost is used; its public price catalog prices other providers; no quota tracking)*
- Automatically fallback when a model becomes unavailable.
- Automatically switch models after rate limits/exhaustion where the API exposes sufficient information.
- Add model health state.

Example:

```
                    OpenRouter
                       │
             ┌─────────┼─────────┐
             ▼         ▼         ▼
          Model A   Model B   Model C
             │         │         │
             ▼         ▼         ▼
           Healthy   Limited   Exhausted
             │
             ▼
          Use A
```

## Phase 9 — Rate limiting + backend protection

Do this once the API/provider architecture is settled.

- Add request rate limiting.
- Add per-user rate limits.
- Add per-model rate limits.
- Add concurrency limits.
- Add request queues where necessary.
- Add backpressure.
- ✅ Add timeout handling. *(30s request timeout for Claude, timeouts on benchmarks, pre-warm and model detection)*
- 🟡 Add retry policies. *(completions deliberately don't retry, since a late completion is useless; one retry without `stream_options` for strict servers)*
- Add exponential backoff.
- Add circuit breaker for failing providers.

This becomes:

```
VS Code
   ↓
API
   ↓
Rate Limiter
   ↓
Concurrency Manager
   ↓
Model Router
   ↓
Provider
```

## Phase 10 — Observability

- Add structured logging.
- Add request IDs.
- Add request tracing.
- ✅ Measure context retrieval time.
- Measure RAG latency.
- Measure cache latency.
- ✅ Measure model latency. *(time to first token and total request time)*
- ✅ Measure streaming latency.
- 🟡 Measure p50/p95/p99. *(p50/p90 over the last 50 completions)*
- Add Prometheus metrics.
- Add Grafana dashboard.
- 🟡 Add model performance dashboard. *(in-panel latency and per-model usage/cost; no external dashboard)*
- ✅ Track token usage and cost per provider/model *(added in v0.0.5: session + all-time, `/cost`-style report)*

Target visibility, e.g. (v0.0.5 already logs `debounce / context / prompt / ttft / request / total` per completion):

```
Request #12491

Cache       2ms
AST         7ms
RAG        14ms
Ranking     5ms
LLM        81ms
Processing  4ms
───────────────
Total     113ms
```

## Phase 11 — Evaluation

This is mandatory for the final project.

- Build completion benchmark dataset.
- Test multiple programming languages.
- Establish baseline.
- Measure exact match.
- Measure Pass@1.
- Measure syntax validity.
- ✅ Measure acceptance rate. *(usage metrics: accepted / shown)*
- Measure retrieval Recall@K.
- Measure MRR.
- Measure context relevance.
- Measure p50/p95/p99.
- Measure throughput.
- Measure cache hit rate.
- 🟡 Measure tokens/request. *(provider-reported tokens per model, incl. cache read/write; not per request yet)*
- 🟡 Measure cost/request. *(cost per model and total for every provider)*

Then run ablation experiments in this order to get real evidence of what each layer contributes:

```
Baseline
   ↓
+ AST/LSP
   ↓
+ Cross-file context
   ↓
+ RAG
   ↓
+ Context ranking
   ↓
+ Cache
   ↓
+ Model routing
```

## Phase 12 — Load testing / scalability

- Build realistic completion traffic generator.
- Test 10 concurrent users.
- Test 100.
- Test 1,000.
- Test higher concurrency as infrastructure permits.
- Find bottlenecks.
- ✅ Optimize connection pooling. *(keep-alive reuse, pre-warming after idle, debounce to avoid aborted requests)*
- Optimize batching where applicable.
- Optimize caching.
- Optimize queues.
- Add horizontal scaling if needed.

## Phase 13 — Speculative completion

Do this late.

- Research speculative decoding/completion APIs.
- Determine whether the chosen providers actually support the required mechanism.
- Prototype small/fast model prediction.
- Prototype strong-model verification/refinement.
- Compare latency.
- Compare quality.
- Compare cost.
- Keep it only if benchmarks demonstrate a real benefit.

Concept:

```
                 User
                  ↓
            Small Model
                  ↓
         Fast prediction
                  ↓
            Strong Model
                  ↓
         Verify/refine
                  ↓
             Completion
```

Don't make this a core dependency of Textify.

## Phase 14 — LangChain / LangGraph

Do this last, and only if Textify is expanding beyond autocomplete.

- Build the provider abstraction manually first.
- Build the completion pipeline manually first.
- Build RAG manually first.
- Understand the architecture without LangChain.
- Then evaluate where LangChain actually provides value.
- Add LangChain where useful for model/tool abstractions.
- Add LangGraph if introducing stateful agent workflows.

For example, if Textify eventually becomes:

```
Textify
│
├── Autocomplete
│
├── Code explanation
│
├── Refactoring
│
├── Bug fixing
│
├── Test generation
│
└── Coding Agent
       │
       ├── Inspect code
       ├── Search repository
       ├── Edit files
       ├── Run tests
       ├── Inspect errors
       └── Iterate
```

That's where LangGraph becomes much more relevant. Don't introduce LangGraph just because this is an AI
project.

## Phase 15 — Local / Hybrid inference

- ✅ Add local model support. *(Ollama, LM Studio, llama.cpp, vLLM; keyless; model detection; priced at $0)*
- Add local/cloud/hybrid modes.
- Add privacy policies.
- Detect sensitive files/secrets.
- Prevent sensitive context from going to cloud models.
- Add local model fallback.

```
                 Request
                    ↓
              Privacy Policy
               /          \
              /            \
       Sensitive          Normal
           ↓                 ↓
      Local Model       Cloud Model
```

## Phase 16 — Personalization

- ✅ Track accepted completions. *(IntentTracker + usage metrics, incl. lines added/removed)*
- ✅ Track rejected completions.
- Learn preferred completion length.
- Learn language preferences.
- Learn repository-specific patterns.
- Use behavior to improve ranking.
- Keep personalization local by default.

## Phase 17 — Final polish

- Improve onboarding.
- Add first-run configuration.
- ✅ Add API-key management.
- Add repository indexing status.
- 🟡 Add model status. *(active provider/model shown in the panel; Test connection)*
- 🟡 Add cache statistics. *(cache-served suggestions counted)*
- 🟡 Add performance dashboard. *(Latency + Usage sections in the panel)*
- ✅ Add debugging mode. *(`textify.debugLogging`)*
- Add error explanations.
- 🟡 Add documentation. *(README, CHANGELOG, CLAUDE.md updated for v0.0.5)*
- Add architecture documentation.
- Add benchmark results.
- Add demo video.
- Package/publish the extension.

## The actual priority order

Short version, follow this exact sequence:

```
1. Fix/stabilize current Textify       🟡 still the gate for 6+
        ↓
2. Finish tutorial implementation
        ↓
3. Provider/model abstraction          ✅ v0.0.5
        ↓
4. Model selection dropdown            ✅ v0.0.5
        ↓
5. Textify settings/sidebar            🟡 v0.0.5
        ↓
6. JumpTab + imports
        ↓
7. Improve indentation/cursor/completion UX
        ↓
8. Repository indexing
        ↓
9. Hybrid RAG
        ↓
10. Context ranking/optimization
        ↓
11. Intelligent caching
        ↓
12. Adaptive model routing
        ↓
13. OpenRouter model discovery/fallback
        ↓
14. Rate limiting/retries/backpressure
        ↓
15. Observability                     🟡 v0.0.5 (latency + usage/cost)
        ↓
16. Evaluation framework
        ↓
17. Load testing
        ↓
18. Performance optimization
        ↓
19. Speculative completion
        ↓
20. Local/hybrid inference            🟡 v0.0.5 (local servers)
        ↓
21. Personalization
        ↓
22. LangChain/LangGraph
        ↓
23. Final polish/release
```
