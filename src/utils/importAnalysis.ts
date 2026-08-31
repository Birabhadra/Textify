import { isJavaScriptOrTypeScript } from "./languageUtils";

export interface LineSpan {
    start: number;
    end: number;
}

export interface ImportBindings {
    /** Original names from import statements (before any aliases) */
    importedOriginalNames: Set<string>; // import { foo as bar } → "foo".
    /** Map from original name to all aliases used for it */
    importedAliasesByOriginal: Map<string, Set<string>>; // import { foo as bar } → "foo" → Set(["bar"]).
    /** All local names available after imports (aliases take precedence) */
    importedLocalNames: Set<string>; // import { foo as bar } → "bar"; import { foo } → "foo".
}

export function removeLineSpans(text: string, spans: LineSpan[]): string {
    if (spans.length === 0) {
        return text;
    }

    const lines = text.split('\n');
    const toRemove = new Set<number>();

    for (const span of spans) {
        for (let i = span.start; i <= span.end && i < lines.length; i++) {
            toRemove.add(i);
        }
    }

    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!toRemove.has(i)) {
            kept.push(lines[i]);
        }
    }

    return kept.join('\n');
}
export function findImportLineSpans(text: string, languageId: string): LineSpan[] {
    const lines = text.split('\n');
    const spans: LineSpan[] = [];

    if (isJavaScriptOrTypeScript(languageId)) {
        findJsTsImportSpans(lines, spans);
    } else if (languageId === 'python') {
        findPythonImportSpans(lines, spans);
    } else if (languageId === 'rust') {
        findRustImportSpans(lines, spans);
    } else if (languageId === 'go') {
        findGoImportSpans(lines, spans);
    } else if (languageId === 'java') {
        findJavaImportSpans(lines, spans);
    } else if (languageId === 'c' || languageId === 'cpp') {
        findCIncludeSpans(lines, spans);
    }

    return spans;
}
function findJsTsImportSpans(lines: string[], spans: LineSpan[]): void {
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();

        // Check for import statement
        if (trimmed.startsWith('import ') ||
            trimmed.startsWith('export ') && trimmed.includes(' from ') ||
            /^\s*(const|let|var)\s+\w+\s*=\s*require\s*\(/.test(lines[i])) {
            const startLine = i;

            // Check if it's a multi-line import (has { but no })
            if (trimmed.includes('{') && !trimmed.includes('}')) {
                // Find closing brace
                while (i < lines.length && !lines[i].includes('}')) {
                    i++;
                }
            }
            // Check if it spans multiple lines (no semicolon or 'from' yet)
            else if (!trimmed.endsWith(';') && !trimmed.includes(' from ')) {
                // Continue until we find 'from' or semicolon
                while (i < lines.length &&
                    !lines[i].includes(' from ') &&
                    !lines[i].trim().endsWith(';')) {
                    i++;
                }
            }

            spans.push({ start: startLine, end: i });
            i++;
            continue;
        }

        // Skip past import region (usually at top of file)
        if (i > 0 && spans.length > 0 && trimmed !== '' &&
            !trimmed.startsWith('//') && !trimmed.startsWith('/*') &&
            !trimmed.startsWith('*') && !trimmed.startsWith('import') &&
            !trimmed.startsWith('export') && !trimmed.includes('require(')) {
            // Check if we're still in the import region (allow blank/comment lines)
            if (i > spans[spans.length - 1].end + 10) {
                break;
            }
        }

        i++;
    }
}

function findPythonImportSpans(lines: string[], spans: LineSpan[]): void {
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();

        if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
            const startLine = i;
            let parenDepth = (lines[i].match(/\(/g) || []).length -
                (lines[i].match(/\)/g) || []).length;

            // Multi-line with parentheses
            if (parenDepth > 0) {
                while (i < lines.length && parenDepth > 0) {
                    i++;
                    if (i < lines.length) {
                        parenDepth += (lines[i].match(/\(/g) || []).length;
                        parenDepth -= (lines[i].match(/\)/g) || []).length;
                    }
                }
            }
            // Multi-line with backslash continuation
            else if (trimmed.endsWith('\\')) {
                while (i < lines.length && lines[i].trim().endsWith('\\')) {
                    i++;
                }
            }

            spans.push({ start: startLine, end: i });
            i++;
            continue;
        }

        // Stop at non-import code (but allow blank lines and comments)
        if (trimmed !== '' && !trimmed.startsWith('#') &&
            !trimmed.startsWith('"""') && !trimmed.startsWith("'''")) {
            if (spans.length > 0 && i > spans[spans.length - 1].end + 5) {
                break;
            }
        }

        i++;
    }
}

function findRustImportSpans(lines: string[], spans: LineSpan[]): void {
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();

        if (trimmed.startsWith('use ') || trimmed.startsWith('pub use ') ||
            trimmed.startsWith('mod ') || trimmed.startsWith('pub mod ')) {
            const startLine = i;

            // Find end of statement (semicolon)
            while (i < lines.length && !lines[i].includes(';')) {
                i++;
            }

            spans.push({ start: startLine, end: i });
            i++;
            continue;
        }

        // Stop at non-import code
        if (trimmed !== '' && !trimmed.startsWith('//') &&
            !trimmed.startsWith('/*') && !trimmed.startsWith('*') &&
            !trimmed.startsWith('#[')) {
            if (spans.length > 0 && i > spans[spans.length - 1].end + 5) {
                break;
            }
        }

        i++;
    }
}

function findGoImportSpans(lines: string[], spans: LineSpan[]): void {
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();

        if (trimmed.startsWith('import ') || trimmed === 'import(' || trimmed === 'import (') {
            const startLine = i;

            // Check for multi-line import block
            if (trimmed.includes('(') || trimmed === 'import(' || trimmed === 'import (') {
                // Find closing paren
                while (i < lines.length && !lines[i].trim().startsWith(')')) {
                    i++;
                }
            }

            spans.push({ start: startLine, end: i });
            i++;
            continue;
        }

        // Also capture package declaration
        if (trimmed.startsWith('package ')) {
            spans.push({ start: i, end: i });
            i++;
            continue;
        }

        // Stop at non-import code
        if (trimmed !== '' && !trimmed.startsWith('//') &&
            !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
            if (spans.length > 0 && i > spans[spans.length - 1].end + 5) {
                break;
            }
        }

        i++;
    }
}

function findJavaImportSpans(lines: string[], spans: LineSpan[]): void {
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();

        if (trimmed.startsWith('import ') || trimmed.startsWith('package ')) {
            // Java imports are single-line
            spans.push({ start: i, end: i });
            i++;
            continue;
        }

        // Stop at non-import code (class/interface/etc)
        if (trimmed !== '' && !trimmed.startsWith('//') &&
            !trimmed.startsWith('/*') && !trimmed.startsWith('*') &&
            !trimmed.startsWith('@')) {
            if (spans.length > 0) {
                break;
            }
        }

        i++;
    }
}

function findCIncludeSpans(lines: string[], spans: LineSpan[]): void {
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (trimmed.startsWith('#include')) {
            // Check for line continuation
            let endLine = i;
            while (endLine < lines.length && lines[endLine].trimEnd().endsWith('\\')) {
                endLine++;
            }
            spans.push({ start: i, end: endLine });
        }
        // Also handle #pragma once, #ifndef guards, etc.
        else if (trimmed.startsWith('#pragma') ||
            trimmed.startsWith('#ifndef') ||
            trimmed.startsWith('#define') ||
            trimmed.startsWith('#endif')) {
            // Skip these but don't treat as end of import region
        }
        // Stop at actual code
        else if (trimmed !== '' && !trimmed.startsWith('//') &&
            !trimmed.startsWith('/*') && !trimmed.startsWith('*')) {
            if (spans.length > 0) {
                break;
            }
        }
    }
}

export function parseImportBindings(text: string, languageId: string): ImportBindings {
    const importedOriginalNames = new Set<string>();
    const importedAliasesByOriginal = new Map<string, Set<string>>();
    const importedLocalNames = new Set<string>();

    const recordBinding = (original: string, local?: string): void => {
        const orig = original.trim();
        if (!orig) {return;}

        importedOriginalNames.add(orig);

        const localName = (local ?? original).trim();
        if (!localName) {return;}

        let aliases = importedAliasesByOriginal.get(orig);
        if (!aliases) {
            aliases = new Set();
            importedAliasesByOriginal.set(orig, aliases);
        }
        aliases.add(localName);
        importedLocalNames.add(localName);
    };

    if (isJavaScriptOrTypeScript(languageId)) {
        parseJsTsImports(text, recordBinding);
    } else if (languageId === 'python') {
        parsePythonImports(text, recordBinding);
    } else if (languageId === 'rust') {
        parseRustImports(text, recordBinding);
    } else if (languageId === 'go') {
        parseGoImports(text, recordBinding);
    } else if (languageId === 'java') {
        parseJavaImports(text, recordBinding);
    }
    // C/C++ includes don't really have bindings

    return { importedOriginalNames, importedAliasesByOriginal, importedLocalNames };
}

function parseJsTsImports(text: string, record: (orig: string, local?: string) => void): void {
    // Default imports: import Foo from 'module'
    const defaultPattern = /import\s+(?:type\s+)?(\w+)\s+from\s+['"][^'"]+['"]/g;
    let match;
    while ((match = defaultPattern.exec(text)) !== null) {
        record(match[1], match[1]);
    }

    // Named imports: import { Foo, Bar as Baz } from 'module'
    const namedPattern = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
    while ((match = namedPattern.exec(text)) !== null) {
        const names = match[1].split(',');
        for (const name of names) {
            const asMatch = name.match(/(\w+)\s+as\s+(\w+)/);
            if (asMatch) {
                record(asMatch[1], asMatch[2]);
            } else {
                const cleanName = name.trim().replace(/^type\s+/, '');
                if (cleanName && /^\w+$/.test(cleanName)) {
                    record(cleanName, cleanName);
                }
            }
        }
    }

    // Namespace imports: import * as Foo from 'module'
    const nsPattern = /import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
    while ((match = nsPattern.exec(text)) !== null) {
        record(match[1], match[1]);
    }

    // require: const Foo = require('module')
    const requirePattern = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"][^'"]+['"]\s*\)/g;
    while ((match = requirePattern.exec(text)) !== null) {
        record(match[1], match[1]);
    }

    // Destructured require: const { Foo, Bar } = require('module')
    const destructuredRequirePattern = /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"][^'"]+['"]\s*\)/g;
    while ((match = destructuredRequirePattern.exec(text)) !== null) {
        const names = match[1].split(',');
        for (const name of names) {
            const asMatch = name.match(/(\w+)\s*:\s*(\w+)/);
            if (asMatch) {
                record(asMatch[1], asMatch[2]);
            } else {
                const cleanName = name.trim();
                if (cleanName && /^\w+$/.test(cleanName)) {
                    record(cleanName, cleanName);
                }
            }
        }
    }
}

function parsePythonImports(text: string, record: (orig: string, local?: string) => void): void {
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const trimmed = lines[i].trim();

        // from module import names
        const fromMatch = trimmed.match(/^from\s+(\S+)\s+import\s+(.+)$/);
        if (fromMatch) {
            let importPart = fromMatch[2];

            // Handle multi-line imports
            if (importPart.includes('(') && !importPart.includes(')')) {
                i++;
                while (i < lines.length && !lines[i].includes(')')) {
                    importPart += ' ' + lines[i].trim();
                    i++;
                }
                if (i < lines.length) {
                    importPart += ' ' + lines[i].trim();
                }
            } else if (importPart.endsWith('\\')) {
                while (i < lines.length && lines[i].trim().endsWith('\\')) {
                    i++;
                    if (i < lines.length) {
                        importPart += ' ' + lines[i].trim().replace(/\\$/, '');
                    }
                }
            }

            // Parse the names
            importPart = importPart.replace(/[()]/g, '');
            const names = importPart.split(',');
            for (const name of names) {
                const asMatch = name.match(/(\w+)\s+as\s+(\w+)/);
                if (asMatch) {
                    record(asMatch[1], asMatch[2]);
                } else {
                    const cleanName = name.trim();
                    if (cleanName && cleanName !== '*' && /^\w+$/.test(cleanName)) {
                        record(cleanName, cleanName);
                    }
                }
            }
            i++;
            continue;
        }

        // import module [as alias]
        const importMatch = trimmed.match(/^import\s+(.+)$/);
        if (importMatch) {
            const modules = importMatch[1].split(',');
            for (const module of modules) {
                const asMatch = module.match(/([\w.]+)\s+as\s+(\w+)/);
                if (asMatch) {
                    const moduleName = asMatch[1].split('.')[0];
                    record(moduleName, asMatch[2]);
                } else {
                    const moduleName = module.trim().split('.')[0];
                    if (moduleName && /^\w+$/.test(moduleName)) {
                        record(moduleName, moduleName);
                    }
                }
            }
        }

        i++;
    }
}

function parseRustImports(text: string, record: (orig: string, local?: string) => void): void {
    // use path::Name;
    const simplePattern = /^\s*(?:pub\s+)?use\s+(?:[\w:]+::)?(\w+)\s*;/gm;
    let match;
    while ((match = simplePattern.exec(text)) !== null) {
        record(match[1], match[1]);
    }

    // use path::Name as Alias;
    const aliasPattern = /^\s*(?:pub\s+)?use\s+(?:[\w:]+::)?(\w+)\s+as\s+(\w+)\s*;/gm;
    while ((match = aliasPattern.exec(text)) !== null) {
        record(match[1], match[2]);
    }

    // use path::{Name1, Name2 as Alias};
    const multiPattern = /^\s*(?:pub\s+)?use\s+[\w:]+::\{([^}]+)\}\s*;/gm;
    while ((match = multiPattern.exec(text)) !== null) {
        const items = match[1].split(',');
        for (const item of items) {
            const trimmed = item.trim();
            if (!trimmed || trimmed === 'self' || trimmed === 'super') {continue;}

            const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
            if (asMatch) {
                record(asMatch[1], asMatch[2]);
            } else if (/^\w+$/.test(trimmed)) {
                record(trimmed, trimmed);
            }
        }
    }
}

function parseGoImports(text: string, record: (orig: string, local?: string) => void): void {
    const lines = text.split('\n');
    let inBlock = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === 'import (' || trimmed === 'import(' || trimmed.startsWith('import (')) {
            inBlock = true;
            continue;
        }

        if (inBlock) {
            if (trimmed.startsWith(')')) {
                inBlock = false;
                continue;
            }
            parseGoImportLine(trimmed, record);
            continue;
        }

        if (trimmed.startsWith('import ')) {
            const rest = trimmed.slice(7).trim();
            parseGoImportLine(rest, record);
        }
    }
}

function parseGoImportLine(line: string, record: (orig: string, local?: string) => void): void {
    // Remove quotes
    const clean = line.replace(/"/g, '').trim();
    if (!clean) {return;}

    const parts = clean.split(/\s+/);
    if (parts.length === 1) {
        // import "path/pkg"
        const pathParts = parts[0].split('/');
        const pkgName = pathParts[pathParts.length - 1];
        if (pkgName && pkgName !== '.' && pkgName !== '_') {
            record(pkgName, pkgName);
        }
    } else if (parts.length >= 2) {
        // import alias "path/pkg"
        const alias = parts[0];
        const pathParts = parts[1].split('/');
        const pkgName = pathParts[pathParts.length - 1];
        if (alias && alias !== '.' && alias !== '_') {
            record(pkgName || alias, alias);
        }
    }
}

function parseJavaImports(text: string, record: (orig: string, local?: string) => void): void {
    // import pkg.Class;
    const pattern = /^\s*import\s+([\w.]+)\s*;/gm;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const path = match[1];
        if (path.endsWith('.*')) {
            // Wildcard import - can't determine specific names
            continue;
        }
        const parts = path.split('.');
        const className = parts[parts.length - 1];
        if (className) {
            record(className, className);
        }
    }
}

export function getLastNLines(text:string,n:number):string{
    const lines=text.split('\n');
    return lines.slice(-n).join('\n');
}