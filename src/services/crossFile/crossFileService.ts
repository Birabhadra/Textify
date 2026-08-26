import * as vscode from "vscode";
import { LspService } from "../lspService";
import { ASTService } from "../astService";
import { SymbolIndex } from "./symbolIndex";
import { IndexedSymbol } from "../../utils/types";
import { ReferenceExtractor } from "./referenceExtractor";
import { SignatureProvider } from "./signatureProvider";

export class CrossFileService implements vscode.Disposable{
    private readonly astService:ASTService;
    private readonly  lspService:LspService;
    private readonly symbolIndex:SymbolIndex
    private readonly referenceExtractor:ReferenceExtractor;
    private readonly signatureProvider:SignatureProvider
    private readonly disposables:vscode.Disposable[]=[]
    constructor(lspService:LspService,astService:ASTService){
        this.astService=astService;
        this.lspService=lspService;
        this.symbolIndex=new SymbolIndex(this.lspService);
        this.referenceExtractor=new ReferenceExtractor(this.astService)
        this.signatureProvider=new SignatureProvider(this.astService)
        this.registerListeners()
    }

    async getRelevantSymbols(document:vscode.TextDocument,prefix:string):Promise<IndexedSymbol[]>{
        const nearbyContext=this.referenceExtractor.extract(prefix,document.languageId);        
        if(nearbyContext.referenceNames.size === 0){
            return []
        }
        const allSymbols=this.symbolIndex.getAllSymbols();
        const candidateSymbols=allSymbols.filter(symbol=>symbol.uri !== document.uri.toString() && !nearbyContext.declaredIdentifiers.has(symbol.name));
        const referencedCandidates=candidateSymbols.filter(symbol=>nearbyContext.referenceNames.has(symbol.name) && symbol.kind !== vscode.SymbolKind.Method && symbol.kind !== vscode.SymbolKind.Constructor)
        if(referencedCandidates.length === 0){
            return []
        }
        const result=this.signatureProvider.extract(referencedCandidates)
        return result;
    }
    private registerListeners():void{
        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument((doc)=>{
                this.symbolIndex.indexDocument(doc);
                
            }),
            vscode.workspace.onDidOpenTextDocument((doc)=>{
                this.symbolIndex.indexDocument(doc);
            })
        )
    }
    dispose() {
        this.disposables.forEach((d)=> d.dispose())
        this.signatureProvider.clear()
        this.symbolIndex.clear();
    }

}