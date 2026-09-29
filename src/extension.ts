import * as vscode from 'vscode';
import { InlineCompletionProvider } from './providers/inlineCompletionProvider';
import { ASTService } from './services/astService';
import { DashboardViewProvider } from './ui/dashboardViewProvider';
import { getConfig } from './services/configurationService';
import { InstructionsService } from './services/instructionsService';
import { formatBenchmark, runLatencyBenchmark } from './services/latencyBenchmark';
import { formatUsageReport, UsageTracker } from './services/usageTracker';
import { UsageStatusBar } from './ui/usageStatusBar';
import { PricingCatalog } from './services/pricingCatalog';
import { resolvePrice } from './utils/pricing';
import { getProvider } from './api/providers';

const USAGE_STATE_KEY = 'textify.usage.lifetime';
let provider: InlineCompletionProvider | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let astService: ASTService | undefined;
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Textify');
	outputChannel.appendLine('Textify extension activated');
	astService = new ASTService(context.extensionPath);
	astService.initialize().then(() => {
		outputChannel?.appendLine('AST service initialized');
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			astService?.ensureLanguage(activeEditor.document.languageId);
		}
	});
	vscode.window.onDidChangeActiveTextEditor((editor) => {
		if (editor && astService?.isReady) {
			astService.ensureLanguage(editor.document.languageId);
		}
	});


	const instructionsService = new InstructionsService();
	const pricingCatalog = new PricingCatalog(context.globalState, outputChannel);
	const usageTracker = new UsageTracker(
		{
			get: () => context.globalState.get(USAGE_STATE_KEY),
			set: (value) => context.globalState.update(USAGE_STATE_KEY, value)
		},
		(providerId, model) => resolvePrice(providerId, model, {
			overrides: getConfig().modelPricing,
			catalog: pricingCatalog.prices,
			isLocal: getProvider(providerId, getConfig().customProviders)?.format === 'local'
		})
	);
	// Prices can change after usage was recorded; costs are recomputed on display.
	const pricingListeners = [
		pricingCatalog.onDidChange(() => usageTracker.pricesChanged()),
		getConfig().onConfigChange(() => usageTracker.pricesChanged())
	];
	void pricingCatalog.refresh();
	provider = new InlineCompletionProvider(astService, outputChannel, instructionsService, usageTracker);
	const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
		{ pattern: '**' },
		provider
	);
	const acceptCompletionCommand = vscode.commands.registerCommand(
		'textify.acceptCompletion',
		async () => {
			outputChannel?.appendLine('[Extension] Accept completion command executed');
			const editor = vscode.window.activeTextEditor;
			if (!editor || !provider) {
				outputChannel?.appendLine('[Extension] No editor or provider');
				return;
			}

			const pendingEdit = provider.getPendingEdit();
			if (!pendingEdit) {
				outputChannel?.appendLine('[Extension] No pending edit,Falling back to normal tab behaviour');
				await vscode.commands.executeCommand('tab');
				return;
			}
			outputChannel?.appendLine(`[Extension] Applying edit:delete ${pendingEdit.deleteRange.start.line}:${pendingEdit.deleteRange.start.character}-${pendingEdit.deleteRange.end.line}:${pendingEdit.deleteRange.end.character},insert "${pendingEdit.insertText.slice(0, 30)}..."`);

			const success = await editor.edit((editBuilder) => {
				editBuilder.replace(pendingEdit.deleteRange, pendingEdit.insertText);
			}, {
				undoStopBefore: true,
				undoStopAfter: true
			});

			if (success) {
				outputChannel?.appendLine('[Extension] Edit applied successfully');
				const insertLines = pendingEdit.insertText.split('\n');
				const insertEnd = insertLines.length === 1
					? new vscode.Position(pendingEdit.deleteRange.start.line, pendingEdit.deleteRange.start.character + pendingEdit.insertText.length)
					: new vscode.Position(pendingEdit.deleteRange.start.line + insertLines.length - 1, insertLines[insertLines.length - 1].length);
				editor.selection = new vscode.Selection(insertEnd, insertEnd);
				usageTracker.recordAccepted(pendingEdit.insertText, pendingEdit.deletedText);
				provider.getIntentTracker()?.recordAcceptedSuggestion(
					editor.document.uri.fsPath,
					pendingEdit.deleteRange.start.line + 1,
					pendingEdit.insertText
				);
			} else {
				outputChannel?.appendLine('[Extension] Edit failed to apply');
			}
			provider.clearPendingCompletion();
		}

	);
	const rejectCompletionCommand = vscode.commands.registerCommand(
		'textify.rejectCompletion',
		async () => {
			outputChannel?.appendLine('[Extension] Reject completion command executed');
			const editor = vscode.window.activeTextEditor;
			if (!editor || !provider) {
				outputChannel?.appendLine('[Extension] No editor or provider');
				return;
			}

			const pendingEdit = provider.getPendingEdit();
			if (!pendingEdit) {
				outputChannel?.appendLine('[Extension] No pending edit,Falling back to normal tab behaviour');
				return;
			}
			usageTracker.recordRejected();
			provider.getIntentTracker()?.recordRejectedSuggestion(
				editor.document.uri.fsPath,
				pendingEdit.deleteRange.start.line + 1,
				pendingEdit.insertText
			);
			provider.clearPendingCompletion();
		}

	);


	const benchmarkCommand = vscode.commands.registerCommand('textify.benchmarkLatency', async () => {
		if (!provider || !outputChannel) {
			return;
		}
		const channel = outputChannel;
		const apiClient = provider.getApiClient();
		try {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Textify: measuring completion latency', cancellable: false },
				(progress) => runLatencyBenchmark(apiClient, {
					runs: 5,
					instructions: vscode.window.activeTextEditor ? instructionsService.resolve(vscode.window.activeTextEditor.document) : undefined,
					onRun: (_run, index) => progress.report({ message: `request ${index + 1}/5`, increment: 20 })
				})
			);
			const report = formatBenchmark(result);
			channel.appendLine(report);
			channel.show(true);
			const failed = result.runs.find((r) => !r.ok);
			if (failed) {
				void vscode.window.showErrorMessage(`Textify benchmark failed: ${failed.error}`);
			} else {
				void vscode.window.showInformationMessage(
					`Textify ${result.provider}/${result.model}: cold ttft ${result.cold?.ttftMs}ms, warm p50 ttft ${result.warmTtft.p50}ms / total ${result.warmTotal.p50}ms`
				);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Textify benchmark failed: ${error instanceof Error ? error.message : error}`);
		}
	});
	const openInstructionsCommand = vscode.commands.registerCommand('textify.openInstructions', () => instructionsService.openWorkspaceFile());

	// Claude Code-style `/cost` report: session and all-time totals in the output channel.
	const providerLabel = (id: string) => getProvider(id, getConfig().customProviders)?.label ?? id;
	const showUsageCommand = vscode.commands.registerCommand('textify.showUsage', () => {
		if (!outputChannel) {
			return;
		}
		const { session, lifetime } = usageTracker.snapshot();
		outputChannel.appendLine('');
		outputChannel.appendLine('── Textify usage: this session ──');
		outputChannel.appendLine(formatUsageReport(session, Date.now(), providerLabel));
		outputChannel.appendLine(`── Textify usage: all time (since ${new Date(lifetime.startedAt).toLocaleString()}) ──`);
		outputChannel.appendLine(formatUsageReport(lifetime, Date.now(), providerLabel));
		outputChannel.show(true);
	});
	const resetUsageCommand = vscode.commands.registerCommand('textify.resetUsage', async () => {
		const choice = await vscode.window.showWarningMessage('Reset Textify usage metrics?', { modal: true }, 'This session', 'All time');
		if (choice === 'This session') {
			usageTracker.resetSession();
		} else if (choice === 'All time') {
			usageTracker.resetAll();
		}
	});
	const usageStatusBar = new UsageStatusBar(usageTracker);

	const dashboardProvider = new DashboardViewProvider(context.extensionUri, provider.getApiClient(), instructionsService, outputChannel, usageTracker, pricingCatalog);
	const dashboardDisposable = vscode.window.registerWebviewViewProvider(
		DashboardViewProvider.viewType,
		dashboardProvider
	);

	context.subscriptions.push(
		providerDisposable,
		outputChannel,
		acceptCompletionCommand,
		rejectCompletionCommand,
		dashboardDisposable,
		dashboardProvider,
		benchmarkCommand,
		openInstructionsCommand,
		instructionsService,
		provider,
		showUsageCommand,
		resetUsageCommand,
		usageStatusBar,
		usageTracker,
		pricingCatalog,
		...pricingListeners,
		getConfig()
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }
