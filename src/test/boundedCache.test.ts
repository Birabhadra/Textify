import * as assert from 'assert';
import { BoundedCache, buildCacheKey } from '../cache/boundedCache';

suite('BoundedCache', () => {
	test('buildCacheKey distinguishes value type and avoids delimiter collisions', () => {
		const numberKey = buildCacheKey('a', 1);
		const stringKey = buildCacheKey('a', '1');
		assert.notStrictEqual(numberKey, stringKey);

		// "ab" + "c" must not collide with "a" + "bc"
		const joined = buildCacheKey('ab', 'c');
		const split = buildCacheKey('a', 'bc');
		assert.notStrictEqual(joined, split);
	});

	test('get/set round-trips a value', () => {
		const cache = new BoundedCache<string>(10);
		cache.set('key1', 'value1');
		assert.strictEqual(cache.get('key1'), 'value1');
		assert.strictEqual(cache.get('missing'), undefined);
	});

	test('entries expire after their ttlMs elapses', async () => {
		const cache = new BoundedCache<string>(10);
		cache.set('key1', 'value1', { ttlMs: 5 });
		assert.strictEqual(cache.get('key1'), 'value1');
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.strictEqual(cache.get('key1'), undefined);
	});

	test('invalidateGroup removes every entry sharing a groupKey', () => {
		const cache = new BoundedCache<string>(10);
		cache.set('key1', 'value1', { groupKey: 'doc-a' });
		cache.set('key2', 'value2', { groupKey: 'doc-a' });
		cache.set('key3', 'value3', { groupKey: 'doc-b' });

		const removed = cache.invalidateGroup('doc-a');

		assert.strictEqual(removed, 2);
		assert.strictEqual(cache.get('key1'), undefined);
		assert.strictEqual(cache.get('key2'), undefined);
		assert.strictEqual(cache.get('key3'), 'value3');
	});

	test('evicts entries once maxSize is exceeded', () => {
		const cache = new BoundedCache<string>(2);
		cache.set('key1', 'value1');
		cache.set('key2', 'value2');
		cache.set('key3', 'value3');

		let remaining = 0;
		for (const key of ['key1', 'key2', 'key3']) {
			if (cache.get(key) !== undefined) {
				remaining++;
			}
		}
		assert.strictEqual(remaining, 2);
	});

	test('clear removes all entries and group tracking', () => {
		const cache = new BoundedCache<string>(10);
		cache.set('key1', 'value1', { groupKey: 'doc-a' });
		cache.clear();
		assert.strictEqual(cache.get('key1'), undefined);
		assert.strictEqual(cache.invalidateGroup('doc-a'), 0);
	});

	test('constructor rejects a non-positive maxSize', () => {
		assert.throws(() => new BoundedCache<string>(0));
	});
});
