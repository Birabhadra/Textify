import * as vscode from "vscode";
import * as fs from "fs";
import { getConfig, TabCompletionConfig } from "../services/configurationService";
import { PROVIDERS } from "../api/providers";

interface WebviewInboundMessage {
    type: 'update' | 'reset' | 'ready';
    key?: keyof TabCompletionConfig;
    value?: unknown;
}

export class DashboardViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'textify.dashboard';
    private view: vscode.WebviewView | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {
        this.disposables.push(
            getConfig().onConfigChange((config) => this.postConfig(config))
        );
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };
        webviewView.webview.html = this.buildHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message: WebviewInboundMessage) => {
            this.handleMessage(message);
        }, undefined, this.disposables);
    }

    private async handleMessage(message: WebviewInboundMessage): Promise<void> {
        if (message.type === 'ready') {
            this.postConfig();
            this.postProviders();
            return;
        }
        if (message.type === 'update' && message.key) {
            await getConfig().updateSetting(message.key, message.value as never);
            return;
        }
        if (message.type === 'reset') {
            await getConfig().resetAll();
        }
    }

    private postConfig(config?: TabCompletionConfig): void {
        const snapshot = config ?? this.currentSnapshot();
        this.view?.webview.postMessage({ type: 'config', config: snapshot });
    }

    private postProviders(): void {
        this.view?.webview.postMessage({
            type: 'providers',
            providers: PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label, models: provider.models }))
        });
    }

    private currentSnapshot(): TabCompletionConfig {
        const config = getConfig();
        return {
            enabled: config.enabled,
            fireworksApiKey: config.fireworksApiKey,
            openrouterApiKey: config.openrouterApiKey,
            groqApiKey: config.groqApiKey,
            provider: config.provider,
            model: config.model,
            maxTokens: config.maxTokens,
            useAst: config.useAst,
            useLsp: config.useLsp,
            useCrossFileContext: config.useCrossFileContext,
            useDeduplication: config.useDeduplication,
            completionCacheMaxEntries: config.completionCacheMaxEntries,
            completionCacheTtlMs: config.completionCacheTtlMs,
            lspCacheMaxEntries: config.lspCacheMaxEntries
        };
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
        this.disposables.forEach((d) => d.dispose());
    }
}
