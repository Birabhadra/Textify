import { Tree } from "web-tree-sitter";
import { ReplacementRegion } from "../../utils/types";
import { findStatementEnd } from "../astAnalysis";
import { ASTService } from "../astService";
import * as vscode from "vscode"
export class ReplacementRegionStage {
    constructor(private readonly astService: ASTService) { }

    compute(document: vscode.TextDocument, position: vscode.Position): ReplacementRegion {
        const currentLine = document.lineAt(position.line).text;
        let textAfterCursor = currentLine.slice(position.character);
        let endLine = position.line;
        let endChar = currentLine.length;

        const shouldTryExtension = this.shouldExtendRegion(textAfterCursor)
        if (shouldTryExtension && textAfterCursor.length < 200) {
            const extension=this.extendToStatementEnd(document, position, 200 - textAfterCursor.length, 3)

            if(extension){
                textAfterCursor=extension.text;
                endLine=extension.endLine;
                endChar=extension.endChar; 
            }

        }
        return {text:textAfterCursor,range:new vscode.Range(position,new vscode.Position(endLine,endChar))}


    }

    private shouldExtendRegion(textAfterCursor: string): boolean {
        const trimmed = textAfterCursor.trim();
        if (trimmed.length === 0) {
            return false;
        }
        const opens = (trimmed.match(/[([{]/g) || []).length;
        const closes = (trimmed.match(/[)\]}]/g) || []).length;
        if (opens > closes) {
            return true;
        }
        const continuationEndings = [',', '+', '-', '*', '/', '&&', '||', '|', '&', '.', '->', '\\', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '>>=', '<<=', '**=', '//=', '...', '?', ':'];
        for (const ending of continuationEndings) {
            if (trimmed.endsWith(ending)) {
                return true;
            }
        }

        if (trimmed.length < 20) {
            const statementTerminators = [':', '{', '}', ':']
            const endsWithTerminator = statementTerminators.some((terminator) => {
                if (!endsWithTerminator) {
                    return true;
                }
            })
        }
        return false;

    }

    private extendToStatementEnd(document: vscode.TextDocument, position: vscode.Position, maxChars: number, maxLines: number): { text: string; endLine: number; endChar: number } | null {
        const startLine = position.line;
        const endLine = Math.min(document.lineCount - 1, startLine + maxLines);

        const lines: string[] = []
        for (let i = startLine; i <= endLine; i++) {
            lines.push(document.lineAt(i).text)
        }

        const regionText = lines.join('\n');
        return this.astService.withParsedTree(regionText, (tree) => {
            const result = findStatementEnd(
                tree,
                {
                    row: 0,
                    column: position.character,
                }
            )

            if (!result) {
                return null;
            }

            const absoluteEndLine = startLine + result.endLine;
            const absoluteEndChar = result.endChar;

            let text = document.lineAt(startLine).text.slice(position.character);
            for (let i = startLine + 1; i <= absoluteEndLine; i++) {
                text += `\n${document.lineAt(i).text}`;
            }

            if (text.length > maxChars) {
                return null;
            }

            return { text, endLine: absoluteEndLine, endChar: absoluteEndChar };
        })
    }
}