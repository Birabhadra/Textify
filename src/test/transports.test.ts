import * as assert from 'assert';
import {
	OpenAISseParser,
	anthropicTuningFor,
	streamAnthropic,
	streamOpenAICompatible,
	ModelRefusalError,
	TransportRequest
} from '../api/transports';
import { normalizeEndpoint } from '../api/providers';
import { percentiles } from '../utils/latencyTracker';
import { MockProviderServer, startMockProviderServer } from './mockProviderServer';

async function collect(gen: AsyncGenerator<string>): Promise<{ text: string; ttftMs: number; totalMs: number }> {
	const start = performance.now();
	let first = 0;
	let text = '';
	for await (const chunk of gen) {
		if (!first) { first = performance.now(); }
		text += chunk;
	}
	const end = performance.now();
	return { text, ttftMs: (first || end) - start, totalMs: end - start };
}

const messages = [
	{ role: 'system' as const, content: 'SYSTEM' },
	{ role: 'user' as const, content: 'USER' }
];

function request(server: MockProviderServer, format: 'openai' | 'anthropic', overrides: Partial<TransportRequest> = {}): TransportRequest {
	return {
		endpoint: normalizeEndpoint(`${server.baseUrl}/v1`, format),
		apiKey: 'test-key',
		model: format === 'anthropic' ? 'claude-opus-5' : 'qwen',
		messages,
		maxTokens: 500,
		temperature: 0.1,
		signal: new AbortController().signal,
		...overrides
	};
}

suite('OpenAI SSE parser', () => {
	test('handles chunk boundaries, CRLF, "data:" without a space, and [DONE]', () => {
		const parser = new OpenAISseParser();
		const line = (c: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`;
		const out = [
			...parser.push(line('ab').slice(0, 10)),
			...parser.push(line('ab').slice(10) + '\r\n\r\n'),
			...parser.push(`data:${JSON.stringify({ choices: [{ delta: { content: 'cd' } }] })}\n`),
			...parser.push(': keep-alive comment\n'),
			...parser.push('data: [DONE]\n' + line('ignored') + '\n')
		];
		assert.deepStrictEqual(out, ['ab', 'cd']);
		assert.strictEqual(parser.done, true);
	});

	test('surfaces in-stream error payloads', () => {
		const parser = new OpenAISseParser();
		assert.throws(() => parser.push('data: {"error":{"message":"rate limited"}}\n'), /rate limited/);
	});

	test('flushes a final line without a trailing newline', () => {
		const parser = new OpenAISseParser();
		assert.deepStrictEqual(parser.push('data: {"choices":[{"delta":{"content":"x"}}]}'), []);
		assert.deepStrictEqual(parser.end(), ['x']);
	});
});

suite('Anthropic request tuning', () => {
	test('Opus 5 / Sonnet 5: no temperature, low effort, headroom for thinking', () => {
		for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5-1']) {
			const t = anthropicTuningFor(model, 500, 0.1, true);
			assert.strictEqual(t.temperature, undefined, model);
			assert.strictEqual(t.effort, 'low', model);
			assert.ok(t.maxTokens >= 2048, model);
		}
	});

	test('Haiku 4.5 and older keep temperature and send no effort', () => {
		for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-3-5-haiku-latest']) {
			const t = anthropicTuningFor(model, 500, 0.2, true);
			assert.strictEqual(t.temperature, 0.2, model);
			assert.strictEqual(t.effort, undefined, model);
			assert.strictEqual(t.maxTokens, 500, model);
		}
	});

	test('server-side fallbacks only on the official API for models that support them', () => {
		assert.strictEqual(anthropicTuningFor('claude-opus-5', 500, 0, true).useFallbacks, true);
		assert.strictEqual(anthropicTuningFor('claude-opus-5', 500, 0, false).useFallbacks, false);
		assert.strictEqual(anthropicTuningFor('claude-sonnet-5', 500, 0, true).useFallbacks, false);
	});

	test('non-Claude models behind an Anthropic-compatible proxy keep temperature', () => {
		assert.strictEqual(anthropicTuningFor('kimi-k2', 500, 0.3, false).temperature, 0.3);
	});
});

suite('transports against a local mock provider', function () {
	this.timeout(20000);
	let server: MockProviderServer;

	setup(async () => {
		server = await startMockProviderServer({ responseText: 'Math.min(max, Math.max(min, value));' });
	});
	teardown(async () => {
		await server.close();
	});

	test('OpenAI-compatible: streams text and sends the expected request', async () => {
		const result = await collect(streamOpenAICompatible(request(server, 'openai', { extraBody: { reasoning_effort: 'none' } })));
		assert.strictEqual(result.text, 'Math.min(max, Math.max(min, value));');
		const sent = server.requests[0];
		assert.strictEqual(sent.url, '/v1/chat/completions');
		assert.strictEqual(sent.headers.authorization, 'Bearer test-key');
		assert.strictEqual(sent.body.stream, true);
		assert.strictEqual(sent.body.temperature, 0.1);
		assert.strictEqual(sent.body.reasoning_effort, 'none');
	});

	test('OpenAI-compatible: keyless custom providers send no Authorization header', async () => {
		await collect(streamOpenAICompatible(request(server, 'openai', { apiKey: '' })));
		assert.strictEqual(server.requests[0].headers.authorization, undefined);
	});

	test('OpenAI-compatible: HTTP errors are reported with status and body', async () => {
		server.options.failWith = { status: 401, body: '{"error":"bad key"}' };
		await assert.rejects(collect(streamOpenAICompatible(request(server, 'openai'))), /401.*bad key/);
	});

	test('Anthropic: streams text via the SDK with cached system prompt and tuned params', async () => {
		const result = await collect(streamAnthropic(request(server, 'anthropic')));
		assert.strictEqual(result.text, 'Math.min(max, Math.max(min, value));');
		const sent = server.requests[0];
		assert.strictEqual(new URL(sent.url, 'http://x').pathname, '/v1/messages');
		assert.strictEqual(sent.headers['x-api-key'], 'test-key');
		assert.ok(sent.headers['anthropic-version']);
		assert.deepStrictEqual(sent.body.system, [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
		assert.deepStrictEqual(sent.body.messages, [{ role: 'user', content: 'USER' }]);
		assert.strictEqual(sent.body.temperature, undefined, 'Opus 5 rejects temperature');
		assert.deepStrictEqual(sent.body.output_config, { effort: 'low' });
		assert.strictEqual(sent.body.fallbacks, undefined, 'fallbacks only on the official endpoint');
		assert.strictEqual(sent.headers['anthropic-beta'], undefined);
	});

	test('Anthropic: a refusal discards the completion', async () => {
		server.options.stopReason = 'refusal';
		await assert.rejects(collect(streamAnthropic(request(server, 'anthropic'))), ModelRefusalError);
	});

	test('Anthropic: API errors propagate without retries', async () => {
		server.options.failWith = { status: 529, body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' };
		await assert.rejects(collect(streamAnthropic(request(server, 'anthropic'))), /529|Overloaded/);
		assert.strictEqual(server.requests.length, 1, 'maxRetries: 0');
	});

	test('abort stops an in-flight stream', async () => {
		server.options.firstTokenDelayMs = 2000;
		const controller = new AbortController();
		const started = performance.now();
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(collect(streamOpenAICompatible(request(server, 'openai', { signal: controller.signal }))));
		assert.ok(performance.now() - started < 1500, 'aborted promptly');
	});

	test('latency: sequential requests reuse one pooled connection and add little overhead', async () => {
		server.options.firstTokenDelayMs = 40;
		const ttfts: number[] = [];
		for (let i = 0; i < 6; i++) {
			ttfts.push((await collect(streamOpenAICompatible(request(server, 'openai')))).ttftMs);
		}
		for (let i = 0; i < 6; i++) {
			ttfts.push((await collect(streamAnthropic(request(server, 'anthropic')))).ttftMs);
		}
		const stats = percentiles(ttfts);
		console.log(`      mock TTFT with 40ms server delay: p50=${stats.p50}ms p90=${stats.p90}ms max=${stats.max}ms, connections=${server.connections()}`);
		assert.ok(server.connections() <= 2, `expected pooled connections, got ${server.connections()}`);
		assert.ok(stats.p50 < 40 + 60, `client overhead too high: p50 ${stats.p50}ms`);
	});
});

suite('latency percentiles', () => {
	test('computes nearest-rank percentiles', () => {
		assert.deepStrictEqual(percentiles([]), { p50: 0, p90: 0, max: 0 });
		assert.deepStrictEqual(percentiles([5]), { p50: 5, p90: 5, max: 5 });
		assert.deepStrictEqual(percentiles([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), { p50: 5, p90: 9, max: 10 });
	});
});
