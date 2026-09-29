import * as vscode from "vscode";
import { CustomProviderConfig, ProviderSelection } from "../api/providers";
import { SystemPromptMode } from "./promptBuilder";
import { ModelPrice } from "../utils/pricing";

export interface TabCompletionConfig{
    //general
    enabled:boolean;
    //API keys
    fireworksApiKey:string;
    openrouterApiKey:string;
    groqApiKey:string;
    geminiApiKey:string;
    anthropicApiKey:string;
    customProviders:CustomProviderConfig[];
    //models
    provider:ProviderSelection;
    model:string;
    maxTokens:number;
    temperature:number;
    //instructions
    customInstructions:string;
    languageInstructions:Record<string,string>;
    systemPromptMode:SystemPromptMode;
    //latency
    debounceMs:number;
    //feature toggles
    useAst:boolean;
    useLsp:boolean;
    useCrossFileContext:boolean;
    useDeduplication:boolean;
    debugLogging:boolean;
    //usage
    showUsageInStatusBar:boolean;
    modelPricing:Record<string,ModelPrice>;
    fetchPricingCatalog:boolean;
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
    anthropicApiKey:'',
    customProviders:[],
    provider:'auto',
    model:'qwen/qwen3-32b',
    maxTokens:500,
    temperature:0.1,
    customInstructions:'',
    languageInstructions:{},
    systemPromptMode:'append',
    debounceMs:50,
    useAst:true,
    useLsp:true,
    useCrossFileContext:true,
    useDeduplication:true,
    debugLogging:false,
    showUsageInStatusBar:true,
    modelPricing:{},
    fetchPricingCatalog:true,
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
        const loaded={} as Record<keyof TabCompletionConfig,unknown>;
        for (const key of Object.keys(DEFAULTS) as (keyof TabCompletionConfig)[]){
            loaded[key]=config.get(key,DEFAULTS[key]);
        }
        const result=loaded as TabCompletionConfig;
        if(!Array.isArray(result.customProviders)){
            result.customProviders=[];
        }
        if(typeof result.languageInstructions!=='object' || result.languageInstructions===null){
            result.languageInstructions={};
        }
        if(typeof result.modelPricing!=='object' || result.modelPricing===null){
            result.modelPricing={};
        }
        if(result.systemPromptMode!=='replace'){
            result.systemPromptMode='append';
        }
        return result;
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
    get temperature():number {return this.cachedConfig.temperature;}
    get groqApiKey():string {return this.cachedConfig.groqApiKey;}
    get openrouterApiKey():string {return this.cachedConfig.openrouterApiKey;}
    get fireworksApiKey():string {return this.cachedConfig.fireworksApiKey;}
    get geminiApiKey():string {return this.cachedConfig.geminiApiKey;}
    get anthropicApiKey():string {return this.cachedConfig.anthropicApiKey;}
    get customProviders():CustomProviderConfig[] {return this.cachedConfig.customProviders;}
    get customInstructions():string {return this.cachedConfig.customInstructions;}
    get languageInstructions():Record<string,string> {return this.cachedConfig.languageInstructions;}
    get systemPromptMode():SystemPromptMode {return this.cachedConfig.systemPromptMode;}
    get debounceMs():number {return this.cachedConfig.debounceMs;}
    get useAst():boolean {return this.cachedConfig.useAst;}
    get useLsp():boolean {return this.cachedConfig.useLsp;}
    get useCrossFileContext():boolean {return this.cachedConfig.useCrossFileContext;}
    get useDeduplication():boolean {return this.cachedConfig.useDeduplication;}
    get debugLogging():boolean {return this.cachedConfig.debugLogging;}
    get showUsageInStatusBar():boolean {return this.cachedConfig.showUsageInStatusBar;}
    get modelPricing():Record<string,ModelPrice> {return this.cachedConfig.modelPricing;}
    get fetchPricingCatalog():boolean {return this.cachedConfig.fetchPricingCatalog;}
    get completionCacheMaxEntries():number {return this.cachedConfig.completionCacheMaxEntries;}
    get completionCacheTtlMs():number {return this.cachedConfig.completionCacheTtlMs;}
    get lspCacheMaxEntries():number {return this.cachedConfig.lspCacheMaxEntries;}

    /** A copy of the full current configuration. */
    snapshot():TabCompletionConfig{
        return {...this.cachedConfig};
    }

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
