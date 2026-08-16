import * as vscode from 'vscode'
import {ChatMessage, PendingCompletion} from "../utils/types"
import { ApiClient } from '../api/apiClient';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly apiclient: ApiClient;
    private pendingCompletion: PendingCompletion|null=null;
    private lastCompletionText='';
    private lastCompletionPosition:vscode.Position|null=null;
    private lastCompletionUri:string|null=null;


    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.apiclient = new ApiClient(outputChannel);
    }
    async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionList | null> {
        try {
            this.log(`provideInlinecompletionitems called at ${position.line}:${position.character}`)
            const pendingCompletionResult=this.handleExistingPendingCompletion(document,position);
            if(pendingCompletionResult !== undefined){
                return pendingCompletionResult;
            }
            const prefix = document.getText(
                new vscode.Range(new vscode.Position(0, 0), position)
            )
            if (token.isCancellationRequested){
                this.log('Request cancelled');
                return null
            }
            let completion=''
            try {
                const messages:ChatMessage[]=[
                    { role: 'system', content: 'complete the code.Output Only the completion,no explanation' },
                    { role: 'user', content: prefix },
                ]
                completion=await this.callCompletionApi(messages,token)
                
            }catch(error){
                this.log(`Api Error: ${error}`);
                return null
            }
            this.pendingCompletion={
                documentUri:document.uri.toString(),
                edit:{
                    startPosition:position,
                    insertText:completion
                }
            }

            
            return this.createInlineCompletionList(completion,)
        } catch (error: any) {
            this.log(`unexpected error: ${error.message}`)
            return null;
        }
    }

    private createInlineCompletionList(text:string,range?:vscode.Range):vscode.InlineCompletionList{
        const newItem = new vscode.InlineCompletionItem(text,range);
        return { "items": [newItem] }

    }
    private handleExistingPendingCompletion(document:vscode.TextDocument,position:vscode.Position):vscode.InlineCompletionList|null|undefined{
        if (!this.pendingCompletion){
            return undefined
        }
        const pendingPosition=this.pendingCompletion.edit.startPosition;
        const pendingUri=this.pendingCompletion.documentUri

        if (document.uri.toString() !== pendingUri){
            this.clearPendingCompletion();
            return undefined
        }

        if (position.line !== pendingPosition.line){
            this.clearPendingCompletion();
            return undefined
        }

        if (position.character === pendingPosition.character){
            return this.createInlineCompletionList(this.pendingCompletion.edit.insertText);
        }

        this.clearPendingCompletion();
        return undefined;

        
    }

    private clearPendingCompletion():void{
        this.pendingCompletion=null;
    }
    private async callCompletionApi(
        messages: ChatMessage [],token:vscode.CancellationToken
    ){
        const generator = await this.apiclient.complete(messages)
        let result = '';

        for await (const chunk of generator) {
            if (token.isCancellationRequested) {
                this.apiclient.cancel();
                break;
            }
            result += chunk
        }
        return result

    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[provider] ${message}`)
    }

}