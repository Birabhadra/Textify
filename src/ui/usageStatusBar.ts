import * as vscode from "vscode";
import { getConfig } from "../services/configurationService";
import { formatCost, formatUsageReport, totalCost, totalTokens, formatTokens, UsageTracker } from "../services/usageTracker";

/** Status bar summary of this session's usage; click for the full report. */
export class UsageStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly tracker: UsageTracker) {
        this.item = vscode.window.createStatusBarItem('textify.usage', vscode.StatusBarAlignment.Right, 100);
        this.item.name = 'Textify Usage';
        this.item.command = 'textify.showUsage';
        this.disposables.push(
            this.item,
            tracker.onDidChange(() => this.scheduleRefresh()),
            getConfig().onConfigChange(() => this.refresh())
        );
        this.refresh();
    }

    private scheduleRefresh(): void {
        // Usage can change several times per completion; coalesce UI updates.
        if (!this.refreshTimer) {
            this.refreshTimer = setTimeout(() => {
                this.refreshTimer = undefined;
                this.refresh();
            }, 250);
        }
    }

    refresh(): void {
        if (!getConfig().showUsageInStatusBar || !getConfig().enabled) {
            this.item.hide();
            return;
        }
        const { session } = this.tracker.snapshot();
        const tokens = totalTokens(session);
        const cost = totalCost(session);
        const costText = cost.usd > 0 ? ` · ${formatCost(cost.usd)}` : '';
        this.item.text = tokens > 0 ? `$(pulse) ${formatTokens(tokens)} tok${costText}` : '$(pulse) Textify';

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown('**Textify usage — this session**\n\n');
        tooltip.appendCodeblock(formatUsageReport(session), 'text');
        tooltip.appendMarkdown('\nClick for session and all-time totals.');
        this.item.tooltip = tooltip;
        this.item.show();
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.disposables.forEach((d) => d.dispose());
    }
}
