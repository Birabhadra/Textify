import * as vscode from 'vscode'
export class DeletionDecoration implements vscode.Disposable {
    private readonly decorationType: vscode.TextEditorDecorationType;
    private readonly disposables: vscode.Disposable[] = [];
    private activeEditor:vscode.TextEditor | null=null;
    constructor() {
        this.decorationType = vscode.window.createTextEditorDecorationType(
            {
                backgroundColor: `rgba(255,100,100,0.3)`,
                textDecoration: 'line-through',
                color: 'rgba(150,150,150,0.9)'
            }
        )

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.clearDecorations();
            })
        )

        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection((e)=>{
                if(this.activeEditor && e.textEditor=== this.activeEditor){
                    const selection=e.selections[0];
                    if(selection && !selection.isEmpty){
                        this.clearDecorations();
                    }
                }
            })
        )

    }
    showDeletion(editor:vscode.TextEditor,range:vscode.Range):void{
        this.clearDecorations();
        if(range.isEmpty){
            return;
        }
        this.activeEditor=editor;
        editor.setDecorations(this.decorationType,[range]);
    }

    clearDecorations() {
        if (this.activeEditor) {
            this.activeEditor.setDecorations(this.decorationType, [])
        }
        this.activeEditor=null;
    }

    dispose() {
        this.clearDecorations();
        this.decorationType.dispose();
        this.disposables.forEach(d=>d.dispose())
    }

}