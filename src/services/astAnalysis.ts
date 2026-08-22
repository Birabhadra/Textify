import * as TreeSitter from 'web-tree-sitter';

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
                const child = node.namedChild(i)
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

    while (current.parent && current.parent != root) {
        const parentType = current.parent.type;
        current=current.parent;
        if (parentType === 'expression_statement' || parentType === 'return_statement' ||
            parentType === 'variable_declaration' || parentType === 'lexical_declaration' ||
            parentType === 'assignment_statement' || parentType === 'if_statement' ||
            parentType === 'for_statement' || parentType === 'while_statement') {
            break;
        }
    }
    return {
        endLine:current.endPosition.row,
        endChar:current.endPosition.column
    }
}

function nodeSpan(node: TreeSitter.Node): number {
    return node.endIndex - node.startIndex
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