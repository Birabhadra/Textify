import * as vscode from 'vscode'
import {ChatMessage, PendingCompletion, ReplacementEdit} from "../utils/types"
import { ApiClient } from '../api/apiClient';
import { IntentTracker } from '../services/intentTracker';
import { CompletionCache } from '../cache/completionCache';
import { ContextGatherer } from '../services/contextGatherer';
import { ASTService } from '../services/astService';
import { PromptBuilder } from '../services/promptBuilder';
import { DeduplicationService } from '../services/deduplicationService';
import { DeletionDecoration } from '../ui/deletionDecoration';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly apiclient: ApiClient;
    private readonly intentTracker:IntentTracker;
    private readonly contextGatherer:ContextGatherer;
    private readonly completionCache:CompletionCache;
    private readonly promptBuilder:PromptBuilder;
    private readonly deDuplicationService:DeduplicationService;
    private readonly deletionDecoration:DeletionDecoration;
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
        this.deDuplicationService=new DeduplicationService();
        this.deletionDecoration=new DeletionDecoration();
    }
    getPenditEdit():ReplacementEdit|null{
        return this.pendingCompletion?.edit?? null;
    }

    getIntentTracker():IntentTracker{
        return this.intentTracker;
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
            const deDupResult=this.deDuplicationService.check(document,position,completion)

            if(!deDupResult.proceed){
                this.log(`deduplication rejected:${deDupResult.reasonText?? 'no reason provided'}`)
                return null;
            }
            completion=deDupResult.completion;
            const edit=this.computeMinimalReplacement(document,completionContext.replacementRegion.range.start,completionContext.replacementRegion.range.end,completion);

            if(!edit || edit.insertText.length===0){
                this.log('no changes detected in completion')
                return null;
            }
            this.completionCache.set(document,position,editHistoryHash,edit)


            return this.activateCompletion(document,edit);

        } catch (error: any) {
            this.log(`unexpected error: ${error.message}`)
            return null;
        }
    }
    private computeMinimalReplacement(document:vscode.TextDocument,regionStart:vscode.Position,regionEnd:vscode.Position,newText:string):ReplacementEdit|null{
        const oldText=document.getText(new vscode.Range(regionStart,regionEnd))
        if(oldText === newText){
            return null;
        }

        const minLength=Math.min(oldText.length,newText.length);
        let prefixLength=0
        while(prefixLength<minLength && oldText[prefixLength]===newText[prefixLength]){
            prefixLength++
        }
        let suffixLength=0
        const maxSuffixLength=minLength-prefixLength;
        while(suffixLength<maxSuffixLength && oldText[oldText.length-1-suffixLength]===newText[newText.length-1-suffixLength]){
            suffixLength++;
        }
        const oldDiffEnd=oldText.length-suffixLength;
        const newDiffEnd=newText.length-suffixLength;
        const deletedText=oldText.slice(prefixLength,oldDiffEnd);

        const regionStartOffset=document.offsetAt(regionStart);
        const actualDeleteStart=document.positionAt(regionStartOffset+prefixLength);
        const actualDeleteEnd=document.positionAt(regionStartOffset+oldDiffEnd)

        return{
            deleteRange:new vscode.Range(regionStart,actualDeleteEnd),
            insertText:newText.slice(0,newDiffEnd),
            deletedText,
            _actualDeleteRange:deletedText?new vscode.Range(actualDeleteStart,actualDeleteEnd):undefined,
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
        this.lastCompletionPosition=edit.deleteRange.start;
        this.lastCompletionUri=document.uri.toString();
        this.pendingCompletion={
            documentUri:document.uri.toString(),
            edit
        }
        if(edit.deletedText.length>0){
            const editor=vscode.window.activeTextEditor;
            if(editor && editor.document.uri.toString()===document.uri.toString()){
                const decorationRange=edit._actualDeleteRange??edit.deleteRange;
                this.deletionDecoration.showDeletion(editor,decorationRange);
            }
        }
        return this.createInlineCompletionList(edit.insertText,edit.deleteRange)
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
        const pendingPosition=this.pendingCompletion.edit.deleteRange.start;
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

    clearPendingCompletion():void{
        this.pendingCompletion=null;
        this.deletionDecoration.clearDecorations();
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

    dispose():void{
        this.deletionDecoration.dispose();
        this.completionCache.dispose();
        this.apiclient.dispose();
        this.intentTracker.dispose();
        this.contextGatherer.dispose();


    }


}