import * as vscode from "vscode";
import * as fs from "fs";
import { getConfig, TabCompletionConfig } from "../services/configurationService";
import {
    CustomProviderConfig,
    customProviderToDefinition,
    getAllProviders,
    getProvider,
    getProviderApiKey,
    ProviderDefinition,
    sanitizeCustomProvider
} from "../api/providers";
import { ApiClient } from "../api/apiClient";
import { InstructionsService } from "../services/instructionsService";
import { formatBenchmark, runLatencyBenchmark } from "../services/latencyBenchmark";
import { latencyTracker } from "../utils/latencyTracker";
import { UsageTracker } from "../services/usageTracker";
import { discoverModels } from "../api/transports";
import { PricingCatalog } from "../services/pricingCatalog";
import { ModelPrice, resolvePrice } from "../utils/pricing";

/** Instruction files bigger than this are almost certainly the wrong file (the prompt keeps ~8 KB). */
const MAX_INSTRUCTION_FILE_BYTES = 64 * 1024;

interface WebviewInboundMessage {
    type: 'update' | 'reset' | 'ready' | 'setApiKey' | 'saveCustomProvider' | 'deleteCustomProvider'
        | 'testProvider' | 'runBenchmark' | 'openInstructionsFile' | 'uploadInstructions' | 'discoverModels'
        | 'resetUsage' | 'showUsageReport' | 'setModelPrice' | 'refreshPricing';
    key?: keyof TabCompletionConfig;
    value?: unknown;
    providerId?: string;
    provider?: Partial<CustomProviderConfig>;
    requestId?: number;
    scope?: 'session' | 'all';
    model?: string;
    price?: ModelPrice | null;
}

export class DashboardViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'textify.dashboard';
    private view: vscode.WebviewView | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly apiClient: ApiClient,
        private readonly instructionsService: InstructionsService,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly usageTracker?: UsageTracker,
        private readonly pricingCatalog?: PricingCatalog
    ) {
        this.disposables.push(
            getConfig().onConfigChange((config) => {
                this.postConfig(config);
                this.postProviders();
            }),
            instructionsService.onDidChange(() => this.postInstructionsStatus()),
            latencyTracker.onDidRecord((stats) => this.view?.webview.postMessage({ type: 'latency', stats }))
        );
        if (usageTracker) {
            this.disposables.push(usageTracker.onDidChange(() => this.scheduleUsagePost()));
        }
        if (pricingCatalog) {
            this.disposables.push(pricingCatalog.onDidChange(() => this.scheduleUsagePost()));
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };
        webviewView.webview.html = this.buildHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message: WebviewInboundMessage) => {
            this.handleMessage(message).catch((error) => {
                this.post({ type: 'error', message: error instanceof Error ? error.message : String(error), requestId: message.requestId });
            });
        }, undefined, this.disposables);
    }

    private async handleMessage(message: WebviewInboundMessage): Promise<void> {
        const config = getConfig();
        switch (message.type) {
            case 'ready':
                this.postConfig();
                this.postProviders();
                this.postInstructionsStatus();
                this.post({ type: 'latency', stats: latencyTracker.stats() });
                this.postUsage();
                return;
            case 'update':
                if (message.key) {
                    await config.updateSetting(message.key, message.value as never);
                    if (message.key === 'provider') {
                        await this.alignModelWithProvider(String(message.value));
                    }
                }
                return;
            case 'setApiKey':
                await this.setApiKey(String(message.providerId ?? ''), String(message.value ?? ''));
                return;
            case 'saveCustomProvider':
                await this.saveCustomProvider(message.provider ?? {}, message.requestId);
                return;
            case 'deleteCustomProvider':
                await this.deleteCustomProvider(String(message.providerId ?? ''));
                return;
            case 'testProvider':
                await this.testProvider(message, message.requestId);
                return;
            case 'runBenchmark':
                await this.runBenchmark(message.requestId);
                return;
            case 'openInstructionsFile':
                await this.instructionsService.openWorkspaceFile();
                return;
            case 'uploadInstructions':
                await this.uploadInstructions(message.requestId);
                return;
            case 'discoverModels':
                await this.discoverModels(message.provider ?? {}, message.requestId);
                return;
            case 'resetUsage':
                if (message.scope === 'all') {
                    const choice = await vscode.window.showWarningMessage('Reset all-time Textify usage metrics?', { modal: true }, 'Reset');
                    if (choice === 'Reset') {
                        this.usageTracker?.resetAll();
                    }
                } else {
                    this.usageTracker?.resetSession();
                }
                return;
            case 'showUsageReport':
                await vscode.commands.executeCommand('textify.showUsage');
                return;
            case 'setModelPrice':
                await this.setModelPrice(String(message.providerId ?? ''), String(message.model ?? ''), message.price ?? null);
                return;
            case 'refreshPricing':
                await this.pricingCatalog?.refresh(true);
                this.postUsage();
                this.post({ type: 'pricingRefreshed', requestId: message.requestId });
                return;
            case 'reset': {
                const choice = await vscode.window.showWarningMessage(
                    'Reset all Textify settings? This also clears API keys and custom providers.',
                    { modal: true },
                    'Reset'
                );
                if (choice === 'Reset') {
                    await config.resetAll();
                }
                return;
            }
        }
    }

    /** Switching provider should never leave a model id the new provider can't serve. */
    private async alignModelWithProvider(providerId: string): Promise<void> {
        const config = getConfig();
        const provider = getProvider(providerId, config.customProviders);
        if (provider && provider.models.length > 0 && !provider.models.includes(config.model)) {
            await config.updateSetting('model', provider.models[0]);
        }
    }

    private async setApiKey(providerId: string, value: string): Promise<void> {
        const config = getConfig();
        const provider = getProvider(providerId, config.customProviders);
        if (!provider) {
            throw new Error(`Unknown provider: ${providerId}`);
        }
        if (provider.apiKeyConfigKey) {
            await config.updateSetting(provider.apiKeyConfigKey, value.trim());
            return;
        }
        const customs = config.customProviders.map((c) =>
            `custom:${c.id}` === providerId ? { ...c, apiKey: value.trim() } : c
        );
        await config.updateSetting('customProviders', customs);
    }

    private async saveCustomProvider(input: Partial<CustomProviderConfig>, requestId?: number): Promise<void> {
        const config = getConfig();
        const existing = config.customProviders;
        const isNew = !input.id || !existing.some((c) => c.id === input.id);
        const sanitized = sanitizeCustomProvider(input, existing.map((c) => c.id));
        const next = isNew
            ? [...existing, sanitized]
            : existing.map((c) => (c.id === sanitized.id ? sanitized : c));
        await config.updateSetting('customProviders', next);

        const providerId = `custom:${sanitized.id}` as const;
        if (isNew || config.provider === providerId) {
            // Make the new provider active right away; that's almost always why it was added.
            await config.updateSetting('provider', providerId);
            await config.updateSetting('model', sanitized.models.includes(config.model) ? config.model : sanitized.models[0]);
        }
        this.post({ type: 'customProviderSaved', providerId, requestId });
    }

    private async deleteCustomProvider(providerId: string): Promise<void> {
        const config = getConfig();
        const next = config.customProviders.filter((c) => `custom:${c.id}` !== providerId);
        await config.updateSetting('customProviders', next);
        if (config.provider === providerId) {
            await config.updateSetting('provider', 'auto');
        }
    }

    private async testProvider(message: WebviewInboundMessage, requestId?: number): Promise<void> {
        const config = getConfig();
        let provider: ProviderDefinition | undefined;
        if (message.provider) {
            // Unsaved draft from the custom provider form.
            provider = customProviderToDefinition(sanitizeCustomProvider(message.provider, []));
        } else {
            provider = getProvider(String(message.providerId ?? ''), config.customProviders);
            // Test the key currently in the input box, even if the settings write hasn't landed yet.
            if (provider && typeof message.value === 'string') {
                provider = { ...provider, apiKeyConfigKey: undefined, apiKey: message.value.trim() };
            }
        }
        if (!provider) {
            throw new Error('Unknown provider');
        }
        if (!provider.isCustom && !getProviderApiKey(provider, config)) {
            throw new Error(`Add an API key for ${provider.label} first`);
        }
        const result = await runLatencyBenchmark(this.apiClient, { provider, runs: 1 });
        this.outputChannel.appendLine(`[Dashboard] ${formatBenchmark(result)}`);
        this.post({ type: 'testResult', result, requestId });
    }

    private async runBenchmark(requestId?: number): Promise<void> {
        const result = await runLatencyBenchmark(this.apiClient, {
            runs: 5,
            onRun: (run, index) => this.post({ type: 'benchmarkProgress', run, index, requestId })
        });
        this.outputChannel.appendLine(`[Dashboard] ${formatBenchmark(result)}`);
        this.post({ type: 'benchmarkResult', result, requestId });
    }

    /** Picks a text/markdown file and appends it to (or replaces) the custom instructions. */
    private async uploadInstructions(requestId?: number): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Use as instructions',
            title: 'Upload Textify instructions',
            filters: { 'Instructions': ['md', 'markdown', 'txt', 'mdc', 'instructions'], 'All files': ['*'] }
        });
        const uri = picked?.[0];
        if (!uri) {
            this.post({ type: 'uploadCancelled', requestId });
            return;
        }
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_INSTRUCTION_FILE_BYTES) {
            throw new Error(`That file is ${Math.round(stat.size / 1024)} KB; instruction files must be under ${MAX_INSTRUCTION_FILE_BYTES / 1024} KB.`);
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.includes(0)) {
            throw new Error('That looks like a binary file. Choose a text or Markdown file.');
        }
        const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '').trim();
        if (!text) {
            throw new Error('The selected file is empty.');
        }

        const config = getConfig();
        const existing = config.customInstructions.trim();
        let next = text;
        if (existing) {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: 'Append', description: 'Add the file after your current instructions', value: 'append' },
                    { label: 'Replace', description: "Use only the file's contents", value: 'replace' }
                ],
                { title: 'You already have custom instructions', placeHolder: 'Append or replace?' }
            );
            if (!choice) {
                this.post({ type: 'uploadCancelled', requestId });
                return;
            }
            next = choice.value === 'append' ? `${existing}\n\n${text}` : text;
        }
        await config.updateSetting('customInstructions', next);
        const name = uri.path.split('/').pop();
        this.post({ type: 'instructionsUploaded', fileName: name, chars: text.length, total: next.length, requestId });
    }

    private async discoverModels(input: Partial<CustomProviderConfig>, requestId?: number): Promise<void> {
        const draft = sanitizeCustomProvider({ ...input, name: input.name || 'Local', models: ['placeholder'] }, []);
        const endpoint = customProviderToDefinition(draft)?.endPoint;
        if (!endpoint) {
            throw new Error('Enter a valid URL');
        }
        const models = await discoverModels(endpoint, draft.apiKey);
        this.post({ type: 'modelsDiscovered', models, requestId });
    }

    /** Saves (or with `null` clears) a price for one model on one provider. */
    private async setModelPrice(providerId: string, model: string, price: ModelPrice | null): Promise<void> {
        if (!model) {
            throw new Error('Model is required');
        }
        const config = getConfig();
        const next: Record<string, ModelPrice> = { ...config.modelPricing };
        const key = providerId ? `${providerId}:${model}` : model;
        if (price === null) {
            delete next[key];
            delete next[model];
        } else {
            const clean = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
            const input = clean(price.input);
            const output = clean(price.output);
            if (input === undefined || output === undefined) {
                throw new Error('Enter input and output prices (USD per 1M tokens)');
            }
            const entry: ModelPrice = { input, output };
            const cacheRead = clean(price.cacheRead);
            const cacheWrite = clean(price.cacheWrite);
            if (cacheRead !== undefined) { entry.cacheRead = cacheRead; }
            if (cacheWrite !== undefined) { entry.cacheWrite = cacheWrite; }
            next[key] = entry;
        }
        await config.updateSetting('modelPricing', next);
    }

    /** Models worth showing a price for: everything used so far plus the active provider's models. */
    private pricingRows(): Array<Record<string, unknown>> {
        const config = getConfig();
        const pairs = new Map<string, { provider: string; model: string }>();
        for (const pair of this.usageTracker?.modelsSeen() ?? []) {
            pairs.set(`${pair.provider}|${pair.model}`, pair);
        }
        const active = this.apiClient.getActiveProvider();
        if (active) {
            const activeModel = this.apiClient.getActiveModel(active);
            for (const model of [activeModel, ...active.models]) {
                pairs.set(`${active.id}|${model}`, { provider: active.id, model });
            }
        }
        return [...pairs.values()].map(({ provider, model }) => {
            const definition = getProvider(provider, config.customProviders);
            const resolved = resolvePrice(provider, model, {
                overrides: config.modelPricing,
                catalog: this.pricingCatalog?.prices,
                isLocal: definition?.format === 'local'
            });
            return {
                provider,
                providerLabel: definition?.label ?? provider,
                model,
                price: resolved?.price ?? null,
                source: resolved?.source ?? null,
                matchedId: resolved?.matchedId ?? null,
                reportsCost: provider === 'openrouter'
            };
        });
    }

    private usageTimer: ReturnType<typeof setTimeout> | undefined;

    private scheduleUsagePost(): void {
        if (!this.usageTimer) {
            this.usageTimer = setTimeout(() => {
                this.usageTimer = undefined;
                this.postUsage();
            }, 300);
        }
    }

    private postUsage(): void {
        if (this.usageTracker) {
            const config = getConfig();
            const providerLabels = Object.fromEntries(
                getAllProviders(config.customProviders).map((p) => [p.id, p.label])
            );
            this.post({
                type: 'usage',
                usage: this.usageTracker.snapshot(),
                now: Date.now(),
                providerLabels,
                pricing: this.pricingRows(),
                catalog: this.pricingCatalog?.status() ?? null
            });
        }
    }

    private post(message: Record<string, unknown>): void {
        void this.view?.webview.postMessage(message);
    }

    private postConfig(config?: TabCompletionConfig): void {
        this.post({ type: 'config', config: config ?? getConfig().snapshot() });
    }

    private postProviders(): void {
        const config = getConfig();
        const active = this.apiClient.getActiveProvider();
        const customsById = new Map(config.customProviders.map((c) => [`custom:${c.id}`, c]));
        this.post({
            type: 'providers',
            activeProviderId: active?.id ?? null,
            activeModel: this.apiClient.getActiveModel(active),
            providers: getAllProviders(config.customProviders).map((provider) => ({
                id: provider.id,
                label: provider.label,
                models: provider.models,
                format: provider.format ?? 'openai',
                isCustom: Boolean(provider.isCustom),
                hasKey: Boolean(getProviderApiKey(provider, config)),
                custom: customsById.get(provider.id) ?? null
            }))
        });
    }

    private postInstructionsStatus(): void {
        this.post({ type: 'instructionsStatus', status: this.instructionsService.status() });
    }

    private buildHtml(webview: vscode.Webview): string {
        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.html');
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.js'));
        const nonce = this.getNonce();

        const raw = fs.readFileSync(htmlPath.fsPath, 'utf8');
        return raw
            .replace(/{{cspSource}}/g, webview.cspSource)
            .replace(/{{styleUri}}/g, styleUri.toString())
            .replace(/{{scriptUri}}/g, scriptUri.toString())
            .replace(/{{nonce}}/g, nonce);
    }

    private getNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let text = '';
        for (let i = 0; i < 32; i++) {
            text += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return text;
    }

    dispose(): void {
        if (this.usageTimer) {
            clearTimeout(this.usageTimer);
        }
        this.disposables.forEach((d) => d.dispose());
    }
}
