import * as vscode from "vscode"
export class SuffixStage{
    buildSuffixAfterRegion(document:vscode.TextDocument,position:vscode.Position){
        const output:string[]= [document.lineAt(position.line).text.slice(position.character)]

        const startLine=position.line+1;

        for(let i=startLine;i<Math.min(document.lineCount,position.line+3+1);i++){
            const lineText=document.lineAt(i).text;

            const trimmedLine=lineText.trim()

            if(trimmedLine===''){
                continue;
            }else if(trimmedLine.replace(/[{}\[\]()=;,.>]/g,'').trim() === ''){
                output.push(lineText)
            }else{
                break;
            }
        }
        return output.join('\n')
    }
}