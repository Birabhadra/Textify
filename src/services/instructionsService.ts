import * as vscode from "vscode";
import * as crypto from "crypto";
import { getConfig } from "./configurationService";
import { InstructionSource, PromptInstructions } from "./promptBuilder";

export const WORKSPACE_INSTRUCTIONS_PATH = '.textify/instructions.md';

const TEMPLATE = `# Textify instructions

<!--
These instructions are added to the system prompt for every completion in this workspace.
Commit this file to share conventions with your team. Keep it short: it is sent with every request.
-->

- Follow the existing code style in this repository.
`;

/**
 * Resolves the user's completion instructions, merged in increasing precedence:
 * `textify.customInstructions` < `textify.languageInstructions[languageId]` < `.textify/instructions.md`.
 */
export class InstructionsService implements vscode.Disposable {
    private readonly workspaceText = new Map<string, string>();
    private readonly disposables: vscode.Disposable[] = [];
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher(`**/${WORKSPACE_INSTRUCTIONS_PATH}`);
        const reload = (uri: vscode.Uri) => {
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            if (folder) {
                void this.loadFolder(folder);
            }
        };
        this.disposables.push(
            watcher,
            watcher.onDidCreate(reload),
            watcher.onDidChange(reload),
            watcher.onDidDelete(reload),
            vscode.workspace.onDidChangeWorkspaceFolders(() => void this.loadAll()),
            getConfig().onConfigChange(() => this.changeEmitter.fire()),
            this.changeEmitter
        );
        void this.loadAll();
    }

    async loadAll(): Promise<void> {
        this.workspaceText.clear();
        await Promise.all((vscode.workspace.workspaceFolders ?? []).map((folder) => this.loadFolder(folder)));
    }

    private async loadFolder(folder: vscode.WorkspaceFolder): Promise<void> {
        const key = folder.uri.toString();
        const previous = this.workspaceText.get(key);
        let text = '';
        try {
            const bytes = await vscode.workspace.fs.readFile(this.fileUri(folder));
            text = stripHtmlComments(new TextDecoder().decode(bytes)).trim();
        } catch {
            text = '';
        }
        if (text) {
            this.workspaceText.set(key, text);
        } else {
            this.workspaceText.delete(key);
        }
        if (previous !== (text || undefined)) {
            this.changeEmitter.fire();
        }
    }

    private fileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
        return vscode.Uri.joinPath(folder.uri, WORKSPACE_INSTRUCTIONS_PATH);
    }

    /** Instructions for a document; synchronous (served from cache) so it adds nothing to latency. */
    resolve(document: vscode.TextDocument): PromptInstructions {
        const config = getConfig();
        const sources: InstructionSource[] = [];
        if (config.customInstructions.trim()) {
            sources.push({ source: 'settings', text: config.customInstructions });
        }
        const languageText = config.languageInstructions[document.languageId];
        if (typeof languageText === 'string' && languageText.trim()) {
            sources.push({ source: `language:${document.languageId}`, text: languageText });
        }
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const workspaceText = folder ? this.workspaceText.get(folder.uri.toString()) : undefined;
        if (workspaceText) {
            sources.push({ source: WORKSPACE_INSTRUCTIONS_PATH, text: workspaceText });
        }
        return { mode: config.systemPromptMode, sources };
    }

    /** Stable hash of everything that affects the system prompt for this document. */
    hash(document: vscode.TextDocument): string {
        const resolved = this.resolve(document);
        const content = resolved.mode + '\u0000' + resolved.sources.map((s) => `${s.source}\u0000${s.text}`).join('\u0001');
        return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
    }

    /** Summary for the dashboard. */
    status(): { workspaceFiles: string[] } {
        const files: string[] = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (this.workspaceText.has(folder.uri.toString())) {
                files.push(vscode.workspace.asRelativePath(this.fileUri(folder), true));
            }
        }
        return { workspaceFiles: files };
    }

    /** Opens the workspace instructions file, creating it from a template if needed. */
    async openWorkspaceFile(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
            void vscode.window.showWarningMessage('Open a folder to create workspace instructions. Global instructions can be set in the Textify settings panel.');
            return;
        }
        let folder = folders[0];
        if (folders.length > 1) {
            const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Workspace folder for Textify instructions' });
            if (!picked) {
                return;
            }
            folder = picked;
        }
        const uri = this.fileUri(folder);
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(TEMPLATE));
        }
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}

export function stripHtmlComments(text: string): string {
    return text.replace(/<!--[\s\S]*?-->/g, '');
}
