import * as vscode from "vscode"
export interface ChatStreamChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string;
        };
        finish_reason: string | null;
    }>;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant',
    content: string;
}
export interface ReplacementEdit {
    insertText: string,
    startPosition: vscode.Position
}
export interface PendingCompletion {
    documentUri: string,
    edit: ReplacementEdit,
}
export type IntentType = 'added' | 'pasted' | 'edited' | 'accepted'
export interface PendingIntent {
    type: IntentType;
    filePath: string;
    originalContent: Map<number, string>;
    currentContent: Map<number, string>;
    startTime: number;
    lastActivityTime: number;
    affectedLines: Set<number>;
}

export interface IntentEntry {
    id: string;
    type: IntentType;
    filePath: string;
    lineRange: { start: number, end: number };
    content: string;
    timestamp: number;
    suggestionPreview?: string;
}

export interface EnclosingScope {
    enclosingFunction: vscode.DocumentSymbol | null;
    enclosingClass: vscode.DocumentSymbol | null;
    symbolsByName: Map<string, vscode.DocumentSymbol[]>;

}

export interface ReplacementRegion {
    text: string;
    range: vscode.Range;
}