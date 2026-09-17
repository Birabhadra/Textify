import * as assert from 'assert';
import { PROVIDERS, getProvider } from '../api/providers';

suite('providers registry', () => {
	test('every provider has a unique id, endpoint, api key, and at least one model', () => {
		const ids = new Set<string>();
		for (const provider of PROVIDERS) {
			assert.ok(provider.endPoint.startsWith('https://'));
			assert.ok(provider.apiKeyConfigKey.endsWith('ApiKey'));
			assert.ok(provider.models.length > 0);
			assert.ok(!ids.has(provider.id));
			ids.add(provider.id);
		}
	});

	test('getProvider resolves known ids and is undefined for unknown ones', () => {
		assert.strictEqual(getProvider('groq')?.label, 'Groq');
		assert.strictEqual(getProvider('unknown' as any), undefined);
	});

	test('groq is the only provider with extra body fields today', () => {
		const withExtra = PROVIDERS.filter((provider) => provider.extraBodyFields);
		assert.strictEqual(withExtra.length, 1);
		assert.strictEqual(withExtra[0].id, 'groq');
		assert.deepStrictEqual(withExtra[0].extraBodyFields!(), { reasoning_effort: 'none' });
	});
});
