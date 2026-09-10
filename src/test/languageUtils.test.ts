import * as assert from 'assert';
import {
	extractIdentifiers,
	getTruncationMarker,
	isKeyword,
	levenshteinDistance,
	normalizeText,
	stringSimilarity,
} from '../utils/languageUtils';

suite('languageUtils', () => {
	test('extractIdentifiers returns identifiers and excludes language keywords', () => {
		const identifiers = extractIdentifiers('function foo(bar) { return bar + baz; }', 'javascript');
		assert.ok(identifiers.has('foo'));
		assert.ok(identifiers.has('bar'));
		assert.ok(identifiers.has('baz'));
		assert.ok(!identifiers.has('function'));
		assert.ok(!identifiers.has('return'));
	});

	test('extractIdentifiers does not split numbers into identifiers', () => {
		const identifiers = extractIdentifiers('const x = 123;', 'javascript');
		assert.ok(identifiers.has('x'));
		assert.ok(!identifiers.has('123'));
	});

	test('isKeyword is language-specific', () => {
		assert.strictEqual(isKeyword('def', 'python'), true);
		assert.strictEqual(isKeyword('def', 'javascript'), false);
		assert.strictEqual(isKeyword('function', 'javascript'), true);
		assert.strictEqual(isKeyword('foo', 'rust'), false);
		assert.strictEqual(isKeyword('let', 'rust'), true);
	});

	test('stringSimilarity is 1 for identical strings and 1 for two empty strings', () => {
		assert.strictEqual(stringSimilarity('hello', 'hello'), 1);
		assert.strictEqual(stringSimilarity('', ''), 1);
	});

	test('stringSimilarity decreases as strings diverge', () => {
		const close = stringSimilarity('hello', 'hellp');
		const far = stringSimilarity('hello', 'xyzzy');
		assert.ok(close > far);
		assert.ok(close < 1);
	});

	test('levenshteinDistance matches known distances', () => {
		assert.strictEqual(levenshteinDistance('kitten', 'sitting'), 3);
		assert.strictEqual(levenshteinDistance('', ''), 0);
		assert.strictEqual(levenshteinDistance('abc', 'abc'), 0);
	});

	test('normalizeText collapses whitespace and lowercases', () => {
		assert.strictEqual(normalizeText('  Foo   Bar\t\n'), 'foo bar');
	});

	test('getTruncationMarker uses a language-appropriate comment style', () => {
		assert.ok(getTruncationMarker('python', 5).startsWith('#'));
		assert.ok(getTruncationMarker('javascript', 5).startsWith('/*'));
		assert.ok(getTruncationMarker('rust', 5).startsWith('/*'));
	});
});
