export type BuiltinProviderId = 'openrouter' | 'groq' | 'fireworks' | 'gemini' | 'anthropic';
/** A builtin provider id, or `custom:<slug>` for a user-defined provider. */
export type ApiProvider = BuiltinProviderId | `custom:${string}`;
export type ProviderSelection = 'auto' | ApiProvider;

/**
 * Wire protocol spoken by a provider endpoint. `local` is a local model server (Ollama, LM Studio,
 * llama.cpp, vLLM): OpenAI-compatible on the wire, but keyless and with model auto-detection.
 */
export type ApiFormat = 'openai' | 'anthropic' | 'local';

export const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1';

export type BuiltinApiKeyConfigKey =
    'openrouterApiKey' | 'groqApiKey' | 'fireworksApiKey' | 'geminiApiKey' | 'anthropicApiKey';

export interface ProviderDefinition {
    id: ApiProvider;
    label: string;
    /** Full URL for `openai` format; base URL (no `/v1/messages`) for `anthropic` format. */
    endPoint: string;
    /** Defaults to 'openai' (OpenAI-compatible /chat/completions). */
    format?: ApiFormat;
    /** Settings key holding the API key (builtins only). */
    apiKeyConfigKey?: BuiltinApiKeyConfigKey;
    /** API key stored inline on the provider (custom providers only). */
    apiKey?: string;
    models: string[];
    isCustom?: boolean;
    extraBodyFields?: () => Record<string, unknown>;
}

/** Shape of one entry in the `textify.customProviders` setting. */
export interface CustomProviderConfig {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    format: ApiFormat;
    models: string[];
}

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export const PROVIDERS: ProviderDefinition[] = [
    {
        id: 'openrouter',
        label: 'OpenRouter',
        endPoint: 'https://openrouter.ai/api/v1/chat/completions',
        apiKeyConfigKey: 'openrouterApiKey',
        models: [
            'qwen/qwen3-32b',
            'qwen/qwen-2.5-coder-32b-instruct',
            'deepseek/deepseek-chat',
            'meta-llama/llama-3.3-70b-instruct'
        ]
    },
    {
        id: 'groq',
        label: 'Groq',
        endPoint: 'https://api.groq.com/openai/v1/chat/completions',
        apiKeyConfigKey: 'groqApiKey',
        models: [
            'qwen/qwen3-32b',
            'llama-3.3-70b-versatile',
            'llama-3.1-8b-instant'
        ],
        extraBodyFields: () => ({ reasoning_effort: 'none' })
    },
    {
        id: 'fireworks',
        label: 'Fireworks',
        endPoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
        apiKeyConfigKey: 'fireworksApiKey',
        models: [
            'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
            'accounts/fireworks/models/llama-v3p3-70b-instruct'
        ]
    },
    {
        id: 'gemini',
        label: 'Gemini',
        endPoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKeyConfigKey: 'geminiApiKey',
        models: [
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.5-pro'
        ]
    },
    {
        id: 'anthropic',
        label: 'Claude (Anthropic)',
        endPoint: ANTHROPIC_BASE_URL,
        format: 'anthropic',
        apiKeyConfigKey: 'anthropicApiKey',
        models: [
            'claude-opus-5',
            'claude-sonnet-5',
            'claude-haiku-4-5'
        ]
    }
];

/**
 * Turns whatever the user typed into the URL the transport needs.
 * - openai:    `https://host/v1` -> `https://host/v1/chat/completions` (full URLs are kept)
 * - anthropic: `https://host/v1/messages` or `https://host/v1` -> `https://host` (the SDK appends `/v1/messages`)
 * Throws on anything that isn't an absolute http(s) URL.
 */
export function normalizeEndpoint(rawUrl: string, format: ApiFormat): string {
    const trimmed = (rawUrl ?? '').trim();
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new Error(`Invalid URL: "${trimmed}"`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`URL must start with http:// or https:// (got ${url.protocol})`);
    }
    url.hash = '';
    let path = url.pathname.replace(/\/+$/, '');

    if (format === 'openai' || format === 'local') {
        if (!/\/chat\/completions$/.test(path)) {
            path = `${path}/chat/completions`;
        }
    } else {
        path = path.replace(/\/messages$/, '').replace(/\/v1$/, '');
    }
    url.pathname = path || '/';
    return url.toString().replace(/\/$/, '');
}

/** `…/v1/chat/completions` -> `…/v1/models` (OpenAI-compatible model listing). */
export function modelsEndpoint(chatEndpoint: string): string {
    const url = new URL(chatEndpoint);
    url.pathname = url.pathname.replace(/\/chat\/completions$/, '') + '/models';
    return url.toString();
}

export function slugifyProviderName(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
}

/** Validates and cleans a custom provider coming from the UI or settings. Throws with a user-facing message. */
export function sanitizeCustomProvider(input: Partial<CustomProviderConfig>, existingIds: string[] = []): CustomProviderConfig {
    const name = (input.name ?? '').trim();
    if (!name) {
        throw new Error('Provider name is required');
    }
    const format: ApiFormat = input.format === 'anthropic' || input.format === 'local' ? input.format : 'openai';
    const baseUrl = (input.baseUrl ?? '').trim();
    normalizeEndpoint(baseUrl, format);

    const models = Array.from(new Set((input.models ?? []).map((m) => String(m).trim()).filter(Boolean)));
    if (models.length === 0) {
        throw new Error('Add at least one model name');
    }

    let id = (input.id ?? '').trim();
    if (!id) {
        const base = slugifyProviderName(name);
        id = base;
        for (let n = 2; existingIds.includes(id); n++) {
            id = `${base}-${n}`;
        }
    }

    return { id, name, baseUrl, apiKey: (input.apiKey ?? '').trim(), format, models };
}

export function customProviderToDefinition(custom: CustomProviderConfig): ProviderDefinition | undefined {
    try {
        return {
            id: `custom:${custom.id}`,
            label: custom.name,
            endPoint: normalizeEndpoint(custom.baseUrl, custom.format),
            format: custom.format === 'anthropic' || custom.format === 'local' ? custom.format : 'openai',
            apiKey: custom.apiKey ?? '',
            models: custom.models ?? [],
            isCustom: true
        };
    } catch {
        return undefined;
    }
}

/** Builtins followed by every valid custom provider. */
export function getAllProviders(customProviders: CustomProviderConfig[] = []): ProviderDefinition[] {
    const customs = customProviders
        .map(customProviderToDefinition)
        .filter((p): p is ProviderDefinition => p !== undefined);
    return [...PROVIDERS, ...customs];
}

export function getProvider(id: string, customProviders: CustomProviderConfig[] = []): ProviderDefinition | undefined {
    return getAllProviders(customProviders).find((provider) => provider.id === id);
}

/** Minimal view of configuration needed to resolve keys/providers (keeps this module vscode-free). */
export type ProviderConfigView = Partial<Record<BuiltinApiKeyConfigKey, string>> & {
    provider: ProviderSelection;
    customProviders: CustomProviderConfig[];
};

export function getProviderApiKey(provider: ProviderDefinition, config: ProviderConfigView): string {
    if (provider.apiKeyConfigKey) {
        return config[provider.apiKeyConfigKey] ?? '';
    }
    return provider.apiKey ?? '';
}

/**
 * Explicit selection: builtins need a key; custom providers may be keyless (e.g. a local Ollama server).
 * Auto: first builtin with a key (openrouter > groq > fireworks > gemini > anthropic), then first custom with a key.
 */
export function resolveActiveProvider(config: ProviderConfigView): ProviderDefinition | null {
    const all = getAllProviders(config.customProviders);
    if (config.provider !== 'auto') {
        const provider = all.find((p) => p.id === config.provider);
        if (!provider) {
            return null;
        }
        return provider.isCustom || getProviderApiKey(provider, config) ? provider : null;
    }
    return all.find((p) => getProviderApiKey(p, config)) ?? null;
}

/**
 * The single `textify.model` setting is shared across providers; fall back to the provider's first
 * model when the configured one obviously can't work there (e.g. a Qwen id sent to Anthropic).
 */
export function resolveModel(provider: ProviderDefinition, configuredModel: string): string {
    const model = (configuredModel ?? '').trim();
    if (provider.isCustom) {
        return provider.models.length > 0 && !provider.models.includes(model) ? provider.models[0] : model;
    }
    if (provider.id === 'anthropic' && !model.startsWith('claude-')) {
        return provider.models[0];
    }
    return model || provider.models[0];
}
