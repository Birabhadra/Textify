import * as vscode from 'vscode'
import {ChatMessage, PendingCompletion, ReplacementEdit} from "../utils/types"
import { ApiClient } from '../api/apiClient';
import { IntentTracker } from '../services/intentTracker';
import { CompletionCache } from '../cache/completionCache';
import { ContextGatherer } from '../services/contextGatherer';
import { ASTService } from '../services/astService';
import { PromptBuilder } from '../services/promptBuilder';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly apiclient: ApiClient;
    private readonly intentTracker:IntentTracker;
    private readonly contextGatherer:ContextGatherer;
    private readonly completionCache:CompletionCache;
    private readonly promptBuilder:PromptBuilder;
    private pendingCompletion: PendingCompletion|null=null;
    private lastCompletionText='';
    private lastCompletionPosition:vscode.Position|null=null;
    private lastCompletionUri:string|null=null;


    constructor(astService:ASTService,outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.apiclient = new ApiClient(outputChannel);
        this.intentTracker=new IntentTracker();
        this.completionCache=new CompletionCache();
        this.promptBuilder=new PromptBuilder();
        this.contextGatherer=new ContextGatherer(astService,this.intentTracker);
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
            const editHistoryHash=this.intentTracker.computeHash()
            const cachedResult=this.tryCachedCompletion(
                document,position,editHistoryHash
            )

            if(cachedResult){
                return cachedResult
            }
            //stage 3
            const tryContinuePredictionResult=this.tryContinuePrediction(document,position)
            if (tryContinuePredictionResult !== undefined){
                return tryContinuePredictionResult
            }
            const completionContext =await this.contextGatherer.gatherContext(document,position)
            const messages=this.promptBuilder.buildPrompt(completionContext)
            this.log(`completion context:${JSON.stringify(messages)}`)
            if (token.isCancellationRequested){
                this.log('Request cancelled');
                return null
            }
            let completion=''
            try {
                completion=await this.callCompletionApi(messages,token)
                
            }catch(error){
                this.log(`Api Error: ${error}`);
                return null
            }

            completion=this.cleanCompletionText(completion);
            const edit:ReplacementEdit={
                insertText:completion,
                startPosition:position

            }
            this.completionCache.set(document,position,editHistoryHash,edit)


            return this.activateCompletion(document,edit);

        } catch (error: any) {
            this.log(`unexpected error: ${error.message}`)
            return null;
        }
    }

    private cleanCompletionText(text: string): string {
        let cleaned = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        const explanationPattern = /\n\n(?:\/\/|\/\*|#|Note:|Explanation:)[\s\S]*$/;
        cleaned = cleaned.replace(explanationPattern, '');
        return cleaned.trimEnd();
    }


    private tryCachedCompletion(document:vscode.TextDocument,position:vscode.Position,editHistory:string):vscode.InlineCompletionList|undefined{
        const cachedEdit=this.completionCache.get(document,position,editHistory)

        this.log(`cache hit ${cachedEdit?.insertText}`)
        if(!cachedEdit){
            return undefined
        }

        return this.activateCompletion(document,cachedEdit)

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