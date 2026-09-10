import * as assert from 'assert';
import * as vscode from 'vscode';
import { ASTService } from '../services/astService';
import { ReplacementRegionStage } from '../services/contextStages/replacementRegionStage';

suite('ReplacementRegionStage', () => {
	test('compute does not throw for short trailing text with no bracket/continuation cues', async () => {
		const document = await vscode.workspace.openTextDocument({
			content: 'const value = 1',
			language: 'javascript',
		});
		const astService = new ASTService(__dirname);
		const stage = new ReplacementRegionStage(astService);
		const position = new vscode.Position(0, document.lineAt(0).text.indexOf('1'));

		assert.doesNotThrow(() => stage.compute(document, position));
	});
});
