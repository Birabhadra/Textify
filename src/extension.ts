import * as vscode from 'vscode';
import { InlineCompletionProvider } from './providers/inlineCompletionProvider';
import { ASTService } from './services/astService';
let provider:InlineCompletionProvider | undefined;
let outputChannel:vscode.OutputChannel | undefined;
let astService:ASTService|undefined;
export function activate(context: vscode.ExtensionContext) {
	outputChannel=vscode.window.createOutputChannel('Textify')
	outputChannel.appendLine('Textify extension activated')
	astService=new ASTService(context.extensionPath);
	astService.initialize().then(()=>{
		outputChannel?.appendLine('AST servicd initialized')
		const activeEditor=vscode.window.activeTextEditor;
		if(activeEditor){
			astService?.ensureLanguage(activeEditor.document.languageId);
		}
	});
	vscode.window.onDidChangeActiveTextEditor((editor)=>{
		if(editor && astService?.isReady){
			astService.ensureLanguage(editor.document.languageId);
		}
	})


	provider=new InlineCompletionProvider(astService,outputChannel);	
	const providerDisposable=vscode.languages.registerInlineCompletionItemProvider(
		{ pattern : '**'},
		provider
	)


	context.subscriptions.push(providerDisposable,outputChannel);
}

// This method is called when your extension is deactivated
export function deactivate() {}
