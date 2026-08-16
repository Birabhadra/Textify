import * as vscode from "vscode"
export interface TabCompletionConfig{
    //API keys
    fireworksApiKey:string;
    openrouterApiKey:string;
    groqApiKey:string;
    //models
    model:string;
    maxTokens:number;
    //cache settings
}


const DEFAULTS:TabCompletionConfig={
    fireworksApiKey:'',
    openrouterApiKey:'',
    groqApiKey:'',
    model:'qwen/qwen3-32b',
    maxTokens:500
}


export class ConfigurationService implements vscode.Disposable{
    private static instance:ConfigurationService|null=null
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
        )
    }

    private loadConfig(): TabCompletionConfig{
        const config=vscode.workspace.getConfiguration('textify')
        return {
            fireworksApiKey:config.get<string>('fireworksApiKey',DEFAULTS.fireworksApiKey),
            openrouterApiKey:config.get<string>('openrouterApiKey',DEFAULTS.openrouterApiKey),
            groqApiKey:config.get<string>('groqApiKey',DEFAULTS.groqApiKey),
            model:config.get<string>('model',DEFAULTS.model),
            maxTokens:config.get<number>('maxTokens',DEFAULTS.maxTokens)
        }
    }

    private notifyListeners():void{
        for (const listener of this.changeListeners){
            try{
                listener(this.cachedConfig);
            }catch{

            }
        }
    }

    get model():string {return this.cachedConfig.model}
    get maxTokens():number {return this.cachedConfig.maxTokens}
    get groqApiKey():string {return this.cachedConfig.groqApiKey}
    get openrouterApiKey():string {return this.cachedConfig.openrouterApiKey}
    get fireworksApiKey():string {return this.cachedConfig.fireworksApiKey}

    onConfigChange(callback:(config:TabCompletionConfig)=>void):vscode.Disposable{
        this.changeListeners.add(callback);
        return {dispose: ()=> this.changeListeners.delete(callback)}
    }
    dispose() {
        this.disposables.forEach(d=>d.dispose());
        this.changeListeners.clear();
    }

}


export function getConfig():ConfigurationService {
    return ConfigurationService.getInstance();
}