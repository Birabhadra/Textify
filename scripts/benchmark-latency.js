#!/usr/bin/env node
// Measures completion latency (time-to-first-token and total) against a real provider, outside VS Code.
// Run `npm run compile` first.
//
//   node scripts/benchmark-latency.js --provider anthropic --model claude-haiku-4-5   (key from ANTHROPIC_API_KEY)
//   node scripts/benchmark-latency.js --provider groq --runs 10                        (key from GROQ_API_KEY)
//   node scripts/benchmark-latency.js --url http://localhost:11434/v1 --format openai --model qwen2.5-coder
//   node scripts/benchmark-latency.js --mock                                           (local mock server, no key)
//
// Inside VS Code, the "Textify: Measure Completion Latency" command does the same with your saved settings.
const path = require('path');
const out = path.resolve(__dirname, '..', 'out');
const { PROVIDERS, normalizeEndpoint } = require(path.join(out, 'api', 'providers.js'));
const { streamAnthropic, streamOpenAICompatible } = require(path.join(out, 'api', 'transports.js'));
const { SYSTEM_PROMPT } = require(path.join(out, 'services', 'promptBuilder.js'));
const { percentiles } = require(path.join(out, 'utils', 'latencyTracker.js'));

const ENV_KEYS = {
    openrouter: 'OPENROUTER_API_KEY',
    groq: 'GROQ_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    gemini: 'GEMINI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY'
};

function parseArgs(argv) {
    const args = { runs: 5 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--mock') { args.mock = true; continue; }
        const next = argv[i + 1];
        if (arg === '--provider') { args.provider = next; i++; }
        else if (arg === '--model') { args.model = next; i++; }
        else if (arg === '--runs') { args.runs = Number(next); i++; }
        else if (arg === '--url') { args.url = next; i++; }
        else if (arg === '--format') { args.format = next; i++; }
        else if (arg === '--key') { args.key = next; i++; }
    }
    return args;
}

const USER_PROMPT = `<file lang="typescript" path="src/math.ts">
<prefix>
export function clamp(value: number, min: number, max: number): number {
    return <cursor />
</prefix>
<replace_region>
</replace_region>
<suffix>
}
</suffix>
</file>`;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let server;
    let target;

    if (args.mock) {
        const { startMockProviderServer } = require(path.join(out, 'test', 'mockProviderServer.js'));
        server = await startMockProviderServer({ firstTokenDelayMs: 50, interChunkDelayMs: 5, responseText: 'Math.min(max, Math.max(min, value));' });
        const format = args.format || 'openai';
        target = { label: `mock (${format})`, format, endpoint: normalizeEndpoint(`${server.baseUrl}/v1`, format), model: args.model || 'mock', key: '' };
    } else if (args.url) {
        const format = args.format === 'anthropic' ? 'anthropic' : 'openai';
        target = { label: args.url, format, endpoint: normalizeEndpoint(args.url, format), model: args.model, key: args.key || process.env.TEXTIFY_API_KEY || '' };
    } else {
        const provider = PROVIDERS.find((p) => p.id === (args.provider || 'anthropic'));
        if (!provider) {
            throw new Error(`Unknown provider "${args.provider}". Use one of: ${PROVIDERS.map((p) => p.id).join(', ')}`);
        }
        const key = args.key || process.env[ENV_KEYS[provider.id]];
        if (!key) {
            throw new Error(`Set ${ENV_KEYS[provider.id]} or pass --key`);
        }
        target = {
            label: provider.label,
            format: provider.format || 'openai',
            endpoint: provider.endPoint,
            model: args.model || provider.models[0],
            key,
            extraBody: provider.extraBodyFields ? provider.extraBodyFields() : undefined
        };
    }
    if (!target.model) {
        throw new Error('Pass --model');
    }

    const stream = target.format === 'anthropic' ? streamAnthropic : streamOpenAICompatible;
    console.log(`Benchmarking ${target.label} / ${target.model} (${args.runs} sequential requests)`);
    const runs = [];
    for (let i = 0; i < args.runs; i++) {
        const start = performance.now();
        let first = 0;
        let text = '';
        try {
            for await (const chunk of stream({
                endpoint: target.endpoint,
                apiKey: target.key,
                model: target.model,
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_PROMPT }],
                maxTokens: 64,
                temperature: 0.1,
                signal: AbortSignal.timeout(30000),
                extraBody: target.extraBody
            })) {
                if (!first) { first = performance.now(); }
                text += chunk;
            }
            const end = performance.now();
            const run = { ttft: (first || end) - start, total: end - start };
            runs.push(run);
            console.log(`  #${i + 1}${i === 0 ? ' (cold)' : '       '} ttft=${run.ttft.toFixed(0).padStart(5)}ms  total=${run.total.toFixed(0).padStart(5)}ms  ${JSON.stringify(text.slice(0, 50))}`);
        } catch (error) {
            console.log(`  #${i + 1} FAILED: ${error.message}`);
            if (i === 0) { break; }
        }
    }
    const warm = runs.slice(1);
    if (warm.length) {
        const t = percentiles(warm.map((r) => r.ttft));
        const total = percentiles(warm.map((r) => r.total));
        console.log(`Warm: ttft p50=${t.p50}ms p90=${t.p90}ms | total p50=${total.p50}ms p90=${total.p90}ms`);
    }
    if (server) {
        await server.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
