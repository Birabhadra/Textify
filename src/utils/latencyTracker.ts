export interface LatencySample {
    /** Time spent waiting in the debounce window. */
    debounceMs: number;
    /** Context gathering (AST / LSP / cross-file). */
    contextMs: number;
    /** Prompt construction. */
    promptMs: number;
    /** Request start -> first streamed token. */
    ttftMs: number;
    /** Request start -> stream complete. */
    requestMs: number;
    /** Provider call entry -> ghost text returned (excluding debounce). */
    totalMs: number;
    provider: string;
    model: string;
    timestamp: number;
}

export interface Percentiles {
    p50: number;
    p90: number;
    max: number;
}

export interface LatencyStats {
    count: number;
    ttft: Percentiles;
    request: Percentiles;
    total: Percentiles;
    context: Percentiles;
    last?: LatencySample;
}

export function percentiles(values: number[]): Percentiles {
    if (values.length === 0) {
        return { p50: 0, p90: 0, max: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    return { p50: Math.round(at(0.5)), p90: Math.round(at(0.9)), max: Math.round(sorted[sorted.length - 1]) };
}

export class LatencyTracker {
    private readonly samples: LatencySample[] = [];
    private readonly listeners = new Set<(stats: LatencyStats) => void>();

    constructor(private readonly capacity = 50) {}

    record(sample: LatencySample): void {
        this.samples.push(sample);
        if (this.samples.length > this.capacity) {
            this.samples.shift();
        }
        const stats = this.stats();
        for (const listener of this.listeners) {
            try {
                listener(stats);
            } catch {
                // listeners must not break completion flow
            }
        }
    }

    stats(): LatencyStats {
        return {
            count: this.samples.length,
            ttft: percentiles(this.samples.map((s) => s.ttftMs)),
            request: percentiles(this.samples.map((s) => s.requestMs)),
            total: percentiles(this.samples.map((s) => s.totalMs)),
            context: percentiles(this.samples.map((s) => s.contextMs)),
            last: this.samples[this.samples.length - 1]
        };
    }

    clear(): void {
        this.samples.length = 0;
    }

    onDidRecord(listener: (stats: LatencyStats) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }
}

export const latencyTracker = new LatencyTracker();

export function formatSample(s: LatencySample): string {
    return `debounce=${Math.round(s.debounceMs)}ms context=${Math.round(s.contextMs)}ms prompt=${Math.round(s.promptMs)}ms ` +
        `ttft=${Math.round(s.ttftMs)}ms request=${Math.round(s.requestMs)}ms total=${Math.round(s.totalMs)}ms ` +
        `[${s.provider}/${s.model}]`;
}
