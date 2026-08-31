import * as vscode from "vscode";
import { getConfig } from "../services/configurationService";
export type ApiProvider='openrouter'|'groq'|'fireworks'
import { ChatStreamChunk,ChatMessage} from "../utils/types";
interface ProviderConfig{
    endPoint:string;
    getApiKey:()=>string;
    getModel:()=>string;
}

const PROVIDER_CONFIGS: Record<ApiProvider,ProviderConfig>={
    openrouter:{
        endPoint:"https://openrouter.ai/api/v1/chat/completions",
        getApiKey:()=> getConfig().openrouterApiKey,
        getModel:()=> getConfig().model
    },
    groq:{
        endPoint:"https://api.groq.com/openai/v1/chat/completions",
        getApiKey:()=> getConfig().groqApiKey,
        getModel:()=> getConfig().model
    },
    fireworks:{
        endPoint:"https://api.fireworks.ai/inference/v1/chat/completions",
        getApiKey:()=> getConfig().fireworksApiKey,
        getModel:()=> getConfig().model
    }
};

export class ApiClient implements vscode.Disposable{
    private readonly outputChannel:vscode.OutputChannel;
    private pendingRequest: AbortController|null=null;
    constructor(outputChannel:vscode.OutputChannel){
        this.outputChannel=outputChannel;
    }
    
    getActiveProvider(): ApiProvider|null{
        const config=getConfig();
        if (config.openrouterApiKey) {return 'openrouter';}
        if (config.groqApiKey) {return 'groq';}
        if (config.fireworksApiKey) {return 'fireworks';}

        return null;
    }

    async complete(
        messages:ChatMessage[],
    ): Promise<AsyncGenerator<string,void,unknown>>{
        const provider=this.getActiveProvider();
        if (!provider){
            throw new Error("No API key configured");
        }
        this.cancel();
        this.pendingRequest=new AbortController();

        const configService=getConfig();

        const maxTokens=configService.maxTokens;
        const ProviderConfig=PROVIDER_CONFIGS[provider];

        const model=ProviderConfig.getModel();

        const body: Record<string,unknown>={
            model,
            messages,
            max_tokens:maxTokens,
            stream:true,
            temperature:0.1

        };

        if (provider === 'groq') {
            body['reasoning_effort'] = 'none';
        }
        
        this.log(`[${provider}] Request:model=${model},max_token=${maxTokens}`);
        return this.streamRequest(
            ProviderConfig.endPoint,
            body,
            ProviderConfig.getApiKey(),
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