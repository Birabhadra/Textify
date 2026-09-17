import * as vscode from "vscode";
import { ProviderSelection } from "../api/providers";
export interface TabCompletionConfig{
    //general
    enabled:boolean;
    //API keys
    fireworksApiKey:string;
    openrouterApiKey:string;
    groqApiKey:string;
    geminiApiKey:string;
    //models
    provider:ProviderSelection;
    model:string;
    maxTokens:number;
    //feature toggles
    useAst:boolean;
    useLsp:boolean;
    useCrossFileContext:boolean;
    useDeduplication:boolean;
    //cache settings
    completionCacheMaxEntries:number;
    completionCacheTtlMs:number;
    lspCacheMaxEntries:number;
}


const DEFAULTS:TabCompletionConfig={
    enabled:true,
    fireworksApiKey:'',
    openrouterApiKey:'',
    groqApiKey:'',
    geminiApiKey:'',
    provider:'auto',
    model:'qwen/qwen3-32b',
    maxTokens:500,
    useAst:true,
    useLsp:true,
    useCrossFileContext:true,
    useDeduplication:true,
    completionCacheMaxEntries:100,
    lspCacheMaxEntries:100,
    completionCacheTtlMs:30000
};


export class ConfigurationService implements vscode.Disposable{
    private static instance:ConfigurationService|null=null;
    private cachedConfig: TabCompletionConfig;
    private readonly disposables:vscode.Disposable[]=[];
    private readonly changeListeners: Set<(config:TabCompletionConfig) => void>=new Set();

    private constructor(){
        this.cachedConfig=this.loadConfig();
        this.registerConfigChangeListener();

    }

    static getInstance():ConfigurationService{
        if (!ConfigurationService.instance){
            ConfigurationService.instance=new ConfigurationService();
        }

        return ConfigurationService.instance;
    }

    private registerConfigChangeListener():void{
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e)=>{
                if(e.affectsConfiguration('textify')){
                    this.cachedConfig=this.loadConfig();
                    this.notifyListeners();
                }
            })
        );
    }

    private loadConfig(): TabCompletionConfig{
        const config=vscode.workspace.getConfiguration('textify');
        return {
            enabled:config.get<boolean>('enabled',DEFAULTS.enabled),
            fireworksApiKey:config.get<string>('fireworksApiKey',DEFAULTS.fireworksApiKey),
            openrouterApiKey:config.get<string>('openrouterApiKey',DEFAULTS.openrouterApiKey),
            groqApiKey:config.get<string>('groqApiKey',DEFAULTS.groqApiKey),
            geminiApiKey:config.get<string>('geminiApiKey',DEFAULTS.geminiApiKey),
            provider:config.get<ProviderSelection>('provider',DEFAULTS.provider),
            model:config.get<string>('model',DEFAULTS.model),
            maxTokens:config.get<number>('maxTokens',DEFAULTS.maxTokens),
            useAst:config.get<boolean>('useAst',DEFAULTS.useAst),
            useLsp:config.get<boolean>('useLsp',DEFAULTS.useLsp),
            useCrossFileContext:config.get<boolean>('useCrossFileContext',DEFAULTS.useCrossFileContext),
            useDeduplication:config.get<boolean>('useDeduplication',DEFAULTS.useDeduplication),
            completionCacheMaxEntries:config.get<number>('completionCacheMaxEntries',DEFAULTS.completionCacheMaxEntries),
            lspCacheMaxEntries:config.get<number>('lspCacheMaxEntries',DEFAULTS.lspCacheMaxEntries),
            completionCacheTtlMs:config.get<number>('completionCacheTtlMs',DEFAULTS.completionCacheTtlMs)
        };
    }

    private notifyListeners():void{
        for (const listener of this.changeListeners){
            try{
                listener(this.cachedConfig);
            }catch{

            }
        }
    }

    get enabled():boolean {return this.cachedConfig.enabled;}
    get provider():ProviderSelection {return this.cachedConfig.provider;}
    get model():string {return this.cachedConfig.model;}
    get maxTokens():number {return this.cachedConfig.maxTokens;}
    get groqApiKey():string {return this.cachedConfig.groqApiKey;}
    get openrouterApiKey():string {return this.cachedConfig.openrouterApiKey;}
    get fireworksApiKey():string {return this.cachedConfig.fireworksApiKey;}
    get geminiApiKey():string {return this.cachedConfig.geminiApiKey;}
    get useAst():boolean {return this.cachedConfig.useAst;}
    get useLsp():boolean {return this.cachedConfig.useLsp;}
    get useCrossFileContext():boolean {return this.cachedConfig.useCrossFileContext;}
    get useDeduplication():boolean {return this.cachedConfig.useDeduplication;}
    get completionCacheMaxEntries():number {return this.cachedConfig.completionCacheMaxEntries;}
    get completionCacheTtlMs():number {return this.cachedConfig.completionCacheTtlMs;}
    get lspCacheMaxEntries():number {return this.cachedConfig.lspCacheMaxEntries;}

    onConfigChange(callback:(config:TabCompletionConfig)=>void):vscode.Disposable{
        this.changeListeners.add(callback);
        return {dispose: ()=> this.changeListeners.delete(callback)};
    }

    async updateSetting<K extends keyof TabCompletionConfig>(key:K,value:TabCompletionConfig[K]):Promise<void>{
        await vscode.workspace.getConfiguration('textify').update(key,value,vscode.ConfigurationTarget.Global);
    }

    async resetAll():Promise<void>{
        const config=vscode.workspace.getConfiguration('textify');
        for (const key of Object.keys(DEFAULTS) as (keyof TabCompletionConfig)[]){
            await config.update(key,undefined,vscode.ConfigurationTarget.Global);
        }
    }

    dispose() {
        this.disposables.forEach(d=>d.dispose());
        this.changeListeners.clear();
    }

}


export function getConfig():ConfigurationService {
    return ConfigurationService.getInstance();
}
