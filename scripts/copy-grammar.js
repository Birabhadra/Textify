const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const grammarsDir = path.join(rootDir, 'grammars');

const GRAMMARS = [
    { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
    { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
    { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
    { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
    { pkg: 'tree-sitter-rust', file: 'tree-sitter-rust.wasm' },
    { pkg: 'tree-sitter-go', file: 'tree-sitter-go.wasm' },
    { pkg: 'tree-sitter-java', file: 'tree-sitter-java.wasm' },
    { pkg: 'tree-sitter-c', file: 'tree-sitter-c.wasm' },
    { pkg: 'tree-sitter-cpp', file: 'tree-sitter-cpp.wasm' },
];

if (!fs.existsSync(grammarsDir)) {
    fs.mkdirSync(grammarsDir, { recursive: true });
}

// Copy web-tree-sitter runtime WASM
const runtimeSrc = path.join(rootDir, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
if (fs.existsSync(runtimeSrc)) {
    fs.copyFileSync(runtimeSrc, path.join(grammarsDir, 'web-tree-sitter.wasm'));
    console.log('Copied web-tree-sitter.wasm');
}

// Copy grammar WASM files
let copied = 0;
for (const { pkg, file } of GRAMMARS) {
    const src = path.join(rootDir, 'node_modules', pkg, file);
    const dest = path.join(grammarsDir, file);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Copied ${file}`);
        copied++;
    } else {
        console.warn(`Warning: ${src} not found, skipping`);
    }
}

console.log(`Done: ${copied}/${GRAMMARS.length} grammars copied to grammars/`);