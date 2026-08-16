import * as vscode from "vscode"
export interface ChatStreamChunk{
    id:string;
    object:string;
    created:number;
    model:string;
    choices: Array<{
        index:number;
        delta: {
            role?:string;
            content?:string;
        };
        finish_reason:string|null;
    }>;
}

export interface ChatMessage{
    role:'system'|'user'|'assistant',
    content:string;
}
export interface ReplacementEdit{
    insertText:string,
    startPosition: vscode.Position
}
export interface PendingCompletion{
    documentUri:string,
    edit:ReplacementEdit,
}