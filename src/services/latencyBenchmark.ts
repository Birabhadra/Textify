import { ApiClient } from "../api/apiClient";
import { ProviderDefinition, resolveModel } from "../api/providers";
import { ChatMessage } from "../utils/types";
import { Percentiles, percentiles } from "../utils/latencyTracker";
import { composeSystemPrompt, PromptInstructions } from "./promptBuilder";
import { getConfig } from "./configurationService";

export interface BenchmarkRun {
    ok: boolean;
    ttftMs: number;
    totalMs: number;
    chars: number;
    error?: string;
}

export interface BenchmarkResult {
    provider: string;
    model: string;
    runs: BenchmarkRun[];
    /** First request: may include DNS/TCP/TLS setup. */
    cold?: BenchmarkRun;
    /** Remaining successful requests over a warm connection. */
    warmTtft: Percentiles;
    warmTotal: Percentiles;
}

const SAMPLE_USER_PROMPT = `<file lang="typescript" path="src/math.ts">
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

export function buildBenchmarkMessages(instructions?: PromptInstructions): ChatMessage[] {
    return [
        { role: 'system', content: composeSystemPrompt(instructions) },
        { role: 'user', content: SAMPLE_USER_PROMPT }
    ];
}

/**
 * Sends `runs` small completion requests sequentially and measures time-to-first-token and total
 * time for each. Runs are independent of (and don't cancel) in-flight editor completions.
 */
export async function runLatencyBenchmark(
    client: ApiClient,
    options: { provider?: ProviderDefinition; runs?: number; instructions?: PromptInstructions; onRun?: (run: BenchmarkRun, index: number) => void } = {}
): Promise<BenchmarkResult> {
    const provider = options.provider ?? client.getActiveProvider();
    if (!provider) {
        throw new Error('No provider configured. Add an API key or a custom provider first.');
    }
    const model = resolveModel(provider, getConfig().model);
    const messages = buildBenchmarkMessages(options.instructions);
    const runCount = Math.max(1, options.runs ?? 5);
    const runs: BenchmarkRun[] = [];

    for (let i = 0; i < runCount; i++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        const start = performance.now();
        let firstTokenAt = 0;
        let text = '';
        let run: BenchmarkRun;
        try {
            const stream = await client.complete(messages, { provider, model, maxTokens: 64, detached: true, signal: controller.signal });
            for await (const chunk of stream) {
                if (!firstTokenAt) {
                    firstTokenAt = performance.now();
                }
                text += chunk;
            }
            const end = performance.now();
            run = { ok: true, ttftMs: Math.round((firstTokenAt || end) - start), totalMs: Math.round(end - start), chars: text.length };
        } catch (error) {
            const message = controller.signal.aborted ? 'Timed out after 30s' : (error instanceof Error ? error.message : String(error));
            run = { ok: false, ttftMs: 0, totalMs: Math.round(performance.now() - start), chars: 0, error: message };
        } finally {
            clearTimeout(timeout);
        }
        runs.push(run);
        options.onRun?.(run, i);
        if (!run.ok && i === 0) {
            break; // auth / URL errors won't fix themselves on retry
        }
    }

    const warm = runs.slice(1).filter((r) => r.ok);
    return {
        provider: provider.label,
        model,
        runs,
        cold: runs[0],
        warmTtft: percentiles(warm.map((r) => r.ttftMs)),
        warmTotal: percentiles(warm.map((r) => r.totalMs))
    };
}

export function formatBenchmark(result: BenchmarkResult): string {
    const lines = [`Latency benchmark: ${result.provider} / ${result.model}`];
    result.runs.forEach((run, i) => {
        lines.push(run.ok
            ? `  #${i + 1}${i === 0 ? ' (cold)' : ''}: ttft=${run.ttftMs}ms total=${run.totalMs}ms chars=${run.chars}`
            : `  #${i + 1}: FAILED after ${run.totalMs}ms - ${run.error}`);
    });
    if (result.runs.length > 1 && result.warmTtft.max > 0) {
        lines.push(`  warm p50: ttft=${result.warmTtft.p50}ms total=${result.warmTotal.p50}ms | p90: ttft=${result.warmTtft.p90}ms total=${result.warmTotal.p90}ms`);
    }
    return lines.join('\n');
}
