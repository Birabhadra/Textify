import * as vscode from "vscode"
import { IntentEntry, IntentType, PendingIntent } from "../utils/types";
import * as crypto from "crypto"

export class IntentTracker implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private buffer:IntentEntry[]=[];
    private lastDocumentVersion: Map<string, number> = new Map();
    private pendingIntent: PendingIntent | null = null;
    private flushTimeout:NodeJS.Timeout| null =null;
    private idCOunter:number=0;


    constructor() {
        this.registerListeners()
    }

    computeHash():string{
        const content=this.buffer.map(
            e=>`${e.filePath}:${e.timestamp}:${e.type}:${e.content}`
        ).join("|");
        return crypto.createHash('md5').update(content).digest('hex').slice(0,16)
    }
    private registerListeners() {
        //Track the text changes in a document
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                this.handleDocumentChange(e);

            })
        );

        //Track the active editor changes(1 file to another)
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this.handleActiveEditorChange(editor)

            })
        );


    }

    private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const document = event.document;
        if (document.uri.scheme !== 'file') {
            return
        }

        const activeEditor = vscode.window.activeTextEditor;

        if (!activeEditor || activeEditor.document.uri.toString() !== document.uri.toString()) {
            return;
        }
        ///add clear up flush timeout (do it later)

        const dockey = document.uri.toString();
        const previousVersion = this.lastDocumentVersion.get(dockey);
        const currentVersion = document.version;
        this.lastDocumentVersion.set(dockey, currentVersion)

        if (previousVersion !== undefined && Math.abs(currentVersion - previousVersion) > 1) {
            if (this.pendingIntent && this.pendingIntent.filePath === document.uri.fsPath) {
                this.pendingIntent = null;
                this.clearFlushTimeout();
            }
            return;

        }

        for (const change of event.contentChanges) {
            this.processChange(document, change)
        }


    }
    private processChange(document: vscode.TextDocument, change: vscode.TextDocumentContentChangeEvent): void {
        const filePath = document.uri.fsPath;
        const now = Date.now();
        const line = change.range.start.line
        const isPaste = change.text.length > 50;
        const currentLineContent = line < document.lineCount ? document.lineAt(line).text : '';

        const canContinuePending = this.pendingIntent && this.pendingIntent.filePath == filePath && (now - this.pendingIntent.lastActivityTime < 1500);

        if (!canContinuePending) {
            this.finalizeIntent();
        }
        if (!this.pendingIntent) {
            this.pendingIntent = {
                type: isPaste ? 'pasted' : 'added',
                filePath,
                originalContent: new Map(),
                currentContent: new Map(),
                startTime: now,
                lastActivityTime: now,
                affectedLines: new Set()
            }
        }

        this.captureOriginalLineContent(change, line, currentLineContent);

        this.pendingIntent.currentContent.set(line, currentLineContent);
        this.pendingIntent.affectedLines.add(line);
        this.pendingIntent.lastActivityTime = now;
        if (isPaste) {
            this.pendingIntent.type = 'pasted';
        }

        this.pendingIntent.type = this.classifyIntentType(this.pendingIntent);
        this.scheduleFLush()



    }

    private classifyIntentType(pendingIntent: PendingIntent):IntentType {
        if (pendingIntent.type === 'pasted') {
            return "pasted"
        }
        let hasAddition=false;
        let hasEdit=false;
        for (const line of pendingIntent.affectedLines){
            const original=pendingIntent.originalContent.get(line)?? '';
            const current=pendingIntent.currentContent.get(line) ?? '';

            if(original.trim().length=== 0 && current.trim().length>0){
                hasAddition=true
            }else if (original.trim() !== current.trim()){
                hasEdit=true
            }
        }
        if (hasEdit) return 'edited';
        if (hasAddition) return 'added';
        return 'edited';
    }
    private captureOriginalLineContent(change: vscode.TextDocumentContentChangeEvent, line: number, currentLineContent: string) {
        if (this.pendingIntent?.originalContent.has(line)) {
            return;
        }

        let originalLineContent = currentLineContent;
        if (change.rangeLength == 0 && change.text.length > 0) {
            const startChar = change.range.start.character;
            originalLineContent = currentLineContent.slice(0, startChar) + currentLineContent.slice(startChar + change.text.length)

        }
        this.pendingIntent?.originalContent.set(
            line,
            originalLineContent
        )
    }

    private scheduleFLush():void{
        this.clearFlushTimeout();
        this.flushTimeout=setTimeout(()=>{
            this.finalizeIntent();
        },1500)
    }
    private clearFlushTimeout():void{
        if(this.flushTimeout){
            clearTimeout(this.flushTimeout);
            this.flushTimeout=null;
        }
    }
    private finalizeIntent(): void {
        this.clearFlushTimeout();
        if(!this.pendingIntent) return;
        const pending=this.pendingIntent;
        this.pendingIntent=null;

        let hasChange=false;

        for (const line of pending.affectedLines){
            const original=pending.originalContent.get(line)??'';
            const current=pending.currentContent.get(line)??'';

            if(original !== current){
                hasChange=true;
                break;
            }
        }

        if(!hasChange) return;  

        const lines=Array.from(pending.affectedLines).sort((a,b)=>a-b);
        const startLine=lines[0]+1;
        const endLine=lines[lines.length-1]+1
        const contentLines:string[]=[]

        for (const line of lines){
            const content=pending.currentContent.get(line);
            if(content!=undefined){
                contentLines.push(content)
            }
        }
        const content=contentLines.join('\n');

        const entry:IntentEntry={
            id:`intent_${++this.idCOunter}`,
            type:pending.type,
            filePath:pending.filePath,
            lineRange:{start:startLine,end:endLine},
            content,
            timestamp:pending.lastActivityTime,
        }

        const merged=this.mayBeMergeWithRecent(entry);

        if(merged){
            const idx=this.buffer.findIndex(e=>e.id === merged.id)
            if(idx!==-1){
                this.buffer[idx]=merged;
            }else{
                this.buffer.push(entry);
                while (this.buffer.length>35){
                    this.buffer.shift()
                }
            }
        }

    }

    private mayBeMergeWithRecent(
        entry:IntentEntry
    ):IntentEntry |null{
        const now=Date.now();

        for(let i=this.buffer.length-1;i>=0;i--){
            const existing=this.buffer[i];

            if (now-existing.timestamp > 5000){
                break;
            }

            if(existing.filePath !== entry.filePath){
                continue;
            }

            const overlap=existing.lineRange.start<=entry.lineRange.end && entry.lineRange.start <= existing.lineRange.end;

            const adjacent=Math.abs(existing.lineRange.end - entry.lineRange.start) <=1 || Math.abs(entry.lineRange.end - existing.lineRange.start) 

            if(overlap || adjacent){
                const mergedType:IntentType=(existing.type==='edited'|| entry.type==='edited')?'edited':(existing.type==='pasted'|| entry.type==='pasted')?'pasted':entry.type

                const mergedRange={
                    start:Math.min(existing.lineRange.start,entry.lineRange.start),
                    end:Math.max(existing.lineRange.end,entry.lineRange.end)
                }

                return{

                    id:existing.id,
                    type:mergedType,
                    content:entry.content,
                    timestamp:entry.timestamp,
                    lineRange:mergedRange,
                    filePath:entry.filePath
                }

            }
        }
        return null;

    }
    private handleActiveEditorChange(editor: vscode.TextEditor | undefined): void {
        if(!this.pendingIntent) return;
        if(!editor|| editor.document.uri.fsPath !== this.pendingIntent.filePath){
            this.finalizeIntent();
        }

    }

    private getRelativePath(filePath:string):string{
        const workspaceFolders=vscode.workspace.workspaceFolders;

        if(!workspaceFolders || workspaceFolders.length ===0){
            return filePath.split('/').pop() || filePath;
        }

        for(const folder of workspaceFolders){
            if(filePath.startsWith(folder.uri.fsPath)){
                return filePath.slice(folder.uri.fsPath.length+1)
            }
        }
        return filePath.split('/').pop() || filePath;

    }

    serialize():string{
        this.finalizeIntent();

        if(this.buffer.length==0){
            return '';
        }

        const entries=this.buffer.slice(-35);
        const lines:string[]=[]

        for(let i=0;i<entries.length;i++){
            const entry=entries[i];
            const relativePath=this.getRelativePath(entry.filePath)
            const lineRange=entry.lineRange.start===entry.lineRange.end ? `${entry.lineRange.start}`:`${entry.lineRange.start}-${entry.lineRange.end}`

            lines.push(`${i+1}. [${entry.type}] ${relativePath}: ${lineRange} -> "${entry.content}"`)

        }

        return lines.join('\n')



    }

    recordAcceptedSuggestion(filePath:string,line:number,content:string):void{
        this.finalizeIntent();
        const entry:IntentEntry={
            id:`intent_${++this.idCOunter}`,
            type:`accepted`,
            filePath,
            lineRange:{start:line,end:line},
            content,
            timestamp:Date.now()
        }
        this.buffer.push(entry);
        while(this.buffer.length>35){
            this.buffer.shift()
        }
    }
    recordRejectedSuggestion(filePath:string,line:number,content:string):void{
        const entry:IntentEntry={
            id:`intent_${++this.idCOunter}`,
            type:`rejected`,
            filePath,
            lineRange:{start:line,end:line},
            content,
            timestamp:Date.now()
        }
        this.buffer.push(entry);
        while(this.buffer.length>35){
            this.buffer.shift()
        }
    }


    dispose() {
        this.finalizeIntent();
        this.disposables.forEach(d=>d.dispose());
        this.clearFlushTimeout();
    }

}