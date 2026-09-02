import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('README includes project overview and diagram sections', () => {
		const readmePath = path.resolve(__dirname, '..', '..', 'README.md');
		const contents = fs.readFileSync(readmePath, 'utf8');

		assert.ok(contents.includes('# Textify'));
		assert.ok(contents.includes('## Overview'));
		assert.ok(contents.includes('## Features'));
		assert.ok(contents.includes('## Architecture'));
		assert.ok(contents.includes('```mermaid'));
	});

	test('Quickstart and changelog document project-specific setup', () => {
		const quickstartPath = path.resolve(__dirname, '..', '..', 'vsc-extension-quickstart.md');
		const changelogPath = path.resolve(__dirname, '..', '..', 'CHANGELOG.md');

		const quickstart = fs.readFileSync(quickstartPath, 'utf8');
		const changelog = fs.readFileSync(changelogPath, 'utf8');

		assert.ok(quickstart.includes('Textify Extension Quickstart'));
		assert.ok(quickstart.includes('npm install'));
		assert.ok(quickstart.includes('F5'));
		assert.ok(changelog.includes('## [0.0.1]'));
		assert.ok(changelog.includes('Inline AI completion provider'));
	});
});
