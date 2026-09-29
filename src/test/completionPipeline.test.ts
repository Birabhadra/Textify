import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { InlineCompletionProvider } from '../providers/inlineCompletionProvider';
import { ASTService } from '../services/astService';
import { InstructionsService } from '../services/instructionsService';
import { ContextGatherer } from '../services/contextGatherer';
import { IntentTracker } from '../services/intentTracker';
import { PromptBuilder } from '../services/promptBuilder';
import { latencyTracker } from '../utils/latencyTracker';
import { MOCK_USAGE, MockProviderServer, startMockProviderServer } from './mockProviderServer';
import { formatUsageReport, UsageTracker, usageKey } from '../services/usageTracker';
import { resolvePrice } from '../utils/pricing';

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS = ['customProviders', 'provider', 'customInstructions', 'debounceMs', 'systemPromptMode'];

async function setSetting(key: string, value: unknown): Promise<void> {
	await vscode.workspace.getConfiguration('textify').update(key, value, vscode.ConfigurationTarget.Global);
}

async function useMockProvider(server: MockProviderServer, format: 'openai' | 'anthropic', model: string): Promise<void> {
	await setSetting('customProviders', [{
		id: 'mock', name: 'Mock', baseUrl: `${server.baseUrl}/v1`, apiKey: '', format, models: [model]
	}]);
	await setSetting('provider', 'custom:mock');
}

function completionContext(): vscode.InlineCompletionContext {
	return { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined } as unknown as vscode.InlineCompletionContext;
}

suite('completion pipeline (end to end against mock provider)', function () {
	this.timeout(30000);
	let server: MockProviderServer;
	let astService: ASTService;
	let instructions: InstructionsService;
	let output: vscode.OutputChannel;

	suiteSetup(async () => {
		astService = new ASTService(EXTENSION_ROOT);
		await astService.initialize();
		output = vscode.window.createOutputChannel('Textify test');
	});

	setup(async () => {
		server = await startMockProviderServer({ responseText: 'Math.min(max, Math.max(min, value));', firstTokenDelayMs: 30 });
		await setSetting('debounceMs', 0);
		await setSetting('customInstructions', 'Always prefer Math helpers.');
		instructions = new InstructionsService();
	});

	teardown(async () => {
		instructions.dispose();
		await server.close();
		for (const key of SETTINGS) {
			await setSetting(key, undefined);
		}
	});

	suiteTeardown(() => output.dispose());

	for (const [format, model] of [['openai', 'mock-coder'], ['anthropic', 'claude-haiku-4-5']] as const) {
		test(`${format} format: returns ghost text, applies instructions, records latency, then serves from cache`, async () => {
			await useMockProvider(server, format, model);
			const document = await vscode.workspace.openTextDocument({
				language: 'typescript',
				content: 'export function clamp(value: number, min: number, max: number): number {\n    return \n}\n'
			});
			const position = new vscode.Position(1, 11);
			const provider = new InlineCompletionProvider(astService, output, instructions);
			try {
				const before = latencyTracker.stats().count;
				const result = await provider.provideInlineCompletionItems(document, position, completionContext(), new vscode.CancellationTokenSource().token);
				assert.ok(result && result.items.length === 1, 'one inline completion');
				assert.strictEqual(result.items[0].insertText, 'Math.min(max, Math.max(min, value));');

				const completionRequests = server.requests.filter((r) => r.method === 'POST');
				assert.strictEqual(completionRequests.length, 1);
				const body = completionRequests[0].body;
				const systemText: string = format === 'openai'
					? body.messages.find((m: { role: string }) => m.role === 'system').content
					: body.system[0].text;
				assert.ok(systemText.includes('Always prefer Math helpers.'), 'custom instructions reach the model');
				assert.ok(systemText.includes('<output_format>'), 'output contract kept');
				assert.strictEqual(body.model, model);

				const stats = latencyTracker.stats();
				assert.strictEqual(stats.count, before + 1, 'latency sample recorded');
				assert.ok(stats.last!.ttftMs >= 25, `ttft includes server delay (${stats.last!.ttftMs}ms)`);
				console.log(`      [${format}] pipeline: context=${stats.last!.contextMs.toFixed(1)}ms prompt=${stats.last!.promptMs.toFixed(1)}ms ` +
					`ttft=${stats.last!.ttftMs.toFixed(1)}ms total=${stats.last!.totalMs.toFixed(1)}ms (mock server adds 30ms)`);

				// Same position again: served from the pending edit, no second network call.
				const again = await provider.provideInlineCompletionItems(document, position, completionContext(), new vscode.CancellationTokenSource().token);
				assert.strictEqual(again?.items[0].insertText, 'Math.min(max, Math.max(min, value));');
				assert.strictEqual(server.requests.filter((r) => r.method === 'POST').length, 1);
			} finally {
				provider.dispose();
			}
		});
	}

	test('usage metrics: provider tokens, suggestions shown and local cache hits are recorded', async () => {
		await useMockProvider(server, 'anthropic', 'claude-haiku-4-5');
		const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const z = \n' });
		const position = new vscode.Position(0, 10);
		const tracker = new UsageTracker(undefined, (p, m) => resolvePrice(p, m));
		const provider = new InlineCompletionProvider(astService, output, instructions, tracker);
		try {
			await provider.provideInlineCompletionItems(document, position, completionContext(), new vscode.CancellationTokenSource().token);
			provider.clearPendingCompletion();
			// Same document + position + context: served from the completion cache, no API call.
			await provider.provideInlineCompletionItems(document, position, completionContext(), new vscode.CancellationTokenSource().token);

			const { session } = tracker.snapshot();
			assert.strictEqual(session.apiRequests, 1);
			assert.strictEqual(session.completedRequests, 1);
			assert.strictEqual(session.suggestionsShown, 2);
			assert.strictEqual(session.servedLocally, 1);
			const haiku = session.byModel[usageKey('custom:mock', 'claude-haiku-4-5')];
			assert.deepStrictEqual(
				[haiku.inputTokens, haiku.outputTokens, haiku.cacheReadTokens, haiku.cacheWriteTokens],
				[MOCK_USAGE.input, MOCK_USAGE.output, MOCK_USAGE.cached, MOCK_USAGE.cacheWrite]
			);
			assert.ok(haiku.costUsd > 0, 'Claude usage is priced');
			assert.strictEqual(haiku.priceSource, 'list');
			console.log('      ' + formatUsageReport(session).split('\n').join('\n      '));
		} finally {
			provider.dispose();
		}
	});

	test('changing instructions invalidates cached completions', async () => {
		await useMockProvider(server, 'openai', 'mock-coder');
		const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const x = \n' });
		const position = new vscode.Position(0, 10);
		const provider = new InlineCompletionProvider(astService, output, instructions);
		try {
			await provider.provideInlineCompletionItems(document, position, completionContext(), new vscode.CancellationTokenSource().token);
			provider.clearPendingCompletion();
			await setSetting('customInstructions', 'Different instructions.');
			await provider.provideInlineCompletionItems(document, position, completionContext(), new vscode.CancellationTokenSource().token);
			const posts = server.requests.filter((r) => r.method === 'POST');
			assert.strictEqual(posts.length, 2, 'second request made after instructions changed');
			assert.ok(posts[1].body.messages[0].content.includes('Different instructions.'));
		} finally {
			provider.dispose();
		}
	});

	test('a cancelled request returns nothing and does not throw', async () => {
		server.options.firstTokenDelayMs = 3000;
		await useMockProvider(server, 'openai', 'mock-coder');
		const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'let y = \n' });
		const provider = new InlineCompletionProvider(astService, output, instructions);
		try {
			const source = new vscode.CancellationTokenSource();
			setTimeout(() => source.cancel(), 100);
			const started = performance.now();
			const result = await provider.provideInlineCompletionItems(document, new vscode.Position(0, 8), completionContext(), source.token);
			assert.strictEqual(result, null);
			assert.ok(performance.now() - started < 2000, 'cancellation aborts the network request');
		} finally {
			provider.dispose();
		}
	});

	test('local pipeline overhead on a large file stays small', async () => {
		const lines: string[] = [];
		for (let i = 0; i < 1500; i++) {
			lines.push(`export function helper${i}(a: number): number { return a + ${i}; }`);
		}
		lines.push('export function target(value: number): number {', '    return helper1(', '}');
		const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: lines.join('\n') });
		const position = new vscode.Position(1501, 18);
		const tracker = new IntentTracker();
		const gatherer = new ContextGatherer(astService, tracker);
		const builder = new PromptBuilder();
		try {
			await gatherer.gatherContext(document, position); // warm LSP/tree-sitter caches
			const timings: number[] = [];
			for (let i = 0; i < 5; i++) {
				const start = performance.now();
				const context = await gatherer.gatherContext(document, position);
				builder.buildPrompt(context, instructions.resolve(document));
				timings.push(performance.now() - start);
			}
			timings.sort((a, b) => a - b);
			console.log(`      context+prompt on 1500-function file: median=${timings[2].toFixed(1)}ms max=${timings[4].toFixed(1)}ms`);
			assert.ok(timings[2] < 500, `local overhead too high: ${timings[2]}ms`);
		} finally {
			gatherer.dispose();
			tracker.dispose();
		}
	});
});
