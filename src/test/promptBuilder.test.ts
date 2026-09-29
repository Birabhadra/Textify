import * as assert from 'assert';
import { composeSystemPrompt, MAX_INSTRUCTION_TOKENS, SYSTEM_PROMPT } from '../services/promptBuilder';
import { stripHtmlComments } from '../services/instructionsService';

suite('system prompt composition', () => {
	test('no instructions keeps the built-in prompt byte-for-byte (prompt-cache friendly)', () => {
		assert.strictEqual(composeSystemPrompt(), SYSTEM_PROMPT);
		assert.strictEqual(composeSystemPrompt({ mode: 'append', sources: [{ source: 'settings', text: '   ' }] }), SYSTEM_PROMPT);
	});

	test('append mode adds user instructions after the built-in guidance', () => {
		const prompt = composeSystemPrompt({ mode: 'append', sources: [{ source: 'settings', text: 'Use tabs.' }] });
		assert.ok(prompt.startsWith(SYSTEM_PROMPT));
		assert.ok(prompt.includes('<instructions source="settings">\nUse tabs.\n</instructions>'));
		assert.ok(prompt.includes('Be MINIMAL'));
	});

	test('replace mode drops the built-in guidance but keeps the output contract', () => {
		const prompt = composeSystemPrompt({ mode: 'replace', sources: [{ source: 'settings', text: 'Be creative.' }] });
		assert.ok(!prompt.includes('Be MINIMAL'), 'built-in rules removed');
		assert.ok(prompt.includes('<output_format>'), 'output contract kept');
		assert.ok(prompt.includes('NO markdown'));
		assert.ok(prompt.includes('<replace_region>'));
		assert.ok(prompt.includes('Be creative.'));
	});

	test('sources are kept in precedence order', () => {
		const prompt = composeSystemPrompt({
			mode: 'append',
			sources: [
				{ source: 'settings', text: 'global' },
				{ source: 'language:python', text: 'python' },
				{ source: '.textify/instructions.md', text: 'workspace' }
			]
		});
		const g = prompt.indexOf('global');
		const p = prompt.indexOf('python"');
		const w = prompt.indexOf('workspace');
		assert.ok(g < p && p < w);
	});

	test('oversized instructions are truncated to the budget', () => {
		const huge = 'x'.repeat(MAX_INSTRUCTION_TOKENS * 4 * 3);
		const prompt = composeSystemPrompt({ mode: 'append', sources: [{ source: 'settings', text: huge }, { source: 'later', text: 'dropped' }] });
		assert.ok(prompt.length < SYSTEM_PROMPT.length + MAX_INSTRUCTION_TOKENS * 4 + 1000);
		assert.ok(prompt.includes('[truncated]'));
		assert.ok(!prompt.includes('dropped'));
	});

	test('HTML comments in the workspace file are not sent to the model', () => {
		assert.strictEqual(stripHtmlComments('a<!-- hidden\nnote -->b').trim(), 'ab');
	});
});
