export type ApiProvider = 'openrouter' | 'groq' | 'fireworks' | 'gemini';
export type ProviderSelection = 'auto' | ApiProvider;

export interface ProviderDefinition {
    id: ApiProvider;
    label: string;
    endPoint: string;
    apiKeyConfigKey: 'openrouterApiKey' | 'groqApiKey' | 'fireworksApiKey' | 'geminiApiKey';
    models: string[];
    extraBodyFields?: () => Record<string, unknown>;
}

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
    }
];

export function getProvider(id: ApiProvider): ProviderDefinition | undefined {
    return PROVIDERS.find((provider) => provider.id === id);
}
