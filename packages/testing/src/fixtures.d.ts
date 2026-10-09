/**
 * Loads a JSON fixture relative to the calling test file. Pass
 * `import.meta.url` from the test so fixtures resolve correctly regardless
 * of the working directory the test runner was invoked from.
 */
export declare function loadJsonFixture<T = unknown>(importMetaUrl: string, relativePath: string): Promise<T>;
//# sourceMappingURL=fixtures.d.ts.map