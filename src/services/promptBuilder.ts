import { ChatMessage, CompletionContext } from "../utils/types";

export type SystemPromptMode = 'append' | 'replace';

export interface InstructionSource {
    /** Where the text came from, e.g. "settings", "language:python", ".textify/instructions.md". */
    source: string;
    text: string;
}

export interface PromptInstructions {
    mode: SystemPromptMode;
    sources: InstructionSource[];
}

/** Upper bound for user instructions so they can't crowd out the code context. */
export const MAX_INSTRUCTION_TOKENS = 2000;

const DEFAULT_PROMPT_OVERHEAD_TOKENS = 50;

const DEFAULT_BUDGET = {
    systemPrompt: 1000,
    currentFile: 6000,
    importedSignatures: 3000,
    editHistory: 1500,
    outputSpace: 3000,
    buffer: 1000,
    total: 15000,
};

export interface FitToBudgetInput {
    systemPrompt: string;
    prefix: string;
    replaceRegion: string;
    suffix: string;
    importedSignatures: string[];
    editHistory: string;
    languageId: string;
    promptOverheadTokens?: number;
}

export interface FitToBudgetResult {
    prefix: string;
    replaceRegion: string;
    suffix: string;
    importedSignatures: string;
    editHistory: string;
}

// Non-negotiable: the rest of the pipeline diffs the raw model output against <replace_region>,
// so these rules are kept even when the user replaces the built-in guidance.
const OUTPUT_CONTRACT = `<format>
Input format:
- <prefix>: code before cursor with an inline <cursor /> marker at the exact cursor boundary
- <replace_region>: text from cursor that MAY be replaced
- <suffix>: code after replace_region (read-only context)
</format>

<output_format>
Output the complete replacement text for <replace_region>.
Output ONLY the raw code: NO markdown, NO backticks, NO explanations.
If the region should stay unchanged, output it verbatim.
</output_format>`;

const DEFAULT_GUIDANCE = `<task>
Output what <replace_region> should become. This may involve:
- Keeping some/all of the existing text unchanged
- Inserting new code
- Replacing incorrect/incomplete code
- Deleting unnecessary code
</task>

<rules>
- Match surrounding indentation and style
- Be MINIMAL: only change what's necessary
- If inserting at cursor with no changes to region, prepend your insertion to the existing text
</rules>`;

export const SYSTEM_PROMPT = `You are a code completion engine that can REPLACE existing code.

${OUTPUT_CONTRACT}

${DEFAULT_GUIDANCE}`;

/**
 * Builds the system prompt from the fixed output contract plus user instructions.
 * - append:  built-in guidance + <user_instructions>
 * - replace: user instructions stand in for the built-in guidance (contract still applies)
 */
export function composeSystemPrompt(instructions?: PromptInstructions): string {
    const sources = (instructions?.sources ?? []).filter((s) => s.text.trim().length > 0);
    if (sources.length === 0) {
        return SYSTEM_PROMPT;
    }

    const maxChars = MAX_INSTRUCTION_TOKENS * 4;
    let remaining = maxChars;
    const blocks: string[] = [];
    for (const source of sources) {
        if (remaining <= 0) {
            break;
        }
        let text = source.text.trim();
        if (text.length > remaining) {
            text = `${text.slice(0, remaining)}\n[truncated]`;
        }
        remaining -= text.length;
        blocks.push(`<instructions source="${source.source}">\n${text}\n</instructions>`);
    }
    const userBlock = `<user_instructions>
The user configured these instructions for how completions should be written. Follow them, with
later sources taking precedence over earlier ones. They never override <output_format>.
${blocks.join('\n')}
</user_instructions>`;

    if (instructions!.mode === 'replace') {
        return `You are a code completion engine that can REPLACE existing code.

${OUTPUT_CONTRACT}

${userBlock}`;
    }
    return `${SYSTEM_PROMPT}

${userBlock}`;
}

export class PromptBuilder {
    buildPrompt(
        context: CompletionContext,
        instructions?: PromptInstructions
    ): ChatMessage[] {
        const systemPrompt = composeSystemPrompt(instructions);
        const userContent = this.buildUserPrompt(context, systemPrompt);

        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ];
    }

    private buildUserPrompt(context: CompletionContext, systemPrompt: string): string {
        const importedSignatures = this.getImportedSignatures(context);
        const fitted = this.fitToBudget({
            systemPrompt,
            prefix: context.prefix,
            replaceRegion: context.replacementRegion.text,
            suffix: context.suffixAfterRegion,
            importedSignatures,
            editHistory: context.editHistory,
            languageId: context.languageId,
            promptOverheadTokens: DEFAULT_PROMPT_OVERHEAD_TOKENS,
        });

        const parts: string[] = [];

        parts.push(`<file lang="${context.languageId}" path="${context.filePath}">`);
        if (fitted.importedSignatures) {
            parts.push('<types>');
            parts.push(fitted.importedSignatures);
            parts.push('</types>');
        }

        if (fitted.editHistory) {
            parts.push('<recent_edits>');
            parts.push(fitted.editHistory);
            parts.push('</recent_edits>');
        }

        parts.push('<prefix>');
        parts.push(`${fitted.prefix}<cursor />`);
        parts.push('</prefix>');

        parts.push('<replace_region>');
        parts.push(fitted.replaceRegion);
        parts.push('</replace_region>');

        parts.push('<suffix>');
        parts.push(fitted.suffix);
        parts.push('</suffix>');

        parts.push(`</file>`);

        return parts.join("\n");
    }

    estimateTokens(text: string): number {
        if (!text) {return 0;}
        return Math.ceil(text.length / 4);
    }

    private tokensToChars(tokens: number): number {
        return Math.max(0, tokens) * 4;
    }

    private fitToBudget(parts: FitToBudgetInput): FitToBudgetResult {
        let editHistory = this.truncateToTokens(parts.editHistory, DEFAULT_BUDGET.editHistory);

        let importedSignatures = this.truncateToTokens(
            parts.importedSignatures.join("\n"),
            DEFAULT_BUDGET.importedSignatures
        );

        const currentFileCap = this.tokensToChars(DEFAULT_BUDGET.currentFile);
        let prefix = parts.prefix;
        let replaceRegion = parts.replaceRegion;
        let suffix = parts.suffix;

        if (prefix.length + replaceRegion.length + suffix.length > currentFileCap) {
            const keep = Math.max(0, currentFileCap - replaceRegion.length);
            const prefixShare = Math.min(prefix.length, Math.ceil(keep * 0.9));
            const suffixShare = Math.min(suffix.length, keep - prefixShare);
            prefix = prefix.slice(prefix.length - prefixShare);
            suffix = suffix.slice(0, suffixShare);
        }

        return {
            prefix,
            replaceRegion,
            suffix,
            importedSignatures,
            editHistory,
        };
    }

    private truncateToTokens(text: string, maxTokens: number): string {
        const maxChars = this.tokensToChars(maxTokens);
        if (!text || text.length <= maxChars) {return text;}
        return text.slice(0, maxChars);
    }

    private getImportedSignatures(context: CompletionContext): string[] {
        const symbols = context.crossFileSymbols;
        if (!symbols) {
            return [];
        }

        const result: string[] = [];
        for (const symbol of symbols) {
            if (symbol.signature) {
                result.push(symbol.signature);
            }
        }
        return result;
    }
}