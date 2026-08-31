import { EnclosingScope } from "../../utils/types";
import { LspService } from "../lspService";
import * as vscode from "vscode";

export class LocalDependencyResolver {
    constructor(private readonly lspService: LspService) { }

    async collectSameFileDependencies(document: vscode.TextDocument, scopes: EnclosingScope, usedIdentifiers: Set<string>, position: vscode.Position): Promise<string[]> {
        const output: string[] = [];
        const includedSymbols = new Set<string>();
        if (scopes.enclosingClass) {
            const classStartLine = scopes.enclosingClass.range.start.line;
            const classNamePosition = scopes.enclosingClass.selectionRange.start;
            const baseNames = await this.lspService.getSuperTypeNames(document, classNamePosition);

            for (const baseName of baseNames) {
                if(includedSymbols.has(baseName)){
                    continue;
                }
                const baseSymbol = this.findNearestSymbolBeforeLine(scopes.symbolsByName, baseName, classStartLine);
                if (!baseSymbol) {
                    continue;
                }
                output.push(' ');
                output.push(...this.getSymbolLines(document, baseSymbol));
                includedSymbols.add(baseName);
            }
        }

        for (const identifier of usedIdentifiers) {
            if (includedSymbols.has(identifier)) {
                continue;
            }
            const symbol=this.findNearestSymbolBeforeLine(scopes.symbolsByName, identifier, position.line);
            if (!symbol){
                continue;
            }
            output.push(' ');
            output.push(...this.getSymbolLines(document,symbol));
            includedSymbols.add(identifier);

        }

        return output;
    }

    private findNearestSymbolBeforeLine(symbolsByName: Map<string, vscode.DocumentSymbol[]>, name: string, lineExclusive: number): vscode.DocumentSymbol | null {
        const candidates = symbolsByName.get(name);

        if (!candidates || candidates.length === 0) {
            return null;
        }

        let best: vscode.DocumentSymbol | null = null;
        for (const candidate of candidates) {
            if (candidate.range.end.line >= lineExclusive ||!this.isClassSymbol(candidate.kind)) {
                continue;
            }
            if (!best || candidate.range.end.line > best.range.end.line) {
                best = candidate;
            }
        }
        return best;
    }
    private getSymbolLines(document: vscode.TextDocument, symbol: vscode.DocumentSymbol): string[] {
        const lines: string[] = [];
        for (let i = symbol.range.start.line; i <= symbol.range.end.line; i++) {
            const lineText = document.lineAt(i).text;
            lines.push(lineText);
        }

        return lines;
    }
    private isClassSymbol(kind: vscode.SymbolKind): boolean {
        return [
            vscode.SymbolKind.Class,
            vscode.SymbolKind.Interface,
            vscode.SymbolKind.Struct,
            vscode.SymbolKind.Enum,
        ].includes(kind);
    }
}