import * as vscode from "vscode";
import { getConfig } from "../services/configurationService";
import { ApiProvider, getProvider, PROVIDERS } from "./providers";
import { ChatStreamChunk,ChatMessage} from "../utils/types";

export class ApiClient implements vscode.Disposable{
    private readonly outputChannel:vscode.OutputChannel;
    private pendingRequest: AbortController|null=null;
    constructor(outputChannel:vscode.OutputChannel){
        this.outputChannel=outputChannel;
    }

    getActiveProvider(): ApiProvider|null{
        const config=getConfig();
        const selection=config.provider;

        if (selection !== 'auto') {
            const provider=getProvider(selection);
            return provider && provider.apiKeyConfigKey && config[provider.apiKeyConfigKey] ? selection : null;
        }

        for (const provider of PROVIDERS) {
            if (config[provider.apiKeyConfigKey]) {return provider.id;}
        }

        return null;
    }

    async complete(
        messages:ChatMessage[],
    ): Promise<AsyncGenerator<string,void,unknown>>{
        const providerId=this.getActiveProvider();
        if (!providerId){
            throw new Error("No API key configured");
        }
        this.cancel();
        this.pendingRequest=new AbortController();

        const configService=getConfig();

        const maxTokens=configService.maxTokens;
        const provider=getProvider(providerId)!;

        const model=configService.model;

        const body: Record<string,unknown>={
            model,
            messages,
            max_tokens:maxTokens,
            stream:true,
            temperature:0.1

        };

        if (provider.extraBodyFields) {
            Object.assign(body, provider.extraBodyFields());
        }

        this.log(`[${providerId}] Request:model=${model},max_token=${maxTokens}`);
        return this.streamRequest(
            provider.endPoint,
            body,
            configService[provider.apiKeyConfigKey],
            this.pendingRequest.signal
        );

    }

    cancel():void{
        if(this.pendingRequest){
            this.pendingRequest.abort();
            this.pendingRequest=null;
        }
    }

    private async* streamRequest(
        endpoint:string,
        body:Record<string,unknown>,
        apiKey:string,
        signal:AbortSignal
    ):AsyncGenerator<string,void,unknown>{
        const response=await fetch(endpoint,{
            method:"POST",
            headers:{
                'Authorization':`Bearer ${apiKey}`,
                'Content-Type':'application/json'
            },
            body:JSON.stringify(body),
            signal,

        });
        if(!response.ok){
            const errorText=await response.text();
            throw new Error(`API Error ${response.status}:${errorText}`);
        }

        if(!response.body){
            throw new Error('No response body');
        }

        const reader=response.body.getReader();
        const decoder=new TextDecoder();

        let buffer='';

        try{
            while(true){
                const {done,value}=await reader.read();
                if (done){
                    break;
                }
                buffer+= decoder.decode(value,{stream:true});
                const lines=buffer.split('\n');

                buffer=lines.pop() || '';

                for(const line of lines){
                    if(line.startsWith('data: ')){
                        const data=line.slice(6);

                        if(data ==='[DONE]'){
                            return;
                        }
                        try{
                            const chunk=JSON.parse(data) as ChatStreamChunk;
                            if (chunk.choices && chunk.choices.length > 0 ){
                                const content =chunk.choices[0].delta?.content;
                                if (content){
                                    yield content;
                                }
                            }
                        }catch(error){
                            this.log(`parse error :${error}`);

                        }


                    }
                }
            }

        }finally{
            reader.releaseLock();
        }
    }
    private log(message:string):void{
        this.outputChannel.appendLine(`[ApiClient] ${message}`);
    }
    dispose() {
        this.cancel();
    }

}
