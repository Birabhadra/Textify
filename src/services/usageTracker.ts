// Session and lifetime usage metrics, modeled on Claude Code's `/cost` report.
// vscode-free: persistence goes through `UsageStore` (globalState in the extension) and prices through
// a resolver, so costs are computed when displayed — setting a price later also prices past usage.
import { TokenUsage } from "../api/transports";
import { costFor, PriceSource, ResolvedPrice } from "../utils/pricing";

interface TokenTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export interface ModelUsageTotals extends TokenTotals {
    provider: string;
    model: string;
    requests: number;
    /** Sum of costs the provider reported on its responses (e.g. OpenRouter). */
    reportedCostUsd: number;
    /** Requests covered by `reportedCostUsd`. */
    reportedRequests: number;
    /** Tokens from requests without a provider-reported cost; priced with the current price table. */
    unreported: TokenTotals;
    // ---- computed in snapshot() ----
    costUsd: number;
    /** Requests that could not be priced (no reported cost and no known price). */
    unpricedRequests: number;
    priceSource?: PriceSource | 'provider';
}

export interface UsageTotals {
    startedAt: number;
    /** Requests sent to a provider (completions, tests, benchmarks). */
    apiRequests: number;
    completedRequests: number;
    cancelledRequests: number;
    failedRequests: number;
    apiDurationMs: number;
    /** Suggestions displayed, from the network or served locally (cache). */
    suggestionsShown: number;
    servedLocally: number;
    accepted: number;
    rejected: number;
    linesAdded: number;
    linesRemoved: number;
    /** Keyed by `usageKey(provider, model)`. */
    byModel: Record<string, ModelUsageTotals>;
}

export interface UsageSnapshot {
    session: UsageTotals;
    lifetime: UsageTotals;
}

export interface UsageStore {
    get(): unknown;
    set(value: UsageTotals): void | Thenable<void>;
}

export type RequestOutcome = 'completed' | 'cancelled' | 'failed';
export type PriceResolver = (provider: string, model: string) => ResolvedPrice | undefined;

export function usageKey(provider: string, model: string): string {
    return `${provider}|${model}`;
}

export function emptyTotals(now = Date.now()): UsageTotals {
    return {
        startedAt: now,
        apiRequests: 0,
        completedRequests: 0,
        cancelledRequests: 0,
        failedRequests: 0,
        apiDurationMs: 0,
        suggestionsShown: 0,
        servedLocally: 0,
        accepted: 0,
        rejected: 0,
        linesAdded: 0,
        linesRemoved: 0,
        byModel: {}
    };
}

const zeroTokens = (): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function emptyModel(provider: string, model: string): ModelUsageTotals {
    return {
        provider, model, requests: 0, ...zeroTokens(),
        reportedCostUsd: 0, reportedRequests: 0, unreported: zeroTokens(),
        costUsd: 0, unpricedRequests: 0
    };
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Accepts whatever was persisted by an older/newer version and fills gaps with zeros. */
function reviveTotals(value: unknown): UsageTotals {
    const base = emptyTotals();
    if (!value || typeof value !== 'object') {
        return base;
    }
    const raw = value as Record<string, unknown>;
    const out: UsageTotals = { ...base };
    for (const key of Object.keys(base) as (keyof UsageTotals)[]) {
        if (key !== 'byModel' && typeof raw[key] === 'number') {
            (out[key] as number) = raw[key] as number;
        }
    }
    const byModel = raw.byModel;
    if (byModel && typeof byModel === 'object') {
        for (const [key, entry] of Object.entries(byModel as Record<string, Record<string, unknown>>)) {
            const [providerFromKey, ...rest] = key.includes('|') ? key.split('|') : ['unknown', key];
            const provider = typeof entry.provider === 'string' ? entry.provider : providerFromKey;
            const model = typeof entry.model === 'string' ? entry.model : rest.join('|');
            const m = emptyModel(provider, model);
            m.requests = num(entry.requests);
            m.inputTokens = num(entry.inputTokens);
            m.outputTokens = num(entry.outputTokens);
            m.cacheReadTokens = num(entry.cacheReadTokens);
            m.cacheWriteTokens = num(entry.cacheWriteTokens);
            m.reportedCostUsd = num(entry.reportedCostUsd);
            m.reportedRequests = num(entry.reportedRequests);
            const unreported = entry.unreported as Record<string, unknown> | undefined;
            m.unreported = unreported
                ? { inputTokens: num(unreported.inputTokens), outputTokens: num(unreported.outputTokens), cacheReadTokens: num(unreported.cacheReadTokens), cacheWriteTokens: num(unreported.cacheWriteTokens) }
                // Older data without the split: treat all tokens as unreported so they get priced.
                : { inputTokens: m.inputTokens, outputTokens: m.outputTokens, cacheReadTokens: m.cacheReadTokens, cacheWriteTokens: m.cacheWriteTokens };
            out.byModel[usageKey(provider, model)] = m;
        }
    }
    return out;
}

function countLines(text: string): number {
    return text.length === 0 ? 0 : text.split('\n').length;
}

export class UsageTracker {
    private session = emptyTotals();
    private lifetime: UsageTotals;
    private readonly listeners = new Set<(snapshot: UsageSnapshot) => void>();
    private saveTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly store?: UsageStore,
        private readonly resolvePrice: PriceResolver = () => undefined
    ) {
        this.lifetime = reviveTotals(store?.get());
    }

    recordRequest(outcome: RequestOutcome, durationMs: number, usage: TokenUsage[] = [], provider = 'unknown'): void {
        this.apply((t) => {
            t.apiRequests++;
            t.apiDurationMs += durationMs;
            if (outcome === 'completed') { t.completedRequests++; }
            else if (outcome === 'cancelled') { t.cancelledRequests++; }
            else { t.failedRequests++; }
            usage.forEach((u, index) => {
                const key = usageKey(provider, u.model);
                const m = (t.byModel[key] ??= emptyModel(provider, u.model));
                // A fallback splits one request across models; count the request once, on the first.
                if (index === 0) { m.requests++; }
                m.inputTokens += u.inputTokens;
                m.outputTokens += u.outputTokens;
                m.cacheReadTokens += u.cacheReadTokens;
                m.cacheWriteTokens += u.cacheWriteTokens;
                if (typeof u.reportedCostUsd === 'number') {
                    m.reportedCostUsd += u.reportedCostUsd;
                    if (index === 0) { m.reportedRequests++; }
                } else {
                    m.unreported.inputTokens += u.inputTokens;
                    m.unreported.outputTokens += u.outputTokens;
                    m.unreported.cacheReadTokens += u.cacheReadTokens;
                    m.unreported.cacheWriteTokens += u.cacheWriteTokens;
                }
            });
        });
    }

    recordSuggestionShown(servedLocally: boolean): void {
        this.apply((t) => {
            t.suggestionsShown++;
            if (servedLocally) { t.servedLocally++; }
        });
    }

    recordAccepted(insertText: string, deletedText: string): void {
        this.apply((t) => {
            t.accepted++;
            t.linesAdded += countLines(insertText);
            t.linesRemoved += countLines(deletedText);
        });
    }

    recordRejected(): void {
        this.apply((t) => { t.rejected++; });
    }

    /** Copies of the totals with costs computed from the current prices. */
    snapshot(): UsageSnapshot {
        return { session: this.priced(this.session), lifetime: this.priced(this.lifetime) };
    }

    /** Every (provider, model) pair seen in lifetime usage. */
    modelsSeen(): Array<{ provider: string; model: string }> {
        return Object.values(this.lifetime.byModel).map(({ provider, model }) => ({ provider, model }));
    }

    resetSession(): void {
        this.session = emptyTotals();
        this.emit();
    }

    resetAll(): void {
        this.session = emptyTotals();
        this.lifetime = emptyTotals();
        this.flush();
        this.emit();
    }

    /** Prices changed (settings or catalog): listeners should re-render. */
    pricesChanged(): void {
        this.emit();
    }

    onDidChange(listener: (snapshot: UsageSnapshot) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    /** Writes lifetime totals now (also called on dispose). */
    flush(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        void this.store?.set(structuredClone(this.lifetime));
    }

    dispose(): void {
        this.flush();
        this.listeners.clear();
    }

    private priced(totals: UsageTotals): UsageTotals {
        const copy = structuredClone(totals);
        for (const m of Object.values(copy.byModel)) {
            const unreportedRequests = m.requests - m.reportedRequests;
            const resolved = this.resolvePrice(m.provider, m.model);
            const hasUnreportedTokens = m.unreported.inputTokens + m.unreported.outputTokens + m.unreported.cacheReadTokens + m.unreported.cacheWriteTokens > 0;
            m.costUsd = m.reportedCostUsd + (resolved ? costFor(m.unreported, resolved.price) : 0);
            m.unpricedRequests = resolved || !hasUnreportedTokens ? 0 : Math.max(unreportedRequests, 1);
            m.priceSource = m.reportedRequests > 0 && unreportedRequests <= 0 ? 'provider' : resolved?.source;
        }
        return copy;
    }

    private apply(update: (totals: UsageTotals) => void): void {
        update(this.session);
        update(this.lifetime);
        if (this.store && !this.saveTimer) {
            this.saveTimer = setTimeout(() => this.flush(), 2000);
        }
        this.emit();
    }

    private emit(): void {
        if (this.listeners.size === 0) {
            return;
        }
        const snapshot = this.snapshot();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch {
                // listeners must not break completion flow
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Formatting (matches Claude Code's `/cost` style). Pass totals from snapshot() so costs are computed.
// ---------------------------------------------------------------------------------------------

export function formatTokens(n: number): string {
    if (n >= 1_000_000) { return `${trim(n / 1_000_000)}m`; }
    if (n >= 1_000) { return `${trim(n / 1_000)}k`; }
    return String(Math.round(n));
}

function trim(value: number): string {
    return value.toFixed(1).replace(/\.0$/, '');
}

export function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, ms) / 1000;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (hours) { parts.push(`${hours}h`); }
    if (hours || minutes) { parts.push(`${minutes}m`); }
    parts.push(`${seconds.toFixed(1)}s`);
    return parts.join(' ');
}

export function formatCost(usd: number): string {
    return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function totalCost(t: UsageTotals): { usd: number; unpricedRequests: number } {
    let usd = 0;
    let unpricedRequests = 0;
    for (const m of Object.values(t.byModel)) {
        usd += m.costUsd;
        unpricedRequests += m.unpricedRequests;
    }
    return { usd, unpricedRequests };
}

export function totalTokens(t: UsageTotals): number {
    return Object.values(t.byModel).reduce((sum, m) => sum + m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens, 0);
}

export function acceptanceRate(t: UsageTotals): number | undefined {
    return t.suggestionsShown > 0 ? t.accepted / t.suggestionsShown : undefined;
}

const SOURCE_LABELS: Record<string, string> = {
    provider: 'reported by provider',
    custom: 'your price',
    list: 'list price',
    local: 'local',
    catalog: '≈ OpenRouter catalog'
};

/** Display name used in reports: the model, plus the provider when it's ambiguous or not obvious. */
export function modelLabel(m: ModelUsageTotals, all: ModelUsageTotals[], providerLabel: (id: string) => string = (id) => id): string {
    const duplicated = all.filter((other) => other.model === m.model).length > 1;
    return duplicated || m.provider.startsWith('custom:') ? `${m.model} (${providerLabel(m.provider)})` : m.model;
}

export function formatUsageReport(t: UsageTotals, now = Date.now(), providerLabel?: (id: string) => string): string {
    const cost = totalCost(t);
    const costText = formatCost(cost.usd) + (cost.unpricedRequests
        ? ` (+${cost.unpricedRequests} request${cost.unpricedRequests === 1 ? '' : 's'} on unpriced models; set a price in the Textify panel)`
        : '');
    const rate = acceptanceRate(t);
    const lines = [
        `Total cost:            ${costText}`,
        `Total duration (API):  ${formatDuration(t.apiDurationMs)}`,
        `Total duration (wall): ${formatDuration(now - t.startedAt)}`,
        `Total code changes:    ${t.linesAdded} line${t.linesAdded === 1 ? '' : 's'} added, ${t.linesRemoved} line${t.linesRemoved === 1 ? '' : 's'} removed`,
        `Requests:              ${t.apiRequests} (${t.completedRequests} completed, ${t.cancelledRequests} cancelled, ${t.failedRequests} failed)`,
        `Suggestions:           ${t.suggestionsShown} shown (${t.servedLocally} from cache), ${t.accepted} accepted, ${t.rejected} rejected` +
            (rate === undefined ? '' : ` · ${Math.round(rate * 100)}% acceptance`)
    ];
    const models = Object.values(t.byModel).sort((a, b) => b.requests - a.requests);
    if (models.length > 0) {
        lines.push('Usage by model:');
        const labels = models.map((m) => modelLabel(m, models, providerLabel));
        const width = Math.max(...labels.map((l) => l.length));
        models.forEach((m, i) => {
            const priced = m.unpricedRequests === 0
                ? ` (${formatCost(m.costUsd)}${m.priceSource ? `, ${SOURCE_LABELS[m.priceSource]}` : ''})`
                : ' (unpriced)';
            lines.push(`    ${(labels[i] + ':').padStart(width + 1)}  ${formatTokens(m.inputTokens)} input, ${formatTokens(m.outputTokens)} output, ` +
                `${formatTokens(m.cacheReadTokens)} cache read, ${formatTokens(m.cacheWriteTokens)} cache write${priced}`);
        });
    }
    return lines.join('\n');
}
