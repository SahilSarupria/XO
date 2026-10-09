import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, type Result } from '@xo/types';
import { SourceError } from '@xo/errors';
import { SourceFrontendRegistry } from '../../src/sources/registry.js';
import type { SourceFrontend } from '../../src/sources/frontend.js';
import type { CanonicalSource, SourceType } from '../../src/sources/types.js';
import { DocumentSourceFrontend } from '../../src/sources/document-frontend.js';
import { HtmlSourceFrontend } from '../../src/sources/html-frontend.js';
import { createDefaultSourceFrontendRegistry } from '../../src/sources/default-registry.js';

function stubFrontend(sourceType: SourceType, matches: (input: unknown) => boolean): SourceFrontend {
  return {
    sourceType,
    canHandle: (input: unknown): input is unknown => matches(input),
    ingest: (input: unknown): Result<CanonicalSource, SourceError> =>
      ok({
        sourceId: `stub_${sourceType}`,
        sourceType,
        sourcePath: 'stub',
        content: { kind: 'binary', mimeType: 'application/octet-stream', byteLength: 0 },
        metadata: {},
        semanticExtractionAvailable: false,
      }),
  };
}

test('register + resolve: a registered frontend is found by explicit source type', () => {
  const registry = new SourceFrontendRegistry();
  const frontend = stubFrontend('document', () => true);
  registry.register(frontend);
  assert.equal(registry.resolve('document'), frontend);
  assert.equal(registry.resolve('image'), undefined);
});

test('sourceTypes reflects registration order', () => {
  const registry = new SourceFrontendRegistry();
  registry.register(stubFrontend('image', () => false));
  registry.register(stubFrontend('pdf', () => false));
  assert.deepEqual(registry.sourceTypes(), ['image', 'pdf']);
});

test('duplicate registration for the same source type throws SourceError', () => {
  const registry = new SourceFrontendRegistry();
  registry.register(stubFrontend('document', () => true));
  assert.throws(
    () => registry.register(stubFrontend('document', () => true)),
    (thrown: unknown) => thrown instanceof SourceError && thrown.code === 'XO_ALREADY_EXISTS',
  );
});

test('detect probes registered frontends in registration order and returns the first match', () => {
  const registry = new SourceFrontendRegistry();
  const first = stubFrontend('document', (input) => typeof input === 'string');
  const second = stubFrontend('html', (input) => typeof input === 'string');
  registry.register(first);
  registry.register(second);
  assert.equal(registry.detect('anything'), first);
});

test('detect returns undefined for input no frontend claims', () => {
  const registry = new SourceFrontendRegistry();
  registry.register(stubFrontend('document', () => false));
  assert.equal(registry.detect('anything'), undefined);
});

test('ingest returns SOURCE_FRONTEND_NOT_FOUND for input no frontend can handle', () => {
  const registry = new SourceFrontendRegistry();
  registry.register(stubFrontend('document', () => false));
  const result = registry.ingest({ nonsense: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_NOT_FOUND');
});

test('ingest delegates to the matching frontend and returns its CanonicalSource', () => {
  const registry = new SourceFrontendRegistry();
  registry.register(stubFrontend('pdf', (input) => input === 'looks-like-pdf'));
  const result = registry.ingest('looks-like-pdf');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.sourceType, 'pdf');
});

test('the default registry has every built-in frontend registered', () => {
  const registry = createDefaultSourceFrontendRegistry();
  assert.deepEqual([...registry.sourceTypes()].sort(), ['document', 'html', 'image', 'openapi', 'pdf', 'structured']);
});

test('default registry: distinct real frontends do not collide on ordinary tagged input', () => {
  const registry = createDefaultSourceFrontendRegistry();
  const doc = registry.ingest({ kind: 'document', text: 'Hello world.', sourcePath: 'a.txt' });
  const html = registry.ingest({ kind: 'html', html: '<p>Hello world.</p>', sourcePath: 'b.html' });
  assert.equal(doc.ok, true);
  assert.equal(html.ok, true);
  if (doc.ok && html.ok) {
    assert.equal(doc.value.sourceType, 'document');
    assert.equal(html.value.sourceType, 'html');
  }
});

// Sanity check that the real frontends actually implement `SourceFrontend` faithfully.
test('DocumentSourceFrontend and HtmlSourceFrontend both report their own sourceType', () => {
  assert.equal(new DocumentSourceFrontend().sourceType, 'document');
  assert.equal(new HtmlSourceFrontend().sourceType, 'html');
});
