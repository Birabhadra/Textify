import * as TreeSitter from 'web-tree-sitter';
import * as path from "path";

const LANGUAGE_MAP: Record<string,string>={
    typescript:'tree-sitter-typescript.wasm',
    typescriptreeact:'tree-sitter-tsx.wasm',
    javascript:'tree-sitter-javascript.wasm',
    javascriptreact:'tree-sitter-javascript.wasm',
    python:'tree-sitter-python.wasm',
    rust:'tree-sitter-rust.wasm',
    go:'tree-sitter-go.wasm',
    java:'tree-sitter-java.wasm',
    c:'tree-sitter-c.wasm',
    cpp:'tree-sitter-cpp.wasm',
};
export class ASTService{
    private readonly grammarDir:string;
    private readonly languageCache=new Map<string,TreeSitter.Language>();
    private parser:TreeSitter.Parser|null=null;
    private currentLanguageId:string|null=null;
    private _isReady=false;

    constructor(extensionPath:string){
        this.grammarDir=path.join(extensionPath,'grammars');
    }


    get isReady():boolean{
        return this._isReady;
    }

    async initialize():Promise<void>{
        try{
            const wasmPath=path.join(this.grammarDir,'web-tree-sitter.wasm');
            await TreeSitter.Parser.init({
                locateFile:()=>wasmPath
            });
            this.parser=new TreeSitter.Parser();
            this._isReady=true;
        }catch{
            this._isReady=false;
        }
    }
    async ensureLanguage(languageId:string):Promise<boolean>{
        if(!this._isReady || !this.parser) {return false;}

        const wasmfile=LANGUAGE_MAP[languageId];
        if(!wasmfile) {return false;}

        if(this.languageCache.has(wasmfile)){
            if(this.currentLanguageId !== languageId){
                this.parser.setLanguage(this.languageCache.get(wasmfile)!);
                this.currentLanguageId=languageId;
            }
            return true;
        }

        try{
            const wasmPath=path.join(this.grammarDir,wasmfile);
            const language=await TreeSitter.Language.load(wasmPath);
            this.languageCache.set(wasmfile,language);
            this.parser.setLanguage(language);
            this.currentLanguageId=languageId;
            return true;
        }catch(err){
            return false;
        }

    }
    parseSync(code:string):TreeSitter.Tree|null{
        if(!this._isReady || !this.parser) {return null;}

        return this.parser.parse(code);
    }

    withParsedTree<T>(code:string,fn:(tree:TreeSitter.Tree)=>T):T|null{
        const tree=this.parseSync(code);
        if(!tree) {return null;}
        try{
            return fn(tree);
        }finally{
            tree.delete();
        }
    }
    dispose():void{
        this.parser?.delete();
        this.parser=null;
        this.languageCache.clear();
        this._isReady=false;
    }

}