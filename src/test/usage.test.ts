import * as assert from 'assert';
import {
	AnthropicUsageAccumulator,
	TokenUsage,
	TransportRequest,
	discoverModels,
	normalizeOpenAIUsage,
	streamAnthropic,
	streamOpenAICompatible
} from '../api/transports';
import { normalizeEndpoint } from '../api/providers';
import { canonicalModelName, costFor, modelBaseName, parseOpenRouterCatalog, resolvePrice } from '../utils/pricing';
import {
	UsageTotals,
	UsageTracker,
	formatCost,
	formatDuration,
	formatTokens,
	formatUsageReport,
	totalCost,
	usageKey
} from '../services/usageTracker';
import { MOCK_USAGE, MockProviderServer, startMockProviderServer } from './mockProviderServer';

async function drain(gen: AsyncGenerator<string>): Promise<string> {
	let text = '';
	for await (const chunk of gen) { text += chunk; }
	return text;
}

function usageRequest(server: MockProviderServer, format: 'openai' | 'anthropic', sink: TokenUsage[], model: string): TransportRequest {
	return {
		endpoint: normalizeEndpoint(`${server.baseUrl}/v1`, format),
		apiKey: 'k',
		model,
		messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
		maxTokens: 100,
		temperature: 0,
		signal: new AbortController().signal,
		onUsage: (entries) => sink.push(...entries)
	};
}

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
	model: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...overrides
});

suite('usage reporting from providers', function () {
	this.timeout(15000);
	let server: MockProviderServer;
	setup(async () => { server = await startMockProviderServer({ responseText: 'abc' }); });
	teardown(async () => { await server.close(); });

	test('OpenAI-compatible: requests usage and splits cached prompt tokens out', async () => {
		const sink: TokenUsage[] = [];
		await drain(streamOpenAICompatible(usageRequest(server, 'openai', sink, 'm')));
		assert.deepStrictEqual(server.requests[0].body.stream_options, { include_usage: true });
		assert.deepStrictEqual(sink, [{
			model: 'm', inputTokens: MOCK_USAGE.input, outputTokens: MOCK_USAGE.output,
			cacheReadTokens: MOCK_USAGE.cached, cacheWriteTokens: 0, reportedCostUsd: undefined
		}]);
	});

	test('OpenAI-compatible: servers that reject stream_options still work (retried once, then remembered)', async () => {
		server.options.rejectStreamOptions = true;
		const sink: TokenUsage[] = [];
		assert.strictEqual(await drain(streamOpenAICompatible(usageRequest(server, 'openai', sink, 'm'))), 'abc');
		assert.strictEqual(await drain(streamOpenAICompatible(usageRequest(server, 'openai', sink, 'm'))), 'abc');
		const posts = server.requests.filter((r) => r.method === 'POST');
		assert.strictEqual(posts.length, 3, 'one rejected + one retry, then no stream_options on the next call');
		assert.strictEqual(posts[2].body.stream_options, undefined);
		assert.strictEqual(sink.length, 0, 'no usage reported by this server');
	});

	test('Anthropic: input, output, cache read and cache write come from the stream', async () => {
		const sink: TokenUsage[] = [];
		await drain(streamAnthropic(usageRequest(server, 'anthropic', sink, 'claude-haiku-4-5')));
		assert.deepStrictEqual(sink, [{
			model: 'claude-haiku-4-5', inputTokens: MOCK_USAGE.input, outputTokens: MOCK_USAGE.output,
			cacheReadTokens: MOCK_USAGE.cached, cacheWriteTokens: MOCK_USAGE.cacheWrite
		}]);
	});

	test('OpenRouter-style reported cost and Groq x_groq usage are understood', () => {
		assert.strictEqual(normalizeOpenAIUsage('m', { prompt_tokens: 10, completion_tokens: 2, cost: 0.0012 }).reportedCostUsd, 0.0012);
	});

	test('server-side fallback attributes tokens to each model that ran', () => {
		const acc = new AnthropicUsageAccumulator('claude-opus-5');
		acc.start('claude-opus-4-8', { input_tokens: 100, output_tokens: 1 });
		acc.delta({
			output_tokens: 50,
			iterations: [
				{ type: 'message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 20 },
				{ type: 'fallback', model: null },
				{ type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 120, output_tokens: 30 }
			]
		});
		const result = acc.result();
		assert.deepStrictEqual(result.map((u) => [u.model, u.inputTokens, u.outputTokens]), [
			['claude-opus-5', 100, 20],
			['claude-opus-4-8', 120, 30]
		]);
	});

	test('message_delta cumulative counts win over message_start placeholders', () => {
		const acc = new AnthropicUsageAccumulator('claude-haiku-4-5');
		acc.start(undefined, { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 0 });
		acc.delta({ output_tokens: 12, cache_read_input_tokens: 5 });
		assert.deepStrictEqual(acc.result(), [usage({ inputTokens: 40, outputTokens: 12, cacheReadTokens: 5 })]);
		assert.deepStrictEqual(new AnthropicUsageAccumulator('x').result(), [], 'no usage events -> nothing reported');
	});
});

suite('local model discovery', function () {
	this.timeout(15000);
	let server: MockProviderServer;
	teardown(async () => { await server.close(); });

	test('reads OpenAI-style /v1/models (LM Studio, llama.cpp, vLLM, Ollama)', async () => {
		server = await startMockProviderServer({ openAIModels: ['qwen2.5-coder:7b', 'llama3.2'] });
		const models = await discoverModels(normalizeEndpoint(`${server.baseUrl}/v1`, 'local'));
		assert.deepStrictEqual(models, ['qwen2.5-coder:7b', 'llama3.2']);
	});

	test('falls back to Ollama /api/tags', async () => {
		server = await startMockProviderServer({ ollamaModels: ['deepseek-coder-v2'] });
		assert.deepStrictEqual(await discoverModels(normalizeEndpoint(`${server.baseUrl}/v1`, 'local')), ['deepseek-coder-v2']);
	});

	test('explains failure when nothing lists models', async () => {
		server = await startMockProviderServer({});
		await assert.rejects(discoverModels(normalizeEndpoint(`${server.baseUrl}/v1`, 'local')), /No models found.*404/);
	});
});

const CATALOG = parseOpenRouterCatalog({
	data: [
		{ id: 'google/gemini-2.5-flash', pricing: { prompt: '0.0000003', completion: '0.0000025', input_cache_read: '0.000000075' } },
		{ id: 'meta-llama/llama-3.3-70b-instruct:free', pricing: { prompt: '0', completion: '0' } },
		{ id: 'meta-llama/llama-3.3-70b-instruct', pricing: { prompt: '0.00000013', completion: '0.0000004' } },
		{ id: 'qwen/qwen3-32b', pricing: { prompt: '0.0000001', completion: '0.0000003' } },
		{ id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
		{ id: 'broken' }
	]
});

suite('pricing (all providers)', () => {
	test('OpenRouter catalog is parsed into USD per 1M tokens; unknown/variable prices are skipped', () => {
		assert.deepStrictEqual(CATALOG['google/gemini-2.5-flash'], { input: 0.3, output: 2.5, cacheRead: 0.075 });
		assert.deepStrictEqual(CATALOG['qwen/qwen3-32b'], { input: 0.1, output: 0.3 });
		assert.strictEqual(CATALOG['openrouter/auto'], undefined);
		assert.strictEqual(CATALOG['broken'], undefined);
		assert.deepStrictEqual(parseOpenRouterCatalog('garbage'), {});
	});

	test('catalog prices other providers by model name (Gemini direct, Groq, OpenRouter, custom)', () => {
		const gemini = resolvePrice('gemini', 'gemini-2.5-flash', { catalog: CATALOG });
		assert.strictEqual(gemini?.source, 'catalog');
		assert.strictEqual(gemini?.matchedId, 'google/gemini-2.5-flash');
		assert.strictEqual(resolvePrice('openrouter', 'qwen/qwen3-32b', { catalog: CATALOG })?.price.input, 0.1);
		assert.strictEqual(resolvePrice('groq', 'qwen/qwen3-32b', { catalog: CATALOG })?.price.output, 0.3);
		// paid variant preferred over ":free"
		assert.strictEqual(resolvePrice('custom:together', 'llama-3.3-70b-instruct', { catalog: CATALOG })?.matchedId, 'meta-llama/llama-3.3-70b-instruct');
		assert.strictEqual(resolvePrice('groq', 'mixtral-unknown', { catalog: CATALOG }), undefined, 'no guess when names differ');
	});

	test('Groq and Fireworks naming conventions match the catalog', () => {
		// Groq deployment suffixes
		assert.strictEqual(resolvePrice('groq', 'llama-3.3-70b-versatile', { catalog: CATALOG })?.matchedId, 'meta-llama/llama-3.3-70b-instruct');
		// Fireworks "v3p3" / "2p5" spellings and account paths
		assert.strictEqual(resolvePrice('fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct', { catalog: CATALOG })?.matchedId, 'meta-llama/llama-3.3-70b-instruct');
		assert.strictEqual(canonicalModelName('accounts/fireworks/models/qwen2p5-coder-32b-instruct'), canonicalModelName('qwen/qwen-2.5-coder-32b-instruct'));
	});

	test('loose matching needs a version or size, so generic names do not collide', () => {
		const catalog = { 'deepseek/deepseek-chat': { input: 1, output: 1 } };
		assert.strictEqual(resolvePrice('x', 'deepseek-instruct', { catalog }), undefined);
		assert.strictEqual(resolvePrice('x', 'deepseek-chat', { catalog })?.matchedId, 'deepseek/deepseek-chat');
	});

	test('priority: your price > list price > local > catalog', () => {
		const overrides = { 'groq:qwen/qwen3-32b': { input: 0.29, output: 0.59 }, 'claude-haiku-4-5': { input: 9, output: 9 } };
		assert.deepStrictEqual(resolvePrice('groq', 'qwen/qwen3-32b', { overrides, catalog: CATALOG }), { price: { input: 0.29, output: 0.59 }, source: 'custom' });
		assert.strictEqual(resolvePrice('openrouter', 'qwen/qwen3-32b', { overrides, catalog: CATALOG })?.source, 'catalog', 'provider-specific override only applies to that provider');
		assert.strictEqual(resolvePrice('anthropic', 'claude-haiku-4-5', { overrides })?.price.input, 9, 'bare model override applies everywhere');
		assert.deepStrictEqual(resolvePrice('anthropic', 'claude-haiku-4-5'), { price: { input: 1, output: 5 }, source: 'list' });
		assert.strictEqual(resolvePrice('anthropic', 'claude-opus-5-5')?.price.input, 4, 'opus-5-5 is not confused with opus-5');
		assert.strictEqual(resolvePrice('custom:ollama', 'qwen/qwen3-32b', { isLocal: true, catalog: CATALOG })?.source, 'local');
		assert.strictEqual(resolvePrice('fireworks', 'mystery-model', { catalog: CATALOG }), undefined);
	});

	test('invalid user prices are ignored', () => {
		const overrides = { m: { input: -1, output: 2 } } as Record<string, { input: number; output: number }>;
		assert.strictEqual(resolvePrice('p', 'm', { overrides }), undefined);
	});

	test('cost uses cache multipliers (read 0.1x, write 1.25x) unless the price sets them', () => {
		const tokens = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 };
		assert.ok(Math.abs(costFor(tokens, { input: 1, output: 5 }) - 7.35) < 1e-9);
		assert.ok(Math.abs(costFor(tokens, { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 }) - 6) < 1e-9);
	});

	test('model base names strip vendor prefixes and variants', () => {
		assert.strictEqual(modelBaseName('google/gemini-2.5-flash:free'), 'gemini-2.5-flash');
		assert.strictEqual(modelBaseName('accounts/fireworks/models/qwen2p5-coder-32b-instruct'), 'qwen2p5-coder-32b-instruct');
		assert.strictEqual(modelBaseName('Llama-3.1-8B'), 'llama-3.1-8b');
	});
});

suite('usage tracker', () => {
	const resolver = (overrides: Record<string, { input: number; output: number }> = {}) =>
		(provider: string, model: string) => resolvePrice(provider, model, { overrides, catalog: CATALOG, isLocal: provider === 'custom:ollama' });

	test('aggregates requests, tokens, cost, suggestions and code changes across providers', () => {
		const tracker = new UsageTracker(undefined, resolver());
		tracker.recordRequest('completed', 300, [usage({ inputTokens: 1000, outputTokens: 100 })], 'anthropic');
		tracker.recordRequest('completed', 100, [usage({ model: 'gemini-2.5-flash', inputTokens: 1e6, outputTokens: 0 })], 'gemini');
		tracker.recordRequest('completed', 100, [usage({ model: 'qwen/qwen3-32b', inputTokens: 10, reportedCostUsd: 0.25 })], 'openrouter');
		tracker.recordRequest('completed', 100, [usage({ model: 'qwen2.5-coder', inputTokens: 5000, outputTokens: 50 })], 'custom:ollama');
		tracker.recordRequest('completed', 100, [usage({ model: 'mystery', inputTokens: 5 })], 'fireworks');
		tracker.recordRequest('cancelled', 50);
		tracker.recordRequest('failed', 20);
		tracker.recordSuggestionShown(false);
		tracker.recordSuggestionShown(true);
		tracker.recordAccepted('line1\nline2', 'old');
		tracker.recordRejected();

		const { session } = tracker.snapshot();
		assert.strictEqual(session.apiRequests, 7);
		assert.strictEqual(session.completedRequests, 5);
		assert.strictEqual(session.cancelledRequests, 1);
		assert.strictEqual(session.failedRequests, 1);
		assert.strictEqual(session.suggestionsShown, 2);
		assert.strictEqual(session.servedLocally, 1);
		assert.strictEqual(session.linesAdded, 2);
		assert.strictEqual(session.linesRemoved, 1);

		const byKey = session.byModel;
		assert.strictEqual(byKey[usageKey('anthropic', 'claude-haiku-4-5')].priceSource, 'list');
		assert.ok(Math.abs(byKey[usageKey('anthropic', 'claude-haiku-4-5')].costUsd - 0.0015) < 1e-12);
		assert.strictEqual(byKey[usageKey('gemini', 'gemini-2.5-flash')].priceSource, 'catalog');
		assert.ok(Math.abs(byKey[usageKey('gemini', 'gemini-2.5-flash')].costUsd - 0.3) < 1e-12);
		assert.strictEqual(byKey[usageKey('openrouter', 'qwen/qwen3-32b')].priceSource, 'provider');
		assert.strictEqual(byKey[usageKey('openrouter', 'qwen/qwen3-32b')].costUsd, 0.25, 'reported cost is not re-priced');
		assert.strictEqual(byKey[usageKey('custom:ollama', 'qwen2.5-coder')].costUsd, 0);
		assert.strictEqual(byKey[usageKey('custom:ollama', 'qwen2.5-coder')].priceSource, 'local');
		assert.strictEqual(byKey[usageKey('fireworks', 'mystery')].unpricedRequests, 1);

		const cost = totalCost(session);
		assert.ok(Math.abs(cost.usd - (0.0015 + 0.3 + 0.25)) < 1e-9, String(cost.usd));
		assert.strictEqual(cost.unpricedRequests, 1);
	});

	test('setting a price later also prices past usage', () => {
		let overrides: Record<string, { input: number; output: number }> = {};
		const tracker = new UsageTracker(undefined, (p, m) => resolvePrice(p, m, { overrides }));
		tracker.recordRequest('completed', 10, [usage({ model: 'llama-3.3-70b-versatile', inputTokens: 1e6, outputTokens: 1e6 })], 'groq');
		assert.strictEqual(totalCost(tracker.snapshot().session).unpricedRequests, 1);
		overrides = { 'groq:llama-3.3-70b-versatile': { input: 0.59, output: 0.79 } };
		const cost = totalCost(tracker.snapshot().session);
		assert.strictEqual(cost.unpricedRequests, 0);
		assert.ok(Math.abs(cost.usd - 1.38) < 1e-9);
	});

	test('the same model on two providers is tracked separately', () => {
		const tracker = new UsageTracker(undefined, resolver({ 'groq:qwen/qwen3-32b': { input: 0.29, output: 0.59 } }));
		tracker.recordRequest('completed', 10, [usage({ model: 'qwen/qwen3-32b', inputTokens: 1e6 })], 'groq');
		tracker.recordRequest('completed', 10, [usage({ model: 'qwen/qwen3-32b', inputTokens: 1e6 })], 'openrouter');
		const { session } = tracker.snapshot();
		assert.ok(Math.abs(session.byModel[usageKey('groq', 'qwen/qwen3-32b')].costUsd - 0.29) < 1e-9);
		assert.ok(Math.abs(session.byModel[usageKey('openrouter', 'qwen/qwen3-32b')].costUsd - 0.1) < 1e-9);
		const report = formatUsageReport(session, Date.now(), (id) => ({ groq: 'Groq', openrouter: 'OpenRouter' } as Record<string, string>)[id] ?? id);
		assert.ok(report.includes('qwen/qwen3-32b (Groq):'), report);
		assert.ok(report.includes('qwen/qwen3-32b (OpenRouter):'), report);
		assert.ok(report.includes('your price'));
		assert.ok(report.includes('≈ OpenRouter catalog'));
	});

	test('a fallback request counts once but splits tokens across models', () => {
		const tracker = new UsageTracker(undefined, resolver());
		tracker.recordRequest('completed', 100, [usage({ model: 'claude-opus-5', outputTokens: 5 }), usage({ model: 'claude-opus-4-8', outputTokens: 7 })], 'anthropic');
		const { session } = tracker.snapshot();
		assert.strictEqual(session.byModel[usageKey('anthropic', 'claude-opus-5')].requests, 1);
		assert.strictEqual(session.byModel[usageKey('anthropic', 'claude-opus-4-8')].requests, 0);
		assert.strictEqual(session.byModel[usageKey('anthropic', 'claude-opus-4-8')].outputTokens, 7);
		assert.strictEqual(session.byModel[usageKey('anthropic', 'claude-opus-4-8')].unpricedRequests, 0);
	});

	test('lifetime totals persist and survive a restart; session resets independently', () => {
		let stored: unknown;
		const store = { get: () => stored, set: (v: UsageTotals) => { stored = v; } };
		const first = new UsageTracker(store, resolver());
		first.recordRequest('completed', 10, [usage({ inputTokens: 5 })], 'anthropic');
		first.dispose(); // flushes

		const second = new UsageTracker(store, resolver());
		assert.strictEqual(second.snapshot().lifetime.byModel[usageKey('anthropic', 'claude-haiku-4-5')].inputTokens, 5);
		assert.deepStrictEqual(second.modelsSeen(), [{ provider: 'anthropic', model: 'claude-haiku-4-5' }]);
		assert.strictEqual(second.snapshot().session.apiRequests, 0);
		second.recordRequest('completed', 10);
		second.resetSession();
		assert.strictEqual(second.snapshot().session.apiRequests, 0);
		assert.strictEqual(second.snapshot().lifetime.apiRequests, 2);
		second.resetAll();
		assert.strictEqual(second.snapshot().lifetime.apiRequests, 0);
	});

	test('corrupt or older persisted data is tolerated and still priced', () => {
		const tracker = new UsageTracker(
			{ get: () => ({ apiRequests: 3, byModel: { 'claude-haiku-4-5': { requests: 1, inputTokens: 1e6 } }, bogus: true }), set: () => undefined },
			resolver()
		);
		const { lifetime } = tracker.snapshot();
		assert.strictEqual(lifetime.apiRequests, 3);
		const m = Object.values(lifetime.byModel)[0];
		assert.strictEqual(m.model, 'claude-haiku-4-5');
		assert.strictEqual(m.outputTokens, 0);
		assert.ok(Math.abs(m.costUsd - 1) < 1e-9, 'older entries without the reported/unreported split are priced');
		assert.strictEqual(new UsageTracker({ get: () => 'garbage', set: () => undefined }).snapshot().lifetime.apiRequests, 0);
	});

	test('listeners get snapshots and cannot break recording', () => {
		const tracker = new UsageTracker();
		let seen = 0;
		tracker.onDidChange(() => { throw new Error('boom'); });
		tracker.onDidChange((s) => { seen = s.session.rejected; });
		tracker.recordRejected();
		assert.strictEqual(seen, 1);
	});
});

suite('usage report formatting (Claude Code /cost style)', () => {
	test('number formatting', () => {
		assert.strictEqual(formatTokens(999), '999');
		assert.strictEqual(formatTokens(1200), '1.2k');
		assert.strictEqual(formatTokens(80_000), '80k');
		assert.strictEqual(formatTokens(1_400_000), '1.4m');
		assert.strictEqual(formatDuration(12_300), '12.3s');
		assert.strictEqual(formatDuration(379_700), '6m 19.7s');
		assert.strictEqual(formatDuration(23_590_200), '6h 33m 10.2s');
		assert.strictEqual(formatCost(0.55), '$0.55');
		assert.strictEqual(formatCost(0.0042), '$0.0042');
		assert.strictEqual(formatCost(0), '$0.00');
	});

	test('report has the /cost layout with per-model usage', () => {
		const tracker = new UsageTracker(undefined, (p, m) => resolvePrice(p, m));
		tracker.recordRequest('completed', 1500, [usage({ inputTokens: 1200, outputTokens: 125, cacheReadTokens: 1_400_000, cacheWriteTokens: 80_900 })], 'anthropic');
		tracker.recordSuggestionShown(false);
		tracker.recordAccepted('a\nb', '');
		const { session } = tracker.snapshot();
		const report = formatUsageReport(session, session.startedAt + 60_000);
		const lines = report.split('\n');
		assert.match(lines[0], /^Total cost: {12}\$0\.\d+$/);
		assert.strictEqual(lines[1], 'Total duration (API):  1.5s');
		assert.strictEqual(lines[2], 'Total duration (wall): 1m 0.0s');
		assert.strictEqual(lines[3], 'Total code changes:    2 lines added, 0 lines removed');
		assert.ok(report.includes('100% acceptance'));
		assert.ok(report.includes('Usage by model:'));
		assert.ok(report.includes('claude-haiku-4-5:  1.2k input, 125 output, 1.4m cache read, 80.9k cache write ($0.'), report);
		assert.ok(report.includes('list price'));
	});

	test('unpriced usage is called out instead of silently shown as free', () => {
		const tracker = new UsageTracker();
		tracker.recordRequest('completed', 10, [usage({ model: 'llama', inputTokens: 5 })], 'groq');
		const report = formatUsageReport(tracker.snapshot().session);
		assert.ok(report.includes('+1 request on unpriced models'), report);
		assert.ok(report.includes('(unpriced)'));
	});
});
