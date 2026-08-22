import * as vscode from "vscode"
import { IntentTracker } from "./intentTracker"
import { PrefixStage } from "./contextStages/prefixStage";
import { LspService } from "./lspService";
import { ReplacementRegionStage } from "./contextStages/replacementRegionStage";
import { ASTService } from "./astService";
export class ContextGatherer implements vscode.Disposable {
    private readonly intentTracker: IntentTracker;
    private readonly prefixStage: PrefixStage;
    private readonly lspService: LspService;
    private readonly replacementRegionStage:ReplacementRegionStage;
    constructor(astService:ASTService,intentTracker: IntentTracker) {
        this.intentTracker = intentTracker;
        this.lspService = new LspService();
        this.prefixStage = new PrefixStage(this.lspService);
        this.replacementRegionStage=new ReplacementRegionStage(astService)
    }

    async gatherContext(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
        const replacementRegion=this.replacementRegionStage.compute(document,position)
        const prefix= await this.prefixStage.buildPrefix(document, position) ?? '';
        const editHistory = this.intentTracker.serialize()
        
        return replacementRegion.text;
    }
    dispose(): void {
        //no-operation for now
    }

}