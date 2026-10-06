// Network transports for each wire format. Intentionally free of `vscode` imports so they can be
// exercised from plain Node (see scripts/benchmark-latency.js) and unit tests.
import Anthropic from "@anthropic-ai/sdk";
import { ChatMessage, ChatStreamChunk } from "../utils/types";
import { ANTHROPIC_BASE_URL } from "./providers";

export interface TransportRequest {
    endpoint: string;
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    maxTokens: number;
    temperature: number;
    signal: AbortSignal;
    extraBody?: Record<string, unknown>;
    /** Called once with provider-reported token usage (one entry per model that served the request). */
    onUsage?: (usage: TokenUsage[]) => void;
}

/** Token counts as reported by the provider. `inputTokens` excludes cache reads/writes. */
export interface TokenUsage {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Cost reported by the provider itself (e.g. OpenRouter), when available. */
    reportedCostUsd?: number;
}

interface OpenAIUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    cost?: number;
}

/** OpenAI-style usage: prompt_tokens includes cached tokens, so split them out. */
export function normalizeOpenAIUsage(model: string, usage: OpenAIUsage): TokenUsage {
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    return {
        model,
        inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        reportedCostUsd: typeof usage.cost === 'number' ? usage.cost : undefined
    };
}

export class ModelRefusalError extends Error {
    constructor() {
        super('Model declined the request (stop_reason: refusal)');
    }
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible (/chat/completions with SSE)
// ---------------------------------------------------------------------------------------------

/**
 * Incremental SSE parser for OpenAI-style chat completion streams. Tolerates `data:` with or
 * without a space and CRLF line endings (common with self-hosted / proxy servers).
 */
export class OpenAISseParser {
    private buffer = '';
    done = false;
    /** Usage from the final chunk (`stream_options.include_usage`), or Groq's `x_groq.usage`. */
    usage: OpenAIUsage | undefined;

    push(text: string): string[] {
        this.buffer += text;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        const out: string[] = [];
        for (const rawLine of lines) {
            const content = this.parseLine(rawLine);
            if (content) {
                out.push(content);
            }
            if (this.done) {
                break;
            }
        }
        return out;
    }

    /** Flushes a final unterminated line, if any. */
    end(): string[] {
        const rest = this.buffer;
        this.buffer = '';
        const content = rest ? this.parseLine(rest) : undefined;
        return content ? [content] : [];
    }

    private parseLine(rawLine: string): string | undefined {
        const line = rawLine.replace(/\r$/, '');
        if (!line.startsWith('data:')) {
            return undefined;
        }
        const data = line.slice(5).trimStart();
        if (data === '[DONE]') {
            this.done = true;
            return undefined;
        }
        let parsed: ChatStreamChunk & { error?: { message?: string } | string; usage?: OpenAIUsage | null; x_groq?: { usage?: OpenAIUsage } };
        try {
            parsed = JSON.parse(data);
        } catch {
            return undefined;
        }
        if (parsed.error) {
            const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
            throw new Error(`Stream error: ${message ?? JSON.stringify(parsed.error)}`);
        }
        const usage = parsed.usage ?? parsed.x_groq?.usage;
        if (usage) {
            this.usage = usage;
        }
        return parsed.choices?.[0]?.delta?.content || undefined;
    }
}

// Endpoints that rejected `stream_options`; usage isn't requested from them again this session.
const noStreamOptions = new Set<string>();

export async function* streamOpenAICompatible(req: TransportRequest): AsyncGenerator<string, void, unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (req.apiKey) {
        headers['Authorization'] = `Bearer ${req.apiKey}`;
    }
    const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        stream: true,
        temperature: req.temperature,
        ...req.extraBody
    };
    const send = (withUsage: boolean) => fetch(req.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(withUsage ? { ...body, stream_options: { include_usage: true } } : body),
        signal: req.signal
    });

    const wantUsage = !noStreamOptions.has(req.endpoint);
    let response = await send(wantUsage);
    if (!response.ok) {
        const errorText = await response.text();
        // A few strict self-hosted servers reject unknown fields: retry once without usage reporting.
        if (wantUsage && response.status === 400 && /stream_options|include_usage/i.test(errorText)) {
            noStreamOptions.add(req.endpoint);
            response = await send(false);
            if (!response.ok) {
                throw new Error(`API Error ${response.status}: ${(await response.text()).slice(0, 500)}`);
            }
        } else {
            throw new Error(`API Error ${response.status}: ${errorText.slice(0, 500)}`);
        }
    }
    if (!response.body) {
        throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new OpenAISseParser();
    let finished = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                finished = true;
                if (!parser.done) {
                    yield* parser.end();
                }
                break;
            }
            if (!parser.done) {
                yield* parser.push(decoder.decode(value, { stream: true }));
            }
            // After [DONE], keep reading to EOF (normally immediate): cancelling a body that
            // hasn't ended destroys the socket instead of returning it to the keep-alive pool.
        }
    } finally {
        if (!finished) {
            await reader.cancel().catch(() => undefined);
        }
        if (parser.usage) {
            req.onUsage?.([normalizeOpenAIUsage(req.model, parser.usage)]);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Anthropic Messages API (official SDK)
// ---------------------------------------------------------------------------------------------

const anthropicClients = new Map<string, Anthropic>();

function getAnthropicClient(baseURL: string, apiKey: string): Anthropic {
    const key = `${baseURL}\u0000${apiKey}`;
    let client = anthropicClients.get(key);
    if (!client) {
        client = new Anthropic({
            apiKey: apiKey || 'not-required',
            authToken: null,
            baseURL,
            // A stale completion is worthless: fail fast instead of retrying/backing off.
            maxRetries: 0,
            timeout: 30_000
        });
        if (anthropicClients.size > 8) {
            anthropicClients.clear();
        }
        anthropicClients.set(key, client);
    }
    return client;
}

/** Models that still accept `temperature` (Haiku 4.5 / the 4.5-and-older family, 4.6) and reject `effort`-free tuning. */
function acceptsSampling(model: string): boolean {
    if (!model.startsWith('claude-')) {
        return true; // Anthropic-compatible proxy serving a non-Claude model
    }
    return /haiku|claude-3|-4-[0156](\b|-|$)|-4$/.test(model);
}

/** Models where server-side refusal fallbacks are available. */
function supportsServerFallbacks(model: string): boolean {
    return /^claude-(opus-5|fable-5)/.test(model);
}

export interface AnthropicTuning {
    maxTokens: number;
    temperature?: number;
    effort?: 'low';
    useFallbacks: boolean;
}

/**
 * Per-model request shaping tuned for latency:
 * - Opus 5 / Sonnet 5 / Opus 4.7+ / Fable: sampling params are rejected, thinking may be on by
 *   default -> `effort: low` keeps thinking minimal, and max_tokens gets headroom so any thinking
 *   doesn't truncate the visible completion.
 * - Haiku 4.5 and older: no thinking unless requested, so plain temperature is used.
 */
export function anthropicTuningFor(model: string, maxTokens: number, temperature: number, official: boolean): AnthropicTuning {
    if (acceptsSampling(model)) {
        return { maxTokens, temperature, useFallbacks: false };
    }
    return {
        maxTokens: Math.max(maxTokens, 2048),
        effort: 'low',
        useFallbacks: official && supportsServerFallbacks(model)
    };
}

export async function* streamAnthropic(req: TransportRequest): AsyncGenerator<string, void, unknown> {
    const official = req.endpoint.replace(/\/$/, '') === ANTHROPIC_BASE_URL;
    const client = getAnthropicClient(req.endpoint, req.apiKey);
    const tuning = anthropicTuningFor(req.model, req.maxTokens, req.temperature, official);

    const systemText = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
        model: req.model,
        max_tokens: tuning.maxTokens,
        // The system prompt (+ user instructions) is identical across requests; mark it cacheable.
        // Below the model's minimum cacheable size this is silently a no-op.
        system: systemText ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] : undefined,
        messages,
        stream: true
    };
    if (tuning.temperature !== undefined) {
        params.temperature = tuning.temperature;
    }
    if (tuning.effort) {
        params.output_config = { effort: tuning.effort };
    }
    if (tuning.useFallbacks) {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
    }

    const stream = await client.beta.messages.create(params, { signal: req.signal });
    let stopReason: string | null = null;
    const usage = new AnthropicUsageAccumulator(req.model);
    try {
        // Server-side fallback continuations arrive on this same stream and are kept. A final
        // `refusal` means the whole chain declined: throw so the caller discards the partial text.
        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield event.delta.text;
            } else if (event.type === 'message_start') {
                usage.start(event.message.model, event.message.usage);
            } else if (event.type === 'message_delta') {
                stopReason = event.delta.stop_reason ?? stopReason;
                usage.delta(event.usage);
            }
        }
    } finally {
        const entries = usage.result();
        if (entries.length > 0) {
            req.onUsage?.(entries);
        }
    }
    if (stopReason === 'refusal') {
        throw new ModelRefusalError();
    }
}

interface UsageFields {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    iterations?: unknown;
}

type IterationUsage = UsageFields & { type?: string; model?: string | null };

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

/**
 * Combines `message_start` and cumulative `message_delta` usage. When a server-side fallback ran,
 * `iterations` holds one entry per attempt, each tagged with the model that produced it.
 */
export class AnthropicUsageAccumulator {
    private servedModel: string;
    private readonly totals: Record<(typeof USAGE_KEYS)[number], number> = {
        input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0
    };
    private iterations: IterationUsage[] = [];
    private seen = false;

    constructor(requestedModel: string) {
        this.servedModel = requestedModel;
    }

    start(model: string | undefined | null, usage: UsageFields | undefined | null): void {
        if (model) {
            this.servedModel = model;
        }
        this.merge(usage);
    }

    delta(usage: UsageFields | undefined | null): void {
        this.merge(usage);
    }

    private merge(usage: UsageFields | undefined | null): void {
        if (!usage) {
            return;
        }
        this.seen = true;
        // message_delta values are cumulative, so the larger value is the latest.
        for (const key of USAGE_KEYS) {
            const value = usage[key];
            if (typeof value === 'number') {
                this.totals[key] = Math.max(this.totals[key], value);
            }
        }
        if (Array.isArray(usage.iterations) && usage.iterations.length > 0) {
            this.iterations = usage.iterations as IterationUsage[];
        }
    }

    result(): TokenUsage[] {
        if (!this.seen) {
            return [];
        }
        const toUsage = (model: string, u: UsageFields): TokenUsage => ({
            model,
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0
        });
        const sampling = this.iterations.filter((it) => it.type === 'message' || it.type === 'fallback_message');
        if (sampling.length > 1) {
            return sampling.map((it) => toUsage(it.model || this.servedModel, it));
        }
        return [toUsage(this.servedModel, this.totals)];
    }
}

// ---------------------------------------------------------------------------------------------
// Model discovery (local servers)
// ---------------------------------------------------------------------------------------------

/**
 * Lists the models a server offers: OpenAI-style `GET …/v1/models` (Ollama, LM Studio, llama.cpp,
 * vLLM), falling back to Ollama's native `GET /api/tags`.
 */
export async function discoverModels(chatEndpoint: string, apiKey = '', timeoutMs = 5000): Promise<string[]> {
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const errors: string[] = [];
    const url = new URL(chatEndpoint);
    url.pathname = url.pathname.replace(/\/chat\/completions$/, '') + '/models';
    try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (response.ok) {
            const json = await response.json() as { data?: Array<{ id?: string }> };
            const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
            if (ids.length > 0) {
                return ids;
            }
        } else {
            errors.push(`${url.pathname}: HTTP ${response.status}`);
        }
    } catch (error) {
        errors.push(`${url.pathname}: ${error instanceof Error ? error.message : error}`);
    }
    try {
        const tags = new URL('/api/tags', url.origin);
        const response = await fetch(tags, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (response.ok) {
            const json = await response.json() as { models?: Array<{ name?: string; model?: string }> };
            const names = (json.models ?? []).map((m) => m.name ?? m.model).filter((n): n is string => typeof n === 'string' && n.length > 0);
            if (names.length > 0) {
                return names;
            }
        }
    } catch {
        // not an Ollama server
    }
    throw new Error(errors.length ? `No models found (${errors.join('; ')})` : 'The server returned no models');
}
