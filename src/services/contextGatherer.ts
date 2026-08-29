import * as vscode from "vscode";
import { IntentTracker } from "./intentTracker";
import { PrefixStage } from "./contextStages/prefixStage";
import { LspService } from "./lspService";
import { ASTService } from "./astService";
import { SuffixStage } from "./contextStages/suffixStage";
import { CrossFileService } from "./crossFile/crossFileService";
import { CompletionContext } from "../utils/types";
import { ReplacementRegionStage } from "./contextStages/replacementRegionStage";


export class ContextGatherer implements vscode.Disposable {
    private readonly intentTracker: IntentTracker;
    private readonly prefixStage: PrefixStage;
    private readonly suffixStage: SuffixStage;
    private readonly lspService: LspService;
    private readonly replacementRegionStage:ReplacementRegionStage;
    private readonly crossFileService:CrossFileService;
    constructor(astService:ASTService,intentTracker: IntentTracker) {
        this.intentTracker = intentTracker;
        this.lspService = new LspService();
        this.prefixStage = new PrefixStage(this.lspService);
        this.suffixStage=new SuffixStage();
        this.crossFileService=new CrossFileService(this.lspService,astService);
        this.replacementRegionStage=new ReplacementRegionStage(astService);
    }

    async gatherContext(document: vscode.TextDocument, position: vscode.Position): Promise<CompletionContext> {
        const replacementRegion=this.replacementRegionStage.compute(document,position);
        const prefix= await this.prefixStage.buildPrefix(document, position) ?? '';
        const suffix=this.suffixStage.buildSuffixAfterRegion(document,replacementRegion.range.end) ?? '';
        const crossFileSymbols=await this.crossFileService.getRelevantSymbols(document,prefix);
        const editHistory = this.intentTracker.serialize();
        
        return {
            prefix,
            replacementRegion,
            suffixAfterRegion:suffix,
            crossFileSymbols,
            cursorPosition:position,
            filePath:vscode.workspace.asRelativePath(document.uri),
            editHistory,
            languageId:document.languageId

        };
    }
    dispose(): void {
        //no-operation for now
    }

}