import * as vscode from 'vscode';
import { InlineCompletionProvider } from './providers/inlineCompletionProvider';
import { ASTService } from './services/astService';
let provider: InlineCompletionProvider | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let astService: ASTService | undefined;
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Textify');
	outputChannel.appendLine('Textify extension activated');
	astService = new ASTService(context.extensionPath);
	astService.initialize().then(() => {
		outputChannel?.appendLine('AST servicd initialized');
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


	provider = new InlineCompletionProvider(astService, outputChannel);
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

			const pendingEdit = provider.getPenditEdit();
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

			const pendingEdit = provider.getPenditEdit();
			if (!pendingEdit) {
				outputChannel?.appendLine('[Extension] No pending edit,Falling back to normal tab behaviour');
				return;
			}
			provider.getIntentTracker()?.recordRejectedSuggestion(
				editor.document.uri.fsPath,
				pendingEdit.deleteRange.start.line + 1,
				pendingEdit.insertText
			);
		}

	);


	context.subscriptions.push(providerDisposable, outputChannel, acceptCompletionCommand,rejectCompletionCommand);
}

// This method is called when your extension is deactivated
export function deactivate() { }
