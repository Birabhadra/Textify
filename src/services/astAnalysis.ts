import * as TreeSitter from 'web-tree-sitter';
const DECLARATION_NODE_TYPES = new Set([
    'function_declaration',
    'function_definition',
    'function_item',
    'class_declaration',
    'class_definition',
    'lexical_declaration',
    'variable_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'struct_item',
    'trait_item',
    'type_item',
    'type_declaration',
    'decorated_definition',
    'export_statement',
    'assignment'
]);

const DIRECT_NAME_TYPES = new Set([
    'function_declaration',
    'function_definition',
    'function_item',
    'class_declaration',
    'class_definition',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'struct_item',
    'trait_item',
    'type_item',
]);
const CLASS_NODE_TYPES = new Set([
    'class_declaration',
    'class_definition',
]);
const DECLARATOR_TYPES = new Set([
    'lexical_declaration',
    'variable_declaration'
]);

const FUNCTION_NODE_TYPES = new Set([
    'function_declaration',
    'function_definition',
    'function_item',
    'method_definition',
    'arrow_function',
]);

const INTERFACE_NODE_TYPES = new Set([
    'interface_declaration',
]);

const VARIABLE_NODE_TYPES = new Set([
    'lexical_declaration',
    'variable_declaration',
    'variable_declarator',
]);
export function findStatementEnd(tree: TreeSitter.Tree, cursor: { row: number, column: number }): { endLine: number; endChar: number } | null {
    const root = tree.rootNode;
    const cursorRow = cursor.row;
    const cursorColumn = cursor.column;

    let bestNode: TreeSitter.Node | null = null;
    function findSmallest(node: TreeSitter.Node): void {
        if (containsPosition(node, cursorRow, cursorColumn)) {
            if (!bestNode || nodeSpan(node) <= nodeSpan(bestNode)) {
                bestNode = node;
            }
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child) {
                    findSmallest(child);
                }
            }
        }
    }

    findSmallest(root);

    if (!bestNode) {
        return null;
    }

    let current: TreeSitter.Node = bestNode;

    while (current.parent && current.parent !== root) {
        const parentType = current.parent.type;
        current = current.parent;
        if (parentType === 'expression_statement' || parentType === 'return_statement' ||
            parentType === 'variable_declaration' || parentType === 'lexical_declaration' ||
            parentType === 'assignment_statement' || parentType === 'if_statement' ||
            parentType === 'for_statement' || parentType === 'while_statement') {
            break;
        }
    }
    return {
        endLine: current.endPosition.row,
        endChar: current.endPosition.column
    };
}

function nodeSpan(node: TreeSitter.Node): number {
    return node.endIndex - node.startIndex;
}
function containsPosition(node: TreeSitter.Node, row: number, column: number): boolean {
    const start = node.startPosition;
    const end = node.endPosition;

    if (row < start.row || row > end.row) {
        return false;
    }

    if (row === start.row && column < start.column) {
        return false;
    }
    if (row === end.row && column >= end.column) {
        return false;
    }

    return true;
}

export function extractDeclaredNames(tree: TreeSitter.Tree): Set<string> {
    const names = new Set<string>;
    const root = tree.rootNode;

    for (let i = 0; i < root.namedChildCount; i++) {
        const child = root.namedChild(i);
        if (child) {
            extractNameFromNode(child, names);
        }
    }

    return names;
}


function extractNameFromNode(node: TreeSitter.Node, names: Set<string>): void {
    const type = node.type;
    if (!DECLARATION_NODE_TYPES.has(type)) {
        return;

    }

    if (DIRECT_NAME_TYPES.has(type)) {
        const namenode = node.childForFieldName('name');
        if (namenode) {
            names.add(namenode.text);
        }
        return;
    }

    if (DECLARATOR_TYPES.has(type)) {
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child && (child.type === 'variable_declarator' || child?.type === 'init_declarator')) {
                const nameNode = child.childForFieldName('name');
                if (nameNode) {
                    names.add(nameNode.text);
                }
            }
        }
        return;
    }

    if (type === 'type_declaration') {
        for (let i = 0; i < node.namedChildCount; i++) {
            const spec = node.namedChild(i);
            if (spec && spec.type === 'type_spec') {
                const nameNode = spec.childForFieldName('name');
                if (nameNode) {
                    names.add(nameNode.text);
                }
            }
        }
        return;
    }

    if (type === 'export_statement') {
        const declaration = node.childForFieldName('declaration');
        if (declaration) {
            extractNameFromNode(declaration, names);
        } else {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child && DECLARATION_NODE_TYPES.has(child.type)) {
                    extractNameFromNode(child, names);
                }
            }
        }
        return;
    }

    if (type === 'decorated_definition') {
        const definition = node.childForFieldName('definition');
        if (definition) {
            extractNameFromNode(definition, names);
        } else {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (child && DECLARATION_NODE_TYPES.has(child.type)) {
                    extractNameFromNode(child, names);

                }
            }
        }
        return;
    }

    if (type === 'assignment') {
        const left = node.childForFieldName('left');
        if (left && left.type === 'identifier') {
        names.add(left.text);
        }        
        return;
    }
}

export function extractSignatureFromAST(
    tree: TreeSitter.Tree,
    symbolKind: number
): string | undefined {
    const root = tree.rootNode;

    const KIND_INTERFACE = 10;
    const KIND_CLASS = 4;
    const KIND_FUNCTION = 11;
    const KIND_METHOD = 5;
    const KIND_ENUM = 9;
    const KIND_VARIABLE = 12;
    const KIND_CONSTANT = 13;
    const KIND_STRUCT = 22;
    const KIND_TYPE_PARAMETER = 25;

    if (symbolKind === KIND_INTERFACE) {
        return extractInterfaceOrClassSig(root, INTERFACE_NODE_TYPES);
    }

    if (symbolKind === KIND_CLASS || symbolKind === KIND_STRUCT) {
        return extractInterfaceOrClassSig(root, CLASS_NODE_TYPES);
    }

    if (symbolKind === KIND_FUNCTION || symbolKind === KIND_METHOD) {
        return extractFunctionSig(root);
    }

    if (symbolKind === KIND_ENUM) {
        // Enums: return full text (already bounded by vscode range)
        return root.text;
    }

    if (symbolKind === KIND_VARIABLE || symbolKind === KIND_CONSTANT) {
        return extractVariableSig(root);
    }

    if (symbolKind === KIND_TYPE_PARAMETER) {
        return root.text;
    }

    return root.text;
}

function extractInterfaceOrClassSig(
    root: TreeSitter.Node,
    targetTypes: Set<string>
): string | undefined {
    const decl = findFirstNodeOfType(root, targetTypes);
    if (!decl) {return undefined;}

    const body = decl.childForFieldName('body');
    if (!body) {
        // No body found — return full text
        return decl.text;
    }

    // Build signature: declaration header + method/property signatures without bodies
    const parts: string[] = [];
    const fullText = decl.text;
    const headerEnd = body.startIndex - decl.startIndex;
    const header = fullText.slice(0, headerEnd).trimEnd();
    parts.push(header);

    // Iterate body's named children and strip their bodies
    for (let i = 0; i < body.namedChildCount; i++) {
        const member = body.namedChild(i);
        if (!member) {continue;}

        const memberBody = member.childForFieldName('body');
        if (memberBody) {
            // Method: take text up to body start
            const memberText = member.text;
            const memberBodyOffset = memberBody.startIndex - member.startIndex;
            const sig = memberText.slice(0, memberBodyOffset).trimEnd();
            parts.push('  ' + sig + ';');
        } else {
            // Property, field, or signature without body
            parts.push('  ' + member.text.trimEnd());
        }
    }

    parts.push('}');
    return parts.join('\n');
}

function extractFunctionSig(root: TreeSitter.Node): string | undefined {
    const func = findFirstNodeOfType(root, FUNCTION_NODE_TYPES);
    if (!func) {
        // Maybe the root itself is a function
        if (FUNCTION_NODE_TYPES.has(root.type)) {
            return extractFunctionSigFromNode(root);
        }
        return undefined;
    }
    return extractFunctionSigFromNode(func);
}

function extractFunctionSigFromNode(func: TreeSitter.Node): string | undefined {
    const body = func.childForFieldName('body');
    if (!body) {
        return func.text;
    }

    const fullText = func.text;
    const bodyOffset = body.startIndex - func.startIndex;
    return fullText.slice(0, bodyOffset).trimEnd();
}

function extractVariableSig(root: TreeSitter.Node): string | undefined {
    const decl = findFirstNodeOfType(root, VARIABLE_NODE_TYPES);
    if (!decl) {return undefined;}

    // For variable_declarator, remove the initializer value (keep type annotation)
    for (let i = 0; i < decl.namedChildCount; i++) {
        const child = decl.namedChild(i);
        if (child && child.type === 'variable_declarator') {
            const value = child.childForFieldName('value');
            if (value) {
                const text = decl.text;
                const valueOffset = value.startIndex - decl.startIndex;
                // Go back to find '=' before the value
                let eqOffset = valueOffset;
                while (eqOffset > 0 && text[eqOffset - 1] !== '=') {
                    eqOffset--;
                }
                if (eqOffset > 0) {
                    // Include the type annotation but not the value
                    const sig = text.slice(0, eqOffset - 1).trimEnd();
                    return sig + ';';
                }
            }
        }
    }

    return decl.text;
}


function findFirstNodeOfType(
    root: TreeSitter.Node,
    types: Set<string>
): TreeSitter.Node | null {
    if (types.has(root.type)) {return root;}

    for (let i = 0; i < root.namedChildCount; i++) {
        const child = root.namedChild(i);
        if (child) {
            const found = findFirstNodeOfType(child, types);
            if (found) {return found;}
        }
    }
    return null;
}