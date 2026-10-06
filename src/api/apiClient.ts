import * as vscode from "vscode";
import { getConfig } from "../services/configurationService";
import {
    ProviderDefinition,
    getProviderApiKey,
    resolveActiveProvider,
    resolveModel
} from "./providers";
import { ChatMessage } from "../utils/types";
import { streamAnthropic, streamOpenAICompatible, TokenUsage, TransportRequest } from "./transports";
import { RequestOutcome, UsageTracker } from "../services/usageTracker";

export interface CompleteOptions {
    /** Use this provider instead of the configured one (e.g. "Test connection"). */
    provider?: ProviderDefinition;
    model?: string;
    maxTokens?: number;
    /** Independent request: don't cancel/replace the in-flight completion request. */
    detached?: boolean;
    signal?: AbortSignal;
}

// Node's fetch keeps idle sockets for ~4s. Re-open the TLS connection when the user starts typing
// after a pause so the completion request doesn't pay for DNS + TCP + TLS on the critical path.
const PREWARM_IDLE_MS = 3000;

export class ApiClient implements vscode.Disposable{
    private readonly outputChannel:vscode.OutputChannel;
    private pendingRequest: AbortController|null=null;
    private lastNetworkActivity=0;
    private prewarmInFlight=false;

    constructor(outputChannel:vscode.OutputChannel,private readonly usageTracker?:UsageTracker){
        this.outputChannel=outputChannel;
    }

    getActiveProvider(): ProviderDefinition|null{
        return resolveActiveProvider(getConfig());
    }

    /** The model that will actually be sent for the active provider. */
    getActiveModel(provider:ProviderDefinition|null=this.getActiveProvider()):string{
        return provider ? resolveModel(provider,getConfig().model) : getConfig().model;
    }

    async complete(
        messages:ChatMessage[],
        options:CompleteOptions={}
    ): Promise<AsyncGenerator<string,void,unknown>>{
        const provider=options.provider ?? this.getActiveProvider();
        if (!provider){
            throw new Error("No API key configured");
        }
        const configService=getConfig();

        let signal:AbortSignal;
        if (options.detached){
            signal=options.signal ?? new AbortController().signal;
        }else{
            this.cancel();
            this.pendingRequest=new AbortController();
            signal=this.pendingRequest.signal;
        }

        const model=options.model ?? resolveModel(provider,configService.model);
        const usage:TokenUsage[]=[];
        const request:TransportRequest={
            endpoint:provider.endPoint,
            apiKey:getProviderApiKey(provider,configService),
            model,
            messages,
            maxTokens:options.maxTokens ?? configService.maxTokens,
            temperature:configService.temperature,
            signal,
            extraBody:provider.extraBodyFields?.(),
            onUsage:(entries)=>usage.push(...entries)
        };

        this.log(`[${provider.id}] Request: model=${model}, max_tokens=${request.maxTokens}`);
        this.lastNetworkActivity=Date.now();
        return this.trackActivity(
            provider.format==='anthropic' ? streamAnthropic(request) : streamOpenAICompatible(request),
            signal,
            usage,
            provider.id
        );
    }

    /**
     * Opens (or refreshes) a pooled connection to the active provider's host, off the critical path.
     * Cheap: a HEAD request whose status we ignore.
     */
    prewarm(force=false):void{
        if (this.prewarmInFlight){
            return;
        }
        if (!force && Date.now()-this.lastNetworkActivity<PREWARM_IDLE_MS){
            return;
        }
        const provider=this.getActiveProvider();
        if (!provider){
            return;
        }
        let origin:string;
        try{
            origin=new URL(provider.endPoint).origin;
        }catch{
            return;
        }
        this.prewarmInFlight=true;
        this.lastNetworkActivity=Date.now();
        fetch(origin,{method:'HEAD',signal:AbortSignal.timeout(5000)})
            .then((response)=>response.body?.cancel())
            .catch(()=>undefined)
            .finally(()=>{
                this.prewarmInFlight=false;
                this.lastNetworkActivity=Date.now();
            });
    }

    cancel():void{
        if(this.pendingRequest){
            this.pendingRequest.abort();
            this.pendingRequest=null;
        }
    }

    private async* trackActivity(source:AsyncGenerator<string,void,unknown>,signal:AbortSignal,usage:TokenUsage[],providerId:string):AsyncGenerator<string,void,unknown>{
        const start=performance.now();
        // Stays 'cancelled' if the consumer stops early (break / abort) without an error.
        let outcome:RequestOutcome='cancelled';
        try{
            for await (const chunk of source){
                this.lastNetworkActivity=Date.now();
                yield chunk;
            }
            outcome='completed';
        }catch(error){
            outcome=signal.aborted ? 'cancelled' : 'failed';
            throw error;
        }finally{
            this.lastNetworkActivity=Date.now();
            // Usage arrives from the transport's own `finally`, which has run by now.
            this.usageTracker?.recordRequest(outcome,performance.now()-start,usage,providerId);
        }
    }

    private log(message:string):void{
        this.outputChannel.appendLine(`[ApiClient] ${message}`);
    }
    dispose() {
        this.cancel();
    }

}
