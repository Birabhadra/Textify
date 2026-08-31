import * as vscode from "vscode";
import { BoundedCache, buildCacheKey } from "../cache/boundedCache";
import { getConfig } from "./configurationService";
interface DefinitionTarget {
    uri: vscode.Uri;
    range: vscode.Range;
};
type RawTypeHeirarchyItems = vscode.TypeHierarchyItem | vscode.TypeHierarchyItem[]
export class LspService implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private currentMaxEntries: number;
    private cache: BoundedCache<unknown>;
    constructor() {
        const configService = getConfig();
        this.currentMaxEntries = configService.lspCacheMaxEntries;
        this.cache = new BoundedCache(this.currentMaxEntries);

        this.disposables.push(
            configService.onConfigChange((config) => {
                if (config.lspCacheMaxEntries !== this.currentMaxEntries) {
                    this.currentMaxEntries = config.lspCacheMaxEntries;
                    this.cache = new BoundedCache(this.currentMaxEntries);
                }
            })
        );

        this.registerListeners();
    }
    private registerListeners(): void {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                this.cache.invalidateGroup(e.document.uri.toString());
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                this.cache.invalidateGroup(doc.uri.toString());
            })
        );
    }

    async getDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
        const documentUri = document.uri.toString();
        const cacheKey = buildCacheKey(documentUri, "documentSymbols");
        const cached = this.cache.get(cacheKey) as vscode.DocumentSymbol[] | undefined;

        if (cached !== undefined) {
            return cached;
        }
        try {

            const symbols: vscode.DocumentSymbol[] = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);

            this.cache.set(cacheKey, symbols, { groupKey: documentUri });

            return symbols;
        } catch (err) {
            return [];
        }
    }


    async getSuperTypeNames(document: vscode.TextDocument, position: vscode.Position): Promise<string[]> {
        const documentUri = document.uri.toString();
        const cacheKey = buildCacheKey(documentUri, "SuperTypes", `${position.line}:${position.character}`);
        const cached = this.cache.get(cacheKey) as string[] | undefined;

        if (cached !== undefined) {
            return cached;
        }
        try {
            const prepared = await vscode.commands.executeCommand<RawTypeHeirarchyItems>(
                'vscode.prepareTypeHeirarchy',
                document.uri,
                position
            );
            if (!prepared) {
                return [];
            }
            const roots: DefinitionTarget[] = Array.isArray(prepared) ? prepared : [prepared];
            const superTypeResult = await Promise.allSettled(
                roots.map((item) => vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
                    'vscode.provideSupertypes',
                    item
                ))
            );

            const names: string[] = [];
            for (const result of superTypeResult) {
                if (result.status !== 'fulfilled') {
                    continue;
                }
                for (const item of result.value) {
                    names.push(item.name);
                }
            }
            const unique = [...new Set(names)];
            this.cache.set(cacheKey, unique, { groupKey: documentUri });
            return unique;
        }catch(err){
            return [];
        }

    }


    dispose() {
        this.disposables.forEach((d) => d.dispose());
        this.cache.clear();
    }

}