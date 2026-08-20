import * as vscode from "vscode"
import { IntentTracker } from "./intentTracker"
import { PrefixStage } from "./contextStages/prefixStage";
import { LspService } from "./lspService";
export class ContextGatherer implements vscode.Disposable {
    private readonly intentTracker: IntentTracker;
    private readonly prefixStage: PrefixStage;
    private readonly lspService: LspService;
    constructor(intentTracker: IntentTracker) {
        this.intentTracker = intentTracker;
        this.lspService = new LspService();
        this.prefixStage = new PrefixStage(this.lspService);
    }

    async gatherContext(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
        const editHistory = this.intentTracker.serialize()
        return await this.prefixStage.buildPrefix(document, position) ?? '';


    }
    dispose(): void {
        //no-operation for now
    }

}