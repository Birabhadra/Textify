// Model pricing for every provider. vscode-free.
//
// Resolution order for a (provider, model) pair:
//   1. user price in `textify.modelPricing` ("<provider>:<model>" first, then "<model>")
//   2. Claude list prices (exact, from the Claude API reference)
//   3. local model servers -> $0
//   4. OpenRouter's public model catalog (exact id, then matched by model name) -> approximate
// A cost reported by the provider on the response itself (e.g. OpenRouter) always wins over all of these.

/** USD per 1M tokens. Cache rates default to 0.1x (read) / 1.25x (write) of `input`. */
export interface ModelPrice {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
}

export type PriceSource = 'custom' | 'list' | 'local' | 'catalog';

export interface ResolvedPrice {
    price: ModelPrice;
    source: PriceSource;
    /** Catalog entry the price came from, when source is 'catalog'. */
    matchedId?: string;
}

export interface PricingContext {
    overrides?: Record<string, ModelPrice>;
    catalog?: Record<string, ModelPrice>;
    /** True when the provider is a local model server. */
    isLocal?: boolean;
}

export interface TokenCounts {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

// Anthropic list prices, matched by prefix, most specific first.
const CLAUDE_PRICES: Array<[prefix: string, price: ModelPrice]> = [
    ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
    ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
    ['claude-fable-5', { input: 10, output: 50 }],
    ['claude-mythos-5', { input: 10, output: 50 }],
    ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
    ['claude-opus-5', { input: 5, output: 25 }],
    ['claude-opus-4-8', { input: 5, output: 25 }],
    ['claude-opus-4-7', { input: 5, output: 25 }],
    ['claude-opus-4-6', { input: 5, output: 25 }],
    ['claude-opus-4-5', { input: 5, output: 25 }],
    ['claude-sonnet-5', { input: 2, output: 10 }],
    ['claude-sonnet-4', { input: 3, output: 15 }],
    ['claude-haiku-4-5', { input: 1, output: 5 }]
];

function isValidPrice(p: unknown): p is ModelPrice {
    const price = p as ModelPrice;
    return !!price && typeof price.input === 'number' && typeof price.output === 'number' && price.input >= 0 && price.output >= 0;
}

/** Lowercased model name without vendor prefix / variant suffix: "google/gemini-2.5-flash:free" -> "gemini-2.5-flash". */
export function modelBaseName(model: string): string {
    return model.toLowerCase().split('/').pop()!.replace(/:[a-z0-9._-]+$/, '').trim();
}

/**
 * Provider-neutral spelling: Fireworks' "llama-v3p3-70b-instruct" and "qwen2p5-coder" become
 * "llama3.370binstruct" / "qwen2.5coder", matching OpenRouter's "llama-3.3-70b-instruct" / "qwen-2.5-coder".
 */
export function canonicalModelName(model: string): string {
    return modelBaseName(model)
        .replace(/(\d)p(\d)/g, '$1.$2')
        .replace(/(^|[-_])v(\d)/g, '$1$2')
        .replace(/[-_\s]/g, '');
}

// Deployment/tuning suffixes that don't change which model it is (Groq "-versatile"/"-instant", "-instruct", …).
const VARIANT_SUFFIX = /(instruct|versatile|instant|chat|it|latest|preview|turbo)$/;

function stripVariant(canonical: string): string | undefined {
    let name = canonical;
    for (let i = 0; i < 3 && VARIANT_SUFFIX.test(name); i++) {
        name = name.replace(VARIANT_SUFFIX, '');
    }
    // Only trust the loose match when a version/size is left, so "deepseek-chat" can't match "deepseek-anything".
    return name !== canonical && /\d/.test(name) && name.length >= 6 ? name : undefined;
}

function fromCatalog(model: string, catalog: Record<string, ModelPrice>): ResolvedPrice | undefined {
    const exact = catalog[model];
    if (isValidPrice(exact)) {
        return { price: exact, source: 'catalog', matchedId: model };
    }
    const base = modelBaseName(model);
    if (!base) {
        return undefined;
    }
    const canonical = canonicalModelName(model);
    const loose = stripVariant(canonical) ?? canonical;
    // Tiered: same base name > same canonical spelling > same model ignoring variant suffixes.
    // Within a tier prefer the paid variant (no ":free" suffix).
    const candidates: Array<string | undefined> = [undefined, undefined, undefined];
    for (const id of Object.keys(catalog)) {
        if (!isValidPrice(catalog[id])) {
            continue;
        }
        const idCanonical = canonicalModelName(id);
        const tier = modelBaseName(id) === base ? 0
            : idCanonical === canonical ? 1
                : (stripVariant(idCanonical) ?? idCanonical) === loose ? 2
                    : -1;
        if (tier < 0) {
            continue;
        }
        const current = candidates[tier];
        if (!current || (current.includes(':') && !id.includes(':'))) {
            candidates[tier] = id;
        }
    }
    const match = candidates.find(Boolean);
    return match ? { price: catalog[match], source: 'catalog', matchedId: match } : undefined;
}

export function resolvePrice(provider: string, model: string, context: PricingContext = {}): ResolvedPrice | undefined {
    const overrides = context.overrides ?? {};
    const custom = overrides[`${provider}:${model}`] ?? overrides[model];
    if (isValidPrice(custom)) {
        return { price: custom, source: 'custom' };
    }
    const list = CLAUDE_PRICES.find(([prefix]) => model.startsWith(prefix));
    if (list) {
        return { price: list[1], source: 'list' };
    }
    if (context.isLocal) {
        return { price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: 'local' };
    }
    return context.catalog ? fromCatalog(model, context.catalog) : undefined;
}

export function costFor(tokens: TokenCounts, price: ModelPrice): number {
    const cacheRead = price.cacheRead ?? price.input * 0.1;
    const cacheWrite = price.cacheWrite ?? price.input * 1.25;
    return (
        tokens.inputTokens * price.input +
        tokens.outputTokens * price.output +
        tokens.cacheReadTokens * cacheRead +
        tokens.cacheWriteTokens * cacheWrite
    ) / 1_000_000;
}

interface OpenRouterModel {
    id?: string;
    pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}

/** Parses `GET https://openrouter.ai/api/v1/models` (USD per token, as strings) into per-1M prices. */
export function parseOpenRouterCatalog(json: unknown): Record<string, ModelPrice> {
    const out: Record<string, ModelPrice> = {};
    const data = (json as { data?: OpenRouterModel[] })?.data;
    if (!Array.isArray(data)) {
        return out;
    }
    const perMillion = (value: string | undefined): number | undefined => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        const n = Number(value);
        // Negative values mark variable/unknown pricing (e.g. routers); skip them.
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
    };
    for (const model of data) {
        if (!model?.id || !model.pricing) {
            continue;
        }
        const input = perMillion(model.pricing.prompt);
        const output = perMillion(model.pricing.completion);
        if (input === undefined || output === undefined) {
            continue;
        }
        const price: ModelPrice = { input, output };
        const cacheRead = perMillion(model.pricing.input_cache_read);
        const cacheWrite = perMillion(model.pricing.input_cache_write);
        if (cacheRead !== undefined) { price.cacheRead = cacheRead; }
        if (cacheWrite !== undefined) { price.cacheWrite = cacheWrite; }
        out[model.id] = price;
    }
    return out;
}
