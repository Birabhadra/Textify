import * as vscode from "vscode";
import { ModelPrice, parseOpenRouterCatalog } from "../utils/pricing";
import { getConfig } from "./configurationService";

export const PRICING_CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const STATE_KEY = 'textify.pricingCatalog';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredCatalog {
    fetchedAt: number;
    prices: Record<string, ModelPrice>;
}

/**
 * Public price list for hundreds of models (OpenRouter's model catalog; no API key or user data sent).
 * Used to price providers that don't report cost themselves. Cached in globalState for a day.
 */
export class PricingCatalog implements vscode.Disposable {
    private stored: StoredCatalog | undefined;
    private inFlight: Promise<void> | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly state: vscode.Memento, private readonly outputChannel?: vscode.OutputChannel) {
        const saved = state.get<StoredCatalog>(STATE_KEY);
        if (saved && typeof saved.fetchedAt === 'number' && saved.prices && typeof saved.prices === 'object') {
            this.stored = saved;
        }
    }

    get prices(): Record<string, ModelPrice> | undefined {
        return this.stored?.prices;
    }

    status(): { models: number; fetchedAt?: number; enabled: boolean } {
        return {
            models: this.stored ? Object.keys(this.stored.prices).length : 0,
            fetchedAt: this.stored?.fetchedAt,
            enabled: getConfig().fetchPricingCatalog
        };
    }

    /** Refreshes when stale (or always with `force`). Never throws unless `force` is set. */
    async refresh(force = false): Promise<void> {
        if (!getConfig().fetchPricingCatalog && !force) {
            return;
        }
        if (!force && this.stored && Date.now() - this.stored.fetchedAt < MAX_AGE_MS) {
            return;
        }
        this.inFlight ??= this.fetchCatalog().finally(() => { this.inFlight = undefined; });
        try {
            await this.inFlight;
        } catch (error) {
            this.outputChannel?.appendLine(`[Pricing] Catalog refresh failed: ${error instanceof Error ? error.message : error}`);
            if (force) {
                throw error;
            }
        }
    }

    private async fetchCatalog(): Promise<void> {
        const response = await fetch(PRICING_CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const prices = parseOpenRouterCatalog(await response.json());
        if (Object.keys(prices).length === 0) {
            throw new Error('Catalog contained no priced models');
        }
        this.stored = { fetchedAt: Date.now(), prices };
        await this.state.update(STATE_KEY, this.stored);
        this.outputChannel?.appendLine(`[Pricing] Loaded prices for ${Object.keys(prices).length} models`);
        this.changeEmitter.fire();
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
