import * as vscode from 'vscode'
import {ChatMessage, PendingCompletion, ReplacementEdit} from "../utils/types"
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
            //stage 1
            const pendingCompletionResult=this.handleExistingPendingCompletion(document,position);
            if(pendingCompletionResult !== undefined){
                return pendingCompletionResult;
            }
            //stage 2 
            //stage 3
            const tryContinuePredictionResult=this.tryContinuePrediction(document,position)
            if (tryContinuePredictionResult !== undefined){
                return tryContinuePredictionResult
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

            const edit:ReplacementEdit={
                insertText:completion,
                startPosition:position

            }
            return this.activateCompletion(document,edit);

        } catch (error: any) {
            this.log(`unexpected error: ${error.message}`)
            return null;
        }
    }
    private activateCompletion(document:vscode.TextDocument,edit:ReplacementEdit
    ):vscode.InlineCompletionList{
        this.lastCompletionText=edit.insertText;
        this.lastCompletionPosition=edit.startPosition;
        this.lastCompletionUri=document.uri.toString();
        this.pendingCompletion={
            documentUri:document.uri.toString(),
            edit
        }
        return this.createInlineCompletionList(edit.insertText)
    }

    private tryContinuePrediction(document:vscode.TextDocument,position:vscode.Position):vscode.InlineCompletionList|null|undefined{
        if(!this.lastCompletionText||!this.lastCompletionPosition||this.lastCompletionUri !== document.uri.toString()){
            return undefined
        }
        const charSinceCompletion=position.character-this.lastCompletionPosition.character
        if(position.line!=this.lastCompletionPosition.line || charSinceCompletion<=0){
            return undefined
        }

        const typedText=document.getText(
            new vscode.Range(this.lastCompletionPosition,position)
        )
        if (charSinceCompletion<=this.lastCompletionText.length && this.lastCompletionText.startsWith(typedText)){
            const remaining=this.lastCompletionText.slice(typedText.length)

            if (remaining){
                this.log(`Continuing prediction: Typed "${typedText}",remaining "${remaining}"`)
                return this.createInlineCompletionList(remaining,new vscode.Range(position,position))
            }

            this.log(`user completed entire prediction`);
            this.lastCompletionText='';
            this.lastCompletionPosition=null;
            return null;
        }

        this.log(`Divergence Detected: expected ${this.lastCompletionText}, got ${typedText}`);
        this.lastCompletionText='';
        this.lastCompletionPosition=null;
        return undefined
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