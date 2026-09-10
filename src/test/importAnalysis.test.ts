import * as assert from 'assert';
import { findImportLineSpans, getLastNLines, parseImportBindings } from '../utils/importAnalysis';

suite('importAnalysis', () => {
	test('parseImportBindings resolves named imports and aliases (JS/TS)', () => {
		const bindings = parseImportBindings("import { Foo, Bar as Baz } from 'x';", 'typescript');
		assert.ok(bindings.importedLocalNames.has('Foo'));
		assert.ok(bindings.importedLocalNames.has('Baz'));
		assert.ok(!bindings.importedLocalNames.has('Bar'));
		assert.deepStrictEqual(Array.from(bindings.importedAliasesByOriginal.get('Bar') ?? []), ['Baz']);
	});

	test('parseImportBindings resolves "from x import y as z" (Python)', () => {
		const bindings = parseImportBindings('from foo import bar as baz', 'python');
		assert.ok(bindings.importedLocalNames.has('baz'));
		assert.ok(!bindings.importedLocalNames.has('bar'));
		assert.ok(bindings.importedOriginalNames.has('bar'));
	});

	test('findImportLineSpans finds a single-line JS import', () => {
		const text = "import Foo from 'foo';\nconst x = 1;";
		const spans = findImportLineSpans(text, 'javascript');
		assert.deepStrictEqual(spans, [{ start: 0, end: 0 }]);
	});

	test('findImportLineSpans finds a multi-line brace import', () => {
		const text = "import {\n  Foo,\n  Bar\n} from 'mod';\nconst x = 1;";
		const spans = findImportLineSpans(text, 'javascript');
		assert.strictEqual(spans.length, 1);
		assert.strictEqual(spans[0].start, 0);
		assert.strictEqual(spans[0].end, 3);
	});

	test('findImportLineSpans finds Python "from" imports', () => {
		const text = 'from foo import bar\nx = 1';
		const spans = findImportLineSpans(text, 'python');
		assert.deepStrictEqual(spans, [{ start: 0, end: 0 }]);
	});

	test('getLastNLines returns only the trailing N lines', () => {
		const text = 'a\nb\nc\nd';
		assert.strictEqual(getLastNLines(text, 2), 'c\nd');
		assert.strictEqual(getLastNLines(text, 10), 'a\nb\nc\nd');
	});
});
