import * as vscode from 'vscode';
import { InlineCompletionProvider } from './providers/inlineCompletionProvider';
let provider:InlineCompletionProvider | undefined;
let outputChannel:vscode.OutputChannel | undefined
export function activate(context: vscode.ExtensionContext) {
	outputChannel=vscode.window.createOutputChannel('Textify')
	outputChannel.appendLine('Textify extension activated')


	provider=new InlineCompletionProvider(outputChannel);	
	const providerDisposable=vscode.languages.registerInlineCompletionItemProvider(
		{ pattern : '**'},
		provider
	)


	context.subscriptions.push(providerDisposable,outputChannel);
}

// This method is called when your extension is deactivated
export function deactivate() {}
