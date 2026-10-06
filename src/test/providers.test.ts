import * as assert from 'assert';
import {
	PROVIDERS,
	getProvider,
	normalizeEndpoint,
	sanitizeCustomProvider,
	resolveActiveProvider,
	resolveModel,
	getAllProviders,
	CustomProviderConfig,
	ProviderConfigView
} from '../api/providers';

const custom = (overrides: Partial<CustomProviderConfig> = {}): CustomProviderConfig => ({
	id: 'together',
	name: 'Together',
	baseUrl: 'https://api.together.xyz/v1',
	apiKey: 'tk',
	format: 'openai',
	models: ['qwen-coder'],
	...overrides
});

const view = (overrides: Partial<ProviderConfigView> = {}): ProviderConfigView => ({
	provider: 'auto',
	customProviders: [],
	...overrides
});

suite('providers registry', () => {
	test('every provider has a unique id, endpoint, api key, and at least one model', () => {
		const ids = new Set<string>();
		for (const provider of PROVIDERS) {
			assert.ok(provider.endPoint.startsWith('https://'));
			assert.ok(provider.apiKeyConfigKey!.endsWith('ApiKey'));
			assert.ok(provider.models.length > 0);
			assert.ok(!ids.has(provider.id));
			ids.add(provider.id);
		}
	});

	test('getProvider resolves known ids and is undefined for unknown ones', () => {
		assert.strictEqual(getProvider('groq')?.label, 'Groq');
		assert.strictEqual(getProvider('unknown'), undefined);
	});

	test('groq is the only provider with extra body fields today', () => {
		const withExtra = PROVIDERS.filter((provider) => provider.extraBodyFields);
		assert.strictEqual(withExtra.length, 1);
		assert.strictEqual(withExtra[0].id, 'groq');
		assert.deepStrictEqual(withExtra[0].extraBodyFields!(), { reasoning_effort: 'none' });
	});

	test('anthropic is registered with the Messages API format and Claude models', () => {
		const anthropic = getProvider('anthropic')!;
		assert.strictEqual(anthropic.format, 'anthropic');
		assert.strictEqual(anthropic.apiKeyConfigKey, 'anthropicApiKey');
		assert.ok(anthropic.models.every((m) => m.startsWith('claude-')));
	});

	test('existing providers default to the OpenAI-compatible format', () => {
		for (const id of ['openrouter', 'groq', 'fireworks', 'gemini']) {
			assert.strictEqual(getProvider(id)!.format ?? 'openai', 'openai');
		}
	});
});

suite('custom provider URLs', () => {
	test('openai format appends /chat/completions to a base URL', () => {
		assert.strictEqual(normalizeEndpoint('https://api.together.xyz/v1', 'openai'), 'https://api.together.xyz/v1/chat/completions');
		assert.strictEqual(normalizeEndpoint('http://localhost:11434/v1/', 'openai'), 'http://localhost:11434/v1/chat/completions');
	});

	test('openai format keeps a full endpoint and query string', () => {
		assert.strictEqual(normalizeEndpoint('https://x.io/v1/chat/completions', 'openai'), 'https://x.io/v1/chat/completions');
		assert.strictEqual(
			normalizeEndpoint('https://r.openai.azure.com/openai/deployments/d?api-version=2024-10-21', 'openai'),
			'https://r.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-10-21'
		);
	});

	test('anthropic format strips /v1 and /v1/messages so the SDK can append them', () => {
		assert.strictEqual(normalizeEndpoint('https://proxy.example.com/v1/messages', 'anthropic'), 'https://proxy.example.com');
		assert.strictEqual(normalizeEndpoint('https://proxy.example.com/v1', 'anthropic'), 'https://proxy.example.com');
		assert.strictEqual(normalizeEndpoint('https://gw.example.com/anthropic/', 'anthropic'), 'https://gw.example.com/anthropic');
	});

	test('local format behaves like OpenAI-compatible for URLs', () => {
		assert.strictEqual(normalizeEndpoint('http://localhost:11434/v1', 'local'), 'http://localhost:11434/v1/chat/completions');
		assert.strictEqual(normalizeEndpoint('http://127.0.0.1:1234/v1/chat/completions', 'local'), 'http://127.0.0.1:1234/v1/chat/completions');
	});

	test('rejects non-http URLs and garbage', () => {
		assert.throws(() => normalizeEndpoint('ftp://x.io', 'openai'), /http/);
		assert.throws(() => normalizeEndpoint('not a url', 'openai'), /Invalid URL/);
		assert.throws(() => normalizeEndpoint('', 'anthropic'), /Invalid URL/);
	});
});

suite('custom provider validation', () => {
	test('generates a unique slug id and trims/dedupes models', () => {
		const result = sanitizeCustomProvider({ name: 'My Proxy', baseUrl: 'https://p.io/v1', models: [' a ', 'a', '', 'b'] }, ['my-proxy']);
		assert.strictEqual(result.id, 'my-proxy-2');
		assert.deepStrictEqual(result.models, ['a', 'b']);
		assert.strictEqual(result.format, 'openai');
		assert.strictEqual(result.apiKey, '');
	});

	test('local format is kept and needs no API key', () => {
		const local = sanitizeCustomProvider({ name: 'Ollama', format: 'local', baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5-coder'] });
		assert.strictEqual(local.format, 'local');
		assert.strictEqual(local.apiKey, '');
		const resolved = resolveActiveProvider(view({ provider: 'custom:ollama', customProviders: [local] }));
		assert.strictEqual(resolved?.format, 'local');
	});

	test('keeps an existing id when editing', () => {
		assert.strictEqual(sanitizeCustomProvider(custom({ id: 'keep-me' })).id, 'keep-me');
	});

	test('requires name, a valid URL and at least one model', () => {
		assert.throws(() => sanitizeCustomProvider(custom({ name: ' ' })), /name/);
		assert.throws(() => sanitizeCustomProvider(custom({ baseUrl: 'nope' })), /URL/);
		assert.throws(() => sanitizeCustomProvider(custom({ models: [] })), /model/);
	});

	test('invalid stored custom providers are skipped rather than breaking the list', () => {
		const all = getAllProviders([custom(), custom({ id: 'broken', baseUrl: 'nope' })]);
		assert.strictEqual(all.length, PROVIDERS.length + 1);
		assert.strictEqual(all[all.length - 1].id, 'custom:together');
	});
});

suite('active provider resolution', () => {
	test('auto keeps the documented builtin priority, then custom providers', () => {
		assert.strictEqual(resolveActiveProvider(view({ groqApiKey: 'g', anthropicApiKey: 'a' }))?.id, 'groq');
		assert.strictEqual(resolveActiveProvider(view({ anthropicApiKey: 'a' }))?.id, 'anthropic');
		assert.strictEqual(resolveActiveProvider(view({ customProviders: [custom()] }))?.id, 'custom:together');
		assert.strictEqual(resolveActiveProvider(view()), null);
	});

	test('auto skips keyless custom providers', () => {
		assert.strictEqual(resolveActiveProvider(view({ customProviders: [custom({ apiKey: '' })] })), null);
	});

	test('explicit selection: builtins need a key, custom providers may be keyless (local servers)', () => {
		assert.strictEqual(resolveActiveProvider(view({ provider: 'anthropic' })), null);
		assert.strictEqual(resolveActiveProvider(view({ provider: 'anthropic', anthropicApiKey: 'a' }))?.id, 'anthropic');
		const local = custom({ id: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1' });
		const resolved = resolveActiveProvider(view({ provider: 'custom:ollama', customProviders: [local] }));
		assert.strictEqual(resolved?.endPoint, 'http://localhost:11434/v1/chat/completions');
	});

	test('explicit selection of a deleted custom provider resolves to nothing', () => {
		assert.strictEqual(resolveActiveProvider(view({ provider: 'custom:gone', openrouterApiKey: 'o' })), null);
	});

	test('model falls back to a provider default when the shared setting cannot work there', () => {
		const anthropic = getProvider('anthropic')!;
		assert.strictEqual(resolveModel(anthropic, 'qwen/qwen3-32b'), 'claude-opus-5');
		assert.strictEqual(resolveModel(anthropic, 'claude-haiku-4-5'), 'claude-haiku-4-5');
		const together = getProvider('custom:together', [custom()])!;
		assert.strictEqual(resolveModel(together, 'qwen/qwen3-32b'), 'qwen-coder');
		// builtin OpenAI-compatible providers accept any typed model id
		assert.strictEqual(resolveModel(getProvider('openrouter')!, 'some/new-model'), 'some/new-model');
	});
});
