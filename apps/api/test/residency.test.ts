// UW-14a/b — the instance's residency mode is enforced at the one provider boundary: chat, intelligence, runtime inference, vision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScriptableTestProvider, resolveResidency, type ModelProvider, type ResidencyPolicy } from '@xo/ai-core';
import { SettingsInvalidError } from '@xo/instance';
import { PackageTrustPolicy } from '@xo/package-sdk';
import { TestServer, withTempDir } from './test-helpers.js';
import { extractionFromEnv } from '../src/compilations/extraction-tiers.js';
import { startInstance } from '../src/instance/start.js';
import { createHttpServer } from '../src/server.js';

const reply = (text: string) => ({
  kind: 'success' as const,
  response: { text, usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'm', finishReason: 'stop' as const },
});

async function withChat<T>(
  residency: ResidencyPolicy,
  providers: Record<string, ModelProvider>,
  fn: (c: { server: TestServer; base: string }) => Promise<T>,
): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        residency,
        chatProviderFactory: (id) => providers[id],
      });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        return await fn({ server, base: `/workspaces/${ws}` });
      } finally {
        await server.stop();
      }
    }),
  );
}

test('UAC-25 strict_local: chat with a hosted model is refused before anything is sent; a model on this server answers', async () => {
  const hosted = new ScriptableTestProvider('anthropic', [reply('should never run')]);
  const local = new ScriptableTestProvider('ollama', [reply('local answer')]);
  await withChat(resolveResidency({}), { anthropic: hosted, ollama: local }, async ({ server, base }) => {
    await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'anthropic', model: 'claude' } } });
    const thread = (await server.request('POST', `${base}/chats`, {})).json<{ threadId: string }>().threadId;
    const refused = await server.request('POST', `${base}/chats/${thread}/messages`, {
      content: 'Asha Rao, PAN ABCDE1234F, renews in March',
    });
    assert.equal(refused.status, 412, refused.bodyText);
    assert.match(refused.bodyText, /strict_local residency: nothing is sent to hosted models \(\\"anthropic\\"\).*Choose a local model/);
    assert.equal(hosted.callLog.length, 0, 'the hosted provider never saw the request');

    const settings = (await server.request('GET', `${base}/settings`)).json<{
      effect: { model: { providers: { id: string; allowedByResidency?: boolean }[] } };
    }>();
    const allowed = Object.fromEntries(settings.effect.model.providers.map((p) => [p.id, p.allowedByResidency]));
    assert.deepEqual(
      [allowed['anthropic'], allowed['openai'], allowed['ollama']],
      [false, false, true],
      'Studio can show which providers the instance allows',
    );

    await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'ollama', model: 'llama3' } } });
    const ok = await server.request('POST', `${base}/chats/${thread}/messages`, { content: 'hello' });
    assert.equal(ok.status, 201, ok.bodyText);
    assert.equal(local.callLog.length, 1);

    const ready = (await server.request('GET', '/ready')).json<{ residency?: { mode: string } }>();
    assert.equal(ready.residency?.mode, 'strict_local');
  });
});

test('masked_hosted: chat text is untyped, so even a contracted hosted provider is refused for it', async () => {
  const hosted = new ScriptableTestProvider('anthropic', [reply('no')]);
  await withChat(
    resolveResidency({ XO_RESIDENCY: 'masked_hosted', XO_HOSTED_MODEL_PROVIDERS: 'anthropic' }),
    { anthropic: hosted },
    async ({ server, base }) => {
      await server.request('PUT', `${base}/settings`, { model: { primary: { provider: 'anthropic', model: 'claude' } } });
      const thread = (await server.request('POST', `${base}/chats`, {})).json<{ threadId: string }>().threadId;
      const refused = await server.request('POST', `${base}/chats/${thread}/messages`, { content: 'what does the policy say?' });
      assert.equal(refused.status, 412);
      assert.match(refused.bodyText, /may receive only requests built from schema descriptors/);
      assert.equal(hosted.callLog.length, 0);
    },
  );
});

test('hosted vision is refused unless residency is open; a vision model on this server is allowed', () => {
  const provider = { id: 'anthropic', describeCapabilities: () => ({ supportsVision: true }) } as unknown as ModelProvider;
  const vision = { XO_OCR_VISION_PROVIDER: 'anthropic', XO_OCR_VISION_MODEL: 'claude', XO_OCR_VISION_SENDS_IMAGES: 'yes' };
  assert.throws(
    () => extractionFromEnv(vision, () => provider, resolveResidency({})),
    /page images are real customer data: XO_RESIDENCY=strict_local never sends them/,
  );
  assert.throws(
    () =>
      extractionFromEnv(
        vision,
        () => provider,
        resolveResidency({ XO_RESIDENCY: 'masked_hosted', XO_HOSTED_MODEL_PROVIDERS: 'anthropic' }),
      ),
    /XO_RESIDENCY=masked_hosted never sends them/,
  );
  assert.equal(extractionFromEnv(vision, () => provider, resolveResidency({ XO_RESIDENCY: 'open' })).pageTiers.length, 3);
  const ollama = { id: 'ollama', describeCapabilities: () => ({ supportsVision: true }) } as unknown as ModelProvider;
  assert.equal(
    extractionFromEnv({ ...vision, XO_OCR_VISION_PROVIDER: 'ollama', XO_OCR_VISION_MODEL: 'llava' }, () => ollama, resolveResidency({}))
      .pageTiers.length,
    3,
  );
});

test('open residency is refused in production by the server and by start-up settings, before anything is written', async () => {
  assert.throws(
    () => createHttpServer({ env: { XO_RESIDENCY: 'open', XO_ENV: 'production' }, packageTrustPolicy: PackageTrustPolicy.development() }),
    /refused in production/,
  );
  await withTempDir('xo-residency-', async (root) => {
    await assert.rejects(
      startInstance({ env: { XO_DATA_DIR: join(root, 'data'), XO_RESIDENCY: 'open', XO_ENV: 'production', XO_TRUST_MODE: 'enforce' } }),
      (e: unknown) => e instanceof SettingsInvalidError && e.problems.some((p) => p.name === 'XO_RESIDENCY'),
    );
  });
});

test('every model provider the API builds comes from the one guarded factory (no provider class is constructed anywhere else)', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts'))
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (/new (Anthropic|OpenAi|AzureOpenAi|Gemini|Ollama)Provider\(/.test(line)) found.push(`${p.slice(src.length)}:${i + 1}`);
          });
    }
  };
  walk(src);
  assert.ok(
    found.length > 0 && found.every((f) => f.startsWith('chat/model-provider.ts:')),
    `providers constructed outside the guarded factory: ${found.join(', ')}`,
  );
  assert.match(readFileSync(join(src, 'chat/model-provider.ts'), 'utf8'), /return guardProvider\(provider, residency/);
});
