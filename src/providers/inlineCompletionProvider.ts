import * as vscode from 'vscode';
import {ChatMessage, PendingCompletion, ReplacementEdit} from "../utils/types";
import { ApiClient } from '../api/apiClient';
import { IntentTracker } from '../services/intentTracker';
import { CompletionCache } from '../cache/completionCache';
import { ContextGatherer } from '../services/contextGatherer';
import { ASTService } from '../services/astService';
import { PromptBuilder } from '../services/promptBuilder';
import { DeduplicationService } from '../services/deduplicationService';
import { DeletionDecoration } from '../ui/deletionDecoration';
import { getConfig } from '../services/configurationService';
import { InstructionsService } from '../services/instructionsService';
import { ModelRefusalError } from '../api/transports';
import { formatSample, latencyTracker } from '../utils/latencyTracker';
import { UsageTracker } from '../services/usageTracker';

interface ApiCallResult {
    text: string;
    ttftMs: number;
    requestMs: number;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { listener.dispose(); resolve(); }, ms);
        const listener = token.onCancellationRequested(() => { clearTimeout(timer); listener.dispose(); resolve(); });
    });
}

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
    private readonly instructionsService:InstructionsService;
    private readonly disposables:vscode.Disposable[]=[];


    private readonly usageTracker:UsageTracker;

    constructor(astService:ASTService,outputChannel: vscode.OutputChannel,instructionsService:InstructionsService,usageTracker:UsageTracker=new UsageTracker()) {
        this.outputChannel = outputChannel;
        this.usageTracker=usageTracker;
        this.apiclient = new ApiClient(outputChannel,usageTracker);
        this.intentTracker=new IntentTracker();
        this.completionCache=new CompletionCache();
        this.promptBuilder=new PromptBuilder();
        this.contextGatherer=new ContextGatherer(astService,this.intentTracker);
        this.deDuplicationService=new DeduplicationService();
        this.deletionDecoration=new DeletionDecoration();
        this.instructionsService=instructionsService;
        this.disposables.push(
            // Warm the provider connection as soon as the user types after a pause, so TLS setup
            // overlaps with the debounce + context gathering instead of delaying the first token.
            vscode.workspace.onDidChangeTextDocument((e)=>{
                if(getConfig().enabled && e.document===vscode.window.activeTextEditor?.document){
                    this.apiclient.prewarm();
                }
            }),
            instructionsService.onDidChange(()=>this.completionCache.clear())
        );
        this.apiclient.prewarm(true);
    }

    getApiClient():ApiClient{
        return this.apiclient;
    }
    getPendingEdit():ReplacementEdit|null{
        return this.pendingCompletion?.edit?? null;
    }

    getIntentTracker():IntentTracker{
        return this.intentTracker;
    }
    async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionList | null> {
        try {
            this.log(`provideInlineCompletionItems called at ${position.line}:${position.character}`);
            if (!getConfig().enabled) {
                return null;
            }
            //stage 1
            const pendingCompletionResult=this.handleExistingPendingCompletion(document,position);
            if(pendingCompletionResult !== undefined){
                return pendingCompletionResult;
            }
            //stage 2 
            // Everything besides document content/position that changes what the model would say.
            const activeProvider=this.apiclient.getActiveProvider();
            const editHistoryHash=[
                this.intentTracker.computeHash(),
                this.instructionsService.hash(document),
                activeProvider?.id ?? 'none',
                this.apiclient.getActiveModel(activeProvider)
            ].join(':');
            const cachedResult=this.tryCachedCompletion(
                document,position,editHistoryHash
            );

            if(cachedResult){
                return cachedResult;
            }
            //stage 3
            const tryContinuePredictionResult=this.tryContinuePrediction(document,position);
            if (tryContinuePredictionResult !== undefined){
                return tryContinuePredictionResult;
            }
            if(!activeProvider){
                this.log('No provider configured; add an API key in the Textify settings panel');
                return null;
            }

            // Wait out bursts of typing: each aborted request also tears down its pooled socket.
            const debounceStart=performance.now();
            const debounceMs=getConfig().debounceMs;
            if(debounceMs>0 && context.triggerKind===vscode.InlineCompletionTriggerKind.Automatic){
                await delay(debounceMs,token);
                if(token.isCancellationRequested){
                    return null;
                }
            }
            const pipelineStart=performance.now();

            const completionContext =await this.contextGatherer.gatherContext(document,position);
            const contextDone=performance.now();
            const messages=this.promptBuilder.buildPrompt(completionContext,this.instructionsService.resolve(document));
            const promptDone=performance.now();
            if(getConfig().debugLogging){
                this.log(`completion context:${JSON.stringify(messages)}`);
            }
            if (token.isCancellationRequested){
                this.log('Request cancelled');
                return null;
            }
            let completion='';
            let apiResult:ApiCallResult;
            try {
                apiResult=await this.callCompletionApi(messages,token);
                completion=apiResult.text;
            }catch(error){
                if(error instanceof ModelRefusalError){
                    this.log('Model declined the request; discarding completion');
                }else if(!token.isCancellationRequested){
                    this.log(`Api Error: ${error}`);
                }
                return null;
            }
            if(token.isCancellationRequested){
                return null;
            }

            completion=this.cleanCompletionText(completion);
            completion=this.normalizeIndentation(completion,document);
            const deDupResult=getConfig().useDeduplication
                ? this.deDuplicationService.check(document,position,completion)
                : { proceed:true, completion };

            if(!deDupResult.proceed){
                this.log(`deduplication rejected:${deDupResult.reasonText?? 'no reason provided'}`);
                return null;
            }
            completion=deDupResult.completion;
            const edit=this.computeMinimalReplacement(document,completionContext.replacementRegion.range.start,completionContext.replacementRegion.range.end,completion);

            if(!edit || edit.insertText.length===0){
                this.log('no changes detected in completion');
                return null;
            }
            this.completionCache.set(document,position,editHistoryHash,edit);

            const sample={
                debounceMs:pipelineStart-debounceStart,
                contextMs:contextDone-pipelineStart,
                promptMs:promptDone-contextDone,
                ttftMs:apiResult.ttftMs,
                requestMs:apiResult.requestMs,
                totalMs:performance.now()-pipelineStart,
                provider:activeProvider.id,
                model:this.apiclient.getActiveModel(activeProvider),
                timestamp:Date.now()
            };
            latencyTracker.record(sample);
            this.log(`latency ${formatSample(sample)}`);


            this.usageTracker.recordSuggestionShown(false);
            return this.activateCompletion(document,edit);

        } catch (error: any) {
            this.log(`unexpected error: ${error.message}`);
            return null;
        }
    }
    private computeMinimalReplacement(document:vscode.TextDocument,regionStart:vscode.Position,regionEnd:vscode.Position,newText:string):ReplacementEdit|null{
        const oldText=document.getText(new vscode.Range(regionStart,regionEnd));
        if(oldText === newText){
            return null;
        }

        const minLength=Math.min(oldText.length,newText.length);
        let prefixLength=0;
        while(prefixLength<minLength && oldText[prefixLength]===newText[prefixLength]){
            prefixLength++;
        }
        let suffixLength=0;
        const maxSuffixLength=minLength-prefixLength;
        while(suffixLength<maxSuffixLength && oldText[oldText.length-1-suffixLength]===newText[newText.length-1-suffixLength]){
            suffixLength++;
        }
        const oldDiffEnd=oldText.length-suffixLength;
        const newDiffEnd=newText.length-suffixLength;
        const deletedText=oldText.slice(prefixLength,oldDiffEnd);

        const regionStartOffset=document.offsetAt(regionStart);
        const actualDeleteStart=document.positionAt(regionStartOffset+prefixLength);
        const actualDeleteEnd=document.positionAt(regionStartOffset+oldDiffEnd);

        return{
            deleteRange:new vscode.Range(regionStart,actualDeleteEnd),
            insertText:newText.slice(0,newDiffEnd),
            deletedText,
            _actualDeleteRange:deletedText?new vscode.Range(actualDeleteStart,actualDeleteEnd):undefined,
        };

    }

    private cleanCompletionText(text: string): string {
        let cleaned = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        const explanationPattern = /\n\n(?:\/\/|\/\*|#|Note:|Explanation:)[\s\S]*$/;
        cleaned = cleaned.replace(explanationPattern, '');
        return cleaned.trimEnd();
    }

    private normalizeIndentation(text: string, document: vscode.TextDocument): string {
        if (!text.includes('\n')) {
            return text;
        }

        const editor = vscode.window.activeTextEditor;
        const matchesTargetDocument = editor !== undefined && editor.document.uri.toString() === document.uri.toString();
        const insertSpaces = matchesTargetDocument ? editor!.options.insertSpaces !== false : true;
        const rawTabSize = matchesTargetDocument ? editor!.options.tabSize : undefined;
        const tabSize = typeof rawTabSize === 'number' && rawTabSize > 0 ? rawTabSize : 4;

        const lines = text.split('\n');
        for (let i = 1; i < lines.length; i++) {
            const leadingMatch = lines[i].match(/^[ \t]*/);
            const leading = leadingMatch ? leadingMatch[0] : '';
            if (!leading) {
                continue;
            }
            const rest = lines[i].slice(leading.length);

            if (insertSpaces) {
                if (leading.includes('\t')) {
                    lines[i] = leading.replace(/\t/g, ' '.repeat(tabSize)) + rest;
                }
            } else if (!leading.includes('\t') && leading.length % tabSize === 0) {
                lines[i] = '\t'.repeat(leading.length / tabSize) + rest;
            }
        }

        return lines.join('\n');
    }


    private tryCachedCompletion(document:vscode.TextDocument,position:vscode.Position,editHistory:string):vscode.InlineCompletionList|undefined{
        const cachedEdit=this.completionCache.get(document,position,editHistory);
        if(!cachedEdit){
            return undefined;
        }
        this.log('cache hit');

        this.usageTracker.recordSuggestionShown(true);
        return this.activateCompletion(document,cachedEdit);

    }
    private activateCompletion(document:vscode.TextDocument,edit:ReplacementEdit
    ):vscode.InlineCompletionList{
        this.lastCompletionText=edit.insertText;
        this.lastCompletionPosition=edit.deleteRange.start;
        this.lastCompletionUri=document.uri.toString();
        this.pendingCompletion={
            documentUri:document.uri.toString(),
            edit
        };
        if(edit.deletedText.length>0){
            const editor=vscode.window.activeTextEditor;
            if(editor && editor.document.uri.toString()===document.uri.toString()){
                const decorationRange=edit._actualDeleteRange??edit.deleteRange;
                this.deletionDecoration.showDeletion(editor,decorationRange);
            }
        }
        return this.createInlineCompletionList(edit.insertText,edit.deleteRange);
    }

    private tryContinuePrediction(document:vscode.TextDocument,position:vscode.Position):vscode.InlineCompletionList|null|undefined{
        if(!this.lastCompletionText||!this.lastCompletionPosition||this.lastCompletionUri !== document.uri.toString()){
            return undefined;
        }
        const charSinceCompletion=position.character-this.lastCompletionPosition.character;
        if(position.line!==this.lastCompletionPosition.line || charSinceCompletion<=0){
            return undefined;
        }

        const typedText=document.getText(
            new vscode.Range(this.lastCompletionPosition,position)
        );
        if (charSinceCompletion<=this.lastCompletionText.length && this.lastCompletionText.startsWith(typedText)){
            const remaining=this.lastCompletionText.slice(typedText.length);

            if (remaining){
                this.log(`Continuing prediction: Typed "${typedText}",remaining "${remaining}"`);
                return this.createInlineCompletionList(remaining,new vscode.Range(position,position));
            }

            this.log(`user completed entire prediction`);
            this.lastCompletionText='';
            this.lastCompletionPosition=null;
            return null;
        }

        this.log(`Divergence Detected: expected ${this.lastCompletionText}, got ${typedText}`);
        this.lastCompletionText='';
        this.lastCompletionPosition=null;
        return undefined;
    }

    private createInlineCompletionList(text:string,range?:vscode.Range):vscode.InlineCompletionList{
        const newItem = new vscode.InlineCompletionItem(text,range);
        return { "items": [newItem] };

    }
    private handleExistingPendingCompletion(document:vscode.TextDocument,position:vscode.Position):vscode.InlineCompletionList|null|undefined{
        if (!this.pendingCompletion){
            return undefined;
        }
        const pendingPosition=this.pendingCompletion.edit.deleteRange.start;
        const pendingUri=this.pendingCompletion.documentUri;

        if (document.uri.toString() !== pendingUri){
            this.clearPendingCompletion();
            return undefined;
        }

        if (position.line !== pendingPosition.line){
            this.clearPendingCompletion();
            return undefined;
        }

        if (position.character === pendingPosition.character){
            return this.createInlineCompletionList(this.pendingCompletion.edit.insertText);
        }

        this.clearPendingCompletion();
        return undefined;

        
    }

    clearPendingCompletion():void{
        this.pendingCompletion=null;
        this.lastCompletionText='';
        this.lastCompletionPosition=null;
        this.lastCompletionUri=null;
        this.deletionDecoration.clearDecorations();
    }
    private async callCompletionApi(
        messages: ChatMessage [],token:vscode.CancellationToken
    ):Promise<ApiCallResult>{
        const start=performance.now();
        let firstTokenAt=0;
        const cancelListener=token.onCancellationRequested(()=>this.apiclient.cancel());
        try{
            const generator = await this.apiclient.complete(messages);
            let text = '';
            for await (const chunk of generator) {
                if (!firstTokenAt){
                    firstTokenAt=performance.now();
                }
                if (token.isCancellationRequested) {
                    this.apiclient.cancel();
                    break;
                }
                text += chunk;
            }
            const end=performance.now();
            return {text,ttftMs:(firstTokenAt||end)-start,requestMs:end-start};
        }finally{
            cancelListener.dispose();
        }
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[provider] ${message}`);
    }

    dispose():void{
        this.disposables.forEach(d=>d.dispose());
        this.deletionDecoration.dispose();
        this.completionCache.dispose();
        this.apiclient.dispose();
        this.intentTracker.dispose();
        this.contextGatherer.dispose();


    }


}