import * as vscode from "vscode"
import { EnclosingScope } from "../../utils/types";
import { LspService } from "../lspService";
import { extractIdentifiers, getTruncationMarker } from "../../utils/languageUtils";
import { findImportLineSpans, ImportBindings, parseImportBindings } from "../../utils/importAnalysis";
import { LocalDependencyResolver } from "./localDependencyResolver";
export class PrefixStage {
    private readonly localDependencyResolver: LocalDependencyResolver;
    constructor(private readonly lspService: LspService) {
        this.localDependencyResolver = new LocalDependencyResolver(this.lspService);

    }
    async buildPrefix(document: vscode.TextDocument, position: vscode.Position) {
        if (position.line < 150) {
            return this.getVerbatimPrefix(document, position);
        }
        const scopes = await this.getEnclosingScopes(document, position);

        if (!scopes.enclosingFunction) {
            return this.buildSimplifiedPrefix(document, position, 150);
        }

        const functionStartLine = scopes.enclosingFunction.range.start.line;
        const linesFromFunctionStart = position.line - functionStartLine >= 150;

        return await this.buildScopedPrefix(document, position, scopes, linesFromFunctionStart);

    }
    private async buildScopedPrefix(document: vscode.TextDocument, position: vscode.Position, scopes: EnclosingScope, isLargeFunction: boolean): Promise<string> {
        const cursorLine = position.line;
        const functionStartLine = scopes.enclosingFunction?.range.start.line ?? cursorLine;
        const classHeaderLines = this.collectClassHeaderLines(document, scopes, functionStartLine)
        if (!isLargeFunction) {
            const functionLines = this.collectLinesToCursor(document, functionStartLine, position)

            const usedIdentifiers = extractIdentifiers([...classHeaderLines, ...functionLines].join('\n'), document.languageId)

            const usedImports = this.getUsedImports(document, usedIdentifiers);
            const sameFileDeps: string[] = await this.localDependencyResolver.collectSameFileDependencies(document, scopes, usedIdentifiers, position)

            return this.assemblePrefixParts(usedImports, sameFileDeps, classHeaderLines, functionLines).join('\n')
        }

        const functionSetupEnd = Math.min(functionStartLine + 30, cursorLine);
        const recentContextStart = Math.max(functionSetupEnd + 1, cursorLine - 100)
        const functionSetupLines = this.collectLinesToCursor(document, functionStartLine, new vscode.Position(functionSetupEnd + 1, 0))
        const recentContextLines = this.collectLinesToCursor(document, recentContextStart, new vscode.Position(position.line + 1, 0))

        const usedIdentifiers = extractIdentifiers([...classHeaderLines, ...functionSetupLines, recentContextLines].join('\n'), document.languageId)
        const usedImports = this.getUsedImports(document, usedIdentifiers);
        const sameFileDeps: string[] = await this.localDependencyResolver.collectSameFileDependencies(document, scopes, usedIdentifiers, position)

        let output = this.assemblePrefixParts(usedImports, sameFileDeps, classHeaderLines, functionSetupLines)

        if (recentContextLines.length > 0) {
            const skippedLines = recentContextStart - functionSetupEnd;

            if (skippedLines > 0) {
                output.push(getTruncationMarker(document.languageId, skippedLines))
            }

            output.push(...recentContextLines)

        }

        return output.join('\n')

    }

    private collectClassHeaderLines(document: vscode.TextDocument, scopes: EnclosingScope, functionStartLine: number): string[] {
        const classStartLine = scopes.enclosingClass?.range.start.line;
        if (classStartLine === undefined || classStartLine >= functionStartLine) {
            return []
        }
        const classHeaderEnd = this.findClassHeaderEnd(document, classStartLine);
        return this.collectLinesToCursor(document, classStartLine, new vscode.Position(classHeaderEnd + 1, 0))

    }

    private findClassHeaderEnd(document: vscode.TextDocument, classStartLine: number): number {
        if (document.languageId === 'python') {
            for (let i = classStartLine; i < document.lineCount; i++) {
                if (document.lineAt(i).text.includes(':')) {

                    return i;
                }
            }
            return classStartLine;
        }

        for (let i = classStartLine; i < Math.min(classStartLine + 10, document.lineCount); i++) {
            if (document.lineAt(i).text.includes('{')) {
                return i
            }
        }
        return classStartLine
    }
    private buildSimplifiedPrefix(document: vscode.TextDocument, position: vscode.Position, lineLimit: number) {
        const cursorLine = position.line;
        const startLine = Math.max(0, cursorLine - lineLimit);

        const recentLines = this.collectLinesToCursor(document, startLine, position);
        const usedIdentifiers = extractIdentifiers(recentLines.join('\n'), document.languageId);
        const usedImports = this.getUsedImports(document, usedIdentifiers);

        return this.assemblePrefixParts(usedImports, [], [], recentLines).join('\n');

    }

    private assemblePrefixParts(usedImports: string[], sameFileDeps: string[], classHeaderLines: string[], primaryLines: string[]): string[] {
        const output: string[] = [];
        if (usedImports.length > 0) {
            output.push(...usedImports)
        }
        if (sameFileDeps.length > 0) {
            output.push(...sameFileDeps)
        }
        if (classHeaderLines.length > 0) {
            output.push(...classHeaderLines)
        }
        if (primaryLines.length > 0) {
            output.push(...primaryLines)
        }

        return output;
    }

    private getUsedImports(document: vscode.TextDocument, usedIdentifiers: Set<string>): string[] {
        const languageId = document.languageId;
        const importSpans = findImportLineSpans(document.getText(), languageId);

        if (importSpans.length === 0) {
            return [];
        }
        if (usedIdentifiers.size === 0) {
            return [];
        }
        const usedImports: string[] = [];

        for (const span of importSpans) {
            const importLines: string[] = [];
            for (let i = span.start; i <= span.end && i < document.lineCount; i++) {
                importLines.push(document.lineAt(i).text);
            }
            const importText = importLines.join('\n');

            if (this.isAlwaysIncludedImportSpan(importLines, languageId)) {
                usedImports.push(...importLines)
                continue;
            }

            if (usedIdentifiers.size === 0) {
                continue;
            }

            const bindings = parseImportBindings(importText, languageId);
            const providedNames = Array.from(bindings.importedLocalNames);
            const isUsed = providedNames.some((name) => usedIdentifiers.has(name))

            if (isUsed) {
                usedImports.push(...importLines);
            }
        }

        return usedImports;

    }

    private isAlwaysIncludedImportSpan(lines: string[], languageId: string): boolean {
        if (languageId !== 'go' && languageId !== 'java') {
            return false;
        }
        const firstNonEmpty = lines.find((line) => line.trim() !== '')?.trim();
        return firstNonEmpty?.startsWith('package ') ?? false
    }
    private async getEnclosingScopes(document: vscode.TextDocument, position: vscode.Position): Promise<EnclosingScope> {
        const symbols = await this.lspService.getDocumentSymbols(document);
        const symbolsByName = new Map<string, vscode.DocumentSymbol[]>;
        let enclosingFunction: vscode.DocumentSymbol | null = null;
        let enclosingClass: vscode.DocumentSymbol | null = null;
        let functionDepth = -1;
        let classDepth = -1;


        const findEnclosing = (syms: vscode.DocumentSymbol[], depth: number) => {
            for (const symbol of syms) {
                const existing = symbolsByName.get(symbol.name);
                if (existing) {
                    existing.push(symbol);
                    return;
                }
                symbolsByName.set(symbol.name, [symbol]);

                if (symbol.range.contains(position)) {
                    if (this.isFunctionSymbol(symbol.kind) && depth >= functionDepth) {
                        enclosingFunction = symbol;
                        functionDepth = depth;
                    }
                    if (this.isClassSymbol(symbol.kind) && depth >= classDepth) {
                        enclosingClass = symbol;
                        classDepth = depth;
                    }
                }

                if (symbol.children && symbol.children.length > 0) {
                    findEnclosing(symbol.children, depth + 1)
                }
            }
        }
        findEnclosing(symbols, 0);
        return { enclosingFunction, enclosingClass, symbolsByName };


    }

    getVerbatimPrefix(document: vscode.TextDocument, position: vscode.Position) {
        return this.collectLinesToCursor(document, 0, position).join("\n");
    }

    private isFunctionSymbol(kind: vscode.SymbolKind): boolean {
        return [
            vscode.SymbolKind.Function,
            vscode.SymbolKind.Method,
            vscode.SymbolKind.Constructor
        ].includes(kind)
    }

    private isClassSymbol(kind: vscode.SymbolKind): boolean {
        return [
            vscode.SymbolKind.Class,
            vscode.SymbolKind.Interface,
            vscode.SymbolKind.Struct,
            vscode.SymbolKind.Enum,
        ].includes(kind)
    }

    collectLinesToCursor(document: vscode.TextDocument, startLine: number, position: vscode.Position): string[] {
        if (startLine > position.line) {
            return [];
        }

        const lines: string[] = []
        for (let i = startLine; i <= position.line; i++) {
            const lineText = document.lineAt(i).text;
            lines.push(i === position.line ? lineText.slice(0, position.character) : lineText)
        }

        return lines;
    }

}