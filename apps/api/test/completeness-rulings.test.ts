/**
 * PX-3 — completeness is reported apart from validity, and review items close only by recorded rulings: structured,
 * attributed, audited, bound to the source set; a confirmed rule reaches the next compilation of the same source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT =
  '# Refunds\n\nIf the refund amount exceeds 500, the refund must be denied.\n\nIf the refund amount exceeds 500, the refund must be approved.\n\nStaff should keep receipts where practical.\n';

interface Completeness {
  valid: boolean;
  complete: boolean;
  dimensions: { id: string; status: string; open: { ref: string; detail: string }[] }[];
  appliedRulings: string[];
}

test('an open conflict keeps a valid compilation incomplete until a ruling resolves it; rulings are validated and listed', async () => {
  await withTempDir('xo-api-rulings-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=refunds.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const rec = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>();
      const c1 = (await server.request('GET', `/workspaces/${ws}/compilations/${rec.compilationId}/completeness`)).json<Completeness>();
      assert.equal(c1.valid, true);
      assert.equal(c1.complete, false);
      const openItems = c1.dimensions.flatMap((d) => d.open);
      const conflict = c1.dimensions.find((d) => d.id === 'conflicts')!.open[0];
      assert.ok(conflict !== undefined, JSON.stringify(c1.dimensions));

      const wrong = await server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/rulings`, {
        reviewItemId: conflict.ref,
        decision: { kind: 'acknowledge', note: 'looks fine' },
      });
      assert.equal(wrong.status, 400, 'a conflict needs a resolve-conflict ruling');
      const unknownKind = await server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/rulings`, {
        reviewItemId: conflict.ref,
        decision: { kind: 'approve-everything' },
      });
      assert.equal(unknownKind.status, 400);

      for (const item of openItems) {
        const decision = item.detail.startsWith('conflict:')
          ? { kind: 'resolve-conflict', prevails: 'b', rationale: 'Approval is the current refund policy per the finance memo.' }
          : { kind: 'acknowledge', note: 'Handled by the refunds officer.' };
        const res = await server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/rulings`, {
          reviewItemId: item.ref,
          decision,
        });
        assert.equal(res.status, 201, res.bodyText);
        assert.equal(res.json<{ actor: { id: string } }>().actor.id, 'test-identity');
      }
      const c2 = (await server.request('GET', `/workspaces/${ws}/compilations/${rec.compilationId}/completeness`)).json<Completeness>();
      assert.equal(c2.complete, true, JSON.stringify(c2.dimensions));
      assert.equal(c2.appliedRulings.length, openItems.length);
      const listed = (await server.request('GET', `/workspaces/${ws}/rulings`)).json<{ rulings: unknown[] }>().rulings;
      assert.equal(listed.length, openItems.length);
    } finally {
      await server.stop();
    }
  });
});

test('a confirm-rule ruling reaches the next compilation of the same source as a confirmed rule', async () => {
  await withTempDir('xo-api-rulings-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=refunds.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const rec = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{
        compilationId: string;
        artifactDigest: string;
      }>();
      const art = (await server.request('GET', `/workspaces/${ws}/compilations/${rec.compilationId}/artifact`)).json<{
        reviewQueue: { items: { id: string; kind: string }[] };
        configuration: { confirmedRules?: unknown[] };
      }>();
      const human = art.reviewQueue.items.find((i) => i.kind === 'human-required');
      assert.ok(human !== undefined, JSON.stringify(art.reviewQueue.items.map((i) => i.kind)));
      const ruled = await server.request('POST', `/workspaces/${ws}/compilations/${rec.compilationId}/rulings`, {
        reviewItemId: human.id,
        decision: { kind: 'confirm-rule', condition: 'refund amount exceeds 500', outcome: 'requires_approval' },
      });
      assert.equal(ruled.status, 201, ruled.bodyText);
      const rec2 = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{
        compilationId: string;
        artifactDigest: string;
      }>();
      const art2 = (await server.request('GET', `/workspaces/${ws}/compilations/${rec2.compilationId}/artifact`)).json<{
        configuration: { confirmedRules?: { confirmedBy: string; condition: string }[] };
      }>();
      assert.equal(art2.configuration.confirmedRules?.length, 1);
      assert.equal(art2.configuration.confirmedRules?.[0]?.confirmedBy, 'test-identity');
      assert.notEqual(rec2.artifactDigest, rec.artifactDigest);
    } finally {
      await server.stop();
    }
  });
});
