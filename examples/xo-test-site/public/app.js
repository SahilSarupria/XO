'use strict';

/* ---------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------- */

const state = {
  apiKey: localStorage.getItem('xo_api_key') || '',
  workspaceId: localStorage.getItem('xo_workspace_id') || '',
};

function persist() {
  localStorage.setItem('xo_api_key', state.apiKey);
  localStorage.setItem('xo_workspace_id', state.workspaceId);
}

function ws() {
  if (!state.workspaceId) {
    throw new Error('No workspace selected. Go to the Workspaces tab and select or create one first.');
  }
  return state.workspaceId;
}

/* ---------------------------------------------------------------------
 * API helpers — everything goes through /api/*, which server.mjs
 * forwards to the real apps/api process.
 * ------------------------------------------------------------------- */

async function api(method, path, { json, headers, query } = {}) {
  const url = new URL(`/api${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const finalHeaders = { ...(headers || {}) };
  if (state.apiKey) finalHeaders['Authorization'] = `Bearer ${state.apiKey}`;
  let body;
  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(url.toString(), { method, headers: finalHeaders, body });
  return finishResponse(res);
}

/** For raw-byte bodies (source upload, package publish/validate download). */
async function apiRaw(method, path, arrayBufferOrBlob, { contentType, headers, query } = {}) {
  const url = new URL(`/api${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const finalHeaders = { ...(headers || {}) };
  if (state.apiKey) finalHeaders['Authorization'] = `Bearer ${state.apiKey}`;
  if (contentType) finalHeaders['Content-Type'] = contentType;
  const res = await fetch(url.toString(), { method, headers: finalHeaders, body: arrayBufferOrBlob });
  return finishResponse(res);
}

async function finishResponse(res) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmt(value) {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function showOutput(el, value) {
  el.textContent = fmt(value);
}

function showError(el, err) {
  el.textContent = `Error: ${err.message}` + (err.data !== undefined ? `\n\n${fmt(err.data)}` : '');
}

async function run(outputEl, fn) {
  outputEl.textContent = 'Working…';
  try {
    const result = await fn();
    showOutput(outputEl, result === undefined ? { ok: true } : result);
    return result;
  } catch (err) {
    showError(outputEl, err);
    throw err;
  }
}

function parseJsonField(textarea, fallback) {
  const raw = textarea.value.trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

async function fileToArrayBuffer(file) {
  return await file.arrayBuffer();
}

async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ---------------------------------------------------------------------
 * Small render helpers for list panels
 * ------------------------------------------------------------------- */

function renderList(container, items, renderItem) {
  container.innerHTML = '';
  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Nothing here yet.';
    container.appendChild(empty);
    return;
  }
  for (const item of items) {
    container.appendChild(renderItem(item));
  }
}

function listItem({ title, sub, pill, actions }) {
  const row = document.createElement('div');
  row.className = 'list-item';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  titleEl.textContent = title;
  meta.appendChild(titleEl);
  if (sub) {
    const subEl = document.createElement('div');
    subEl.className = 'sub';
    subEl.textContent = sub;
    meta.appendChild(subEl);
  }
  row.appendChild(meta);

  if (pill) {
    const pillEl = document.createElement('span');
    pillEl.className = `pill ${pill.cls}`;
    pillEl.textContent = pill.text;
    row.appendChild(pillEl);
  }

  if (actions && actions.length) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 'actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'small secondary';
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      actionsEl.appendChild(btn);
    }
    row.appendChild(actionsEl);
  }

  return row;
}

function statusPill(status) {
  const okStatuses = ['succeeded', 'ok', 'executable_candidate'];
  const badStatuses = ['failed', 'rejected', 'semantically_invalid'];
  const warnStatuses = ['waiting_for_human', 'not_executable_yet', 'running', 'pending', 'created', 'interrupted'];
  let cls = 'pill-neutral';
  if (okStatuses.includes(status)) cls = 'pill-ok';
  else if (badStatuses.includes(status)) cls = 'pill-bad';
  else if (warnStatuses.includes(status)) cls = 'pill-warn';
  return { cls, text: String(status) };
}

/* ---------------------------------------------------------------------
 * Tabs
 * ------------------------------------------------------------------- */

function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function updateStatusBar() {
  document.getElementById('wsIndicator').textContent = state.workspaceId
    ? `workspace: ${state.workspaceId}`
    : 'no workspace selected';
}

/* ---------------------------------------------------------------------
 * Connect tab
 * ------------------------------------------------------------------- */

function initConnectTab() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  apiKeyInput.value = state.apiKey;

  document.getElementById('saveKeyBtn').addEventListener('click', () => {
    state.apiKey = apiKeyInput.value.trim();
    persist();
    document.getElementById('connectOutput').textContent = 'Saved.';
  });

  document.getElementById('clearKeyBtn').addEventListener('click', () => {
    state.apiKey = '';
    apiKeyInput.value = '';
    persist();
    document.getElementById('connectOutput').textContent = 'Cleared.';
  });

  document.getElementById('checkHealthBtn').addEventListener('click', async () => {
    const out = document.getElementById('connectOutput');
    const dot = document.getElementById('healthDot');
    const text = document.getElementById('healthText');
    try {
      const result = await run(out, () => api('GET', '/health'));
      dot.className = 'dot dot-ok';
      text.textContent = result && result.status ? result.status : 'ok';
    } catch {
      dot.className = 'dot dot-bad';
      text.textContent = 'unreachable';
    }
  });

  document.getElementById('checkOpenApiBtn').addEventListener('click', () => {
    run(document.getElementById('connectOutput'), () => api('GET', '/openapi.json'));
  });
}

/* ---------------------------------------------------------------------
 * Workspaces tab
 * ------------------------------------------------------------------- */

function initWorkspacesTab() {
  const out = document.getElementById('wsOutput');

  document.getElementById('wsCreateBtn').addEventListener('click', () => {
    const name = document.getElementById('wsNameInput').value.trim();
    run(out, () => api('POST', '/workspaces', { json: name ? { name } : {} })).then(refreshWorkspaces);
  });

  document.getElementById('wsListBtn').addEventListener('click', refreshWorkspaces);

  async function refreshWorkspaces() {
    const result = await run(out, () => api('GET', '/workspaces'));
    const items = (result && (result.workspaces || result)) || [];
    renderList(
      document.getElementById('wsList'),
      Array.isArray(items) ? items : [],
      (w) =>
        listItem({
          title: w.name || '(unnamed workspace)',
          sub: w.workspaceId || w.id,
          pill: state.workspaceId === (w.workspaceId || w.id) ? { cls: 'pill-ok', text: 'selected' } : undefined,
          actions: [
            {
              label: 'Select',
              onClick: () => {
                state.workspaceId = w.workspaceId || w.id;
                persist();
                updateStatusBar();
                refreshWorkspaces();
              },
            },
            {
              label: 'GET detail',
              onClick: () => run(out, () => api('GET', `/workspaces/${w.workspaceId || w.id}`)),
            },
          ],
        }),
    );
  }
}

/* ---------------------------------------------------------------------
 * Sources & Compile tab
 * ------------------------------------------------------------------- */

function initSourcesTab() {
  const out = document.getElementById('sourcesOutput');

  document.getElementById('sourceUploadBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('sourceFileInput');
    const file = fileInput.files[0];
    if (!file) {
      out.textContent = 'Pick a file first.';
      return;
    }
    await run(out, async () => {
      const buf = await fileToArrayBuffer(file);
      return apiRaw('POST', `/workspaces/${ws()}/sources`, buf, {
        contentType: file.type || 'application/octet-stream',
        query: { filename: file.name },
      });
    });
    refreshSources();
  });

  document.getElementById('sourceListBtn').addEventListener('click', refreshSources);
  document.getElementById('compilationListBtn').addEventListener('click', refreshCompilations);
  document.getElementById('capListBtn').addEventListener('click', () => {
    const id = document.getElementById('capCompilationIdInput').value.trim();
    if (!id) return;
    loadCapabilities(id);
  });

  async function refreshSources() {
    const result = await run(out, () => api('GET', `/workspaces/${ws()}/sources`));
    const items = (result && result.sources) || [];
    renderList(
      document.getElementById('sourceList'),
      items,
      (s) =>
        listItem({
          title: s.filename || s.sourceId || s.id,
          sub: `${s.sourceId || s.id} · ${s.mediaType || ''} · ${s.size ?? ''} bytes`,
          actions: [
            {
              label: 'Compile',
              onClick: async () => {
                await run(out, () => api('POST', `/workspaces/${ws()}/sources/${s.sourceId || s.id}/compile`));
                refreshCompilations();
              },
            },
            {
              label: 'Delete',
              onClick: async () => {
                await run(out, () => api('DELETE', `/workspaces/${ws()}/sources/${s.sourceId || s.id}`));
                refreshSources();
              },
            },
          ],
        }),
    );
  }

  async function refreshCompilations() {
    const result = await run(out, () => api('GET', `/workspaces/${ws()}/compilations`));
    const items = (result && result.compilations) || [];
    renderList(
      document.getElementById('compilationList'),
      items,
      (c) =>
        listItem({
          title: c.compilationId || c.id,
          sub: `source: ${c.sourceId || ''}`,
          pill: statusPill(c.status),
          actions: [
            {
              label: 'View capabilities',
              onClick: () => {
                document.getElementById('capCompilationIdInput').value = c.compilationId || c.id;
                loadCapabilities(c.compilationId || c.id);
              },
            },
          ],
        }),
    );
  }

  async function loadCapabilities(compilationId) {
    const result = await run(out, () => api('GET', `/workspaces/${ws()}/compilations/${compilationId}/capabilities`));
    const items = (result && result.capabilities) || [];
    renderList(
      document.getElementById('capFromCompilationList'),
      items,
      (cap) =>
        listItem({
          title: cap.name || cap.capabilityId || cap.id,
          sub: `${cap.capabilityId || cap.id} · ${cap.executionClass || ''}`,
          pill: cap.approved
            ? { cls: 'pill-ok', text: 'approved' }
            : { cls: 'pill-warn', text: 'not approved' },
          actions: [
            {
              label: 'Approve',
              onClick: async () => {
                await run(
                  out,
                  () =>
                    api(
                      'POST',
                      `/workspaces/${ws()}/compilations/${compilationId}/capabilities/${cap.capabilityId || cap.id}/approve`,
                    ),
                );
                loadCapabilities(compilationId);
              },
            },
            {
              label: 'Run this',
              onClick: () => {
                document.getElementById('execCompilationIdInput').value = compilationId;
                document.getElementById('execCapabilityIdInput').value = cap.capabilityId || cap.id;
                document.querySelector('.tab[data-tab="capabilities"]').click();
              },
            },
          ],
        }),
    );
  }
}

/* ---------------------------------------------------------------------
 * Capabilities & Executions tab
 * ------------------------------------------------------------------- */

function initExecutionsTab() {
  const out = document.getElementById('execOutput');

  document.getElementById('execRunBtn').addEventListener('click', async () => {
    const compilationId = document.getElementById('execCompilationIdInput').value.trim();
    const capabilityId = document.getElementById('execCapabilityIdInput').value.trim();
    let input;
    try {
      input = parseJsonField(document.getElementById('execInputTextarea'), {});
    } catch (e) {
      out.textContent = `Invalid JSON in input: ${e.message}`;
      return;
    }
    await run(out, () =>
      api('POST', `/workspaces/${ws()}/executions`, { json: { compilationId, capabilityId, input } }),
    );
    refreshExecutions();
  });

  document.getElementById('execListBtn').addEventListener('click', refreshExecutions);

  document.getElementById('resolveBtn').addEventListener('click', async () => {
    const executionId = document.getElementById('resolveExecIdInput').value.trim();
    const decision = document.getElementById('resolveDecisionSelect').value;
    let data;
    try {
      data = parseJsonField(document.getElementById('resolveDataTextarea'), undefined);
    } catch (e) {
      out.textContent = `Invalid JSON in data: ${e.message}`;
      return;
    }
    const body = data !== undefined ? { decision, data } : { decision };
    await run(out, () => api('POST', `/workspaces/${ws()}/executions/${executionId}/resolve`, { json: body }));
    refreshExecutions();
  });

  async function refreshExecutions() {
    const result = await run(out, () => api('GET', `/workspaces/${ws()}/executions`));
    const items = (result && result.executions) || [];
    renderList(
      document.getElementById('execList'),
      items,
      (e) =>
        listItem({
          title: e.executionId || e.id,
          sub: `capability: ${e.capabilityId || ''} · compilation: ${e.compilationId || ''}`,
          pill: statusPill(e.status),
          actions: [
            {
              label: 'View',
              onClick: () => run(out, () => api('GET', `/workspaces/${ws()}/executions/${e.executionId || e.id}`)),
            },
            {
              label: 'Use id ->',
              onClick: () => {
                document.getElementById('resolveExecIdInput').value = e.executionId || e.id;
              },
            },
          ],
        }),
    );
  }
}

/* ---------------------------------------------------------------------
 * Human tasks tab
 * ------------------------------------------------------------------- */

function initHumanTasksTab() {
  const out = document.getElementById('htOutput');

  document.getElementById('htListBtn').addEventListener('click', refresh);

  document.getElementById('htResolveBtn').addEventListener('click', async () => {
    const executionId = document.getElementById('htExecIdInput').value.trim();
    const decision = document.getElementById('htDecisionSelect').value;
    let data;
    try {
      data = parseJsonField(document.getElementById('htDataTextarea'), undefined);
    } catch (e) {
      out.textContent = `Invalid JSON in data: ${e.message}`;
      return;
    }
    const body = data !== undefined ? { decision, data } : { decision };
    await run(out, () => api('POST', `/workspaces/${ws()}/executions/${executionId}/resolve`, { json: body }));
    refresh();
  });

  async function refresh() {
    const result = await run(out, () => api('GET', `/workspaces/${ws()}/human-tasks`));
    const items = (result && result.humanTasks) || [];
    renderList(
      document.getElementById('htList'),
      items,
      (t) =>
        listItem({
          title: t.executionId || t.id,
          sub: `capability: ${t.capabilityId || ''}`,
          pill: t.humanTask ? statusPill(t.humanTask.status) : statusPill(t.status),
          actions: [
            {
              label: 'View',
              onClick: () => run(out, () => api('GET', `/workspaces/${ws()}/human-tasks/${t.executionId || t.id}`)),
            },
            {
              label: 'Use id ->',
              onClick: () => {
                document.getElementById('htExecIdInput').value = t.executionId || t.id;
              },
            },
          ],
        }),
    );
  }
}

/* ---------------------------------------------------------------------
 * Workflows tab
 * ------------------------------------------------------------------- */

function initWorkflowsTab() {
  const out = document.getElementById('wfOutput');

  document.getElementById('wfListBtn').addEventListener('click', refreshWorkflows);
  document.getElementById('wfxListBtn').addEventListener('click', refreshWorkflowExecutions);

  document.getElementById('wfStartBtn').addEventListener('click', async () => {
    const compilationId = document.getElementById('wfStartCompilationIdInput').value.trim();
    const workflowId = document.getElementById('wfStartWorkflowIdInput').value.trim();
    let input;
    try {
      input = parseJsonField(document.getElementById('wfStartInputTextarea'), {});
    } catch (e) {
      out.textContent = `Invalid JSON in input: ${e.message}`;
      return;
    }
    await run(out, () =>
      api('POST', `/workspaces/${ws()}/workflows/${workflowId}/executions`, {
        json: { compilationId, workflowId, input },
      }),
    );
    refreshWorkflowExecutions();
  });

  document.getElementById('wfxResumeBtn').addEventListener('click', async () => {
    const id = document.getElementById('wfxResumeIdInput').value.trim();
    const decision = document.getElementById('wfxDecisionSelect').value;
    const expectedStepExecutionId = document.getElementById('wfxExpectedStepInput').value.trim();
    const expectedRevisionRaw = document.getElementById('wfxExpectedRevInput').value.trim();
    let data;
    try {
      data = parseJsonField(document.getElementById('wfxDataTextarea'), undefined);
    } catch (e) {
      out.textContent = `Invalid JSON in data: ${e.message}`;
      return;
    }
    const body = {};
    if (decision) body.decision = decision;
    if (data !== undefined) body.data = data;
    if (expectedStepExecutionId) body.expectedStepExecutionId = expectedStepExecutionId;
    if (expectedRevisionRaw) body.expectedRevision = Number(expectedRevisionRaw);
    await run(out, () => api('POST', `/workspaces/${ws()}/workflow-executions/${id}/resume`, { json: body }));
    refreshWorkflowExecutions();
  });

  async function refreshWorkflows() {
    const compilationId = document.getElementById('wfCompilationFilterInput').value.trim();
    const result = await run(out, () =>
      api('GET', `/workspaces/${ws()}/workflows`, { query: compilationId ? { compilationId } : undefined }),
    );
    const items = (result && result.workflows) || [];
    renderList(
      document.getElementById('wfList'),
      items,
      (w) =>
        listItem({
          title: w.name || w.workflowId,
          sub: `${w.workflowId} · compilation: ${w.compilationId} · ${w.steps ? w.steps.length : 0} step(s)`,
          pill: { cls: w.executable ? 'pill-ok' : 'pill-warn', text: w.status },
          actions: [
            {
              label: 'Use ->',
              onClick: () => {
                document.getElementById('wfStartCompilationIdInput').value = w.compilationId;
                document.getElementById('wfStartWorkflowIdInput').value = w.workflowId;
              },
            },
          ],
        }),
    );
  }

  async function refreshWorkflowExecutions() {
    const result = await run(out, () => api('GET', `/workspaces/${ws()}/workflow-executions`));
    const items = (result && result.workflowExecutions) || [];
    renderList(
      document.getElementById('wfxList'),
      items,
      (x) =>
        listItem({
          title: x.workflowExecutionId,
          sub: `workflow: ${x.workflowName || x.workflowId || ''}`,
          pill: statusPill(x.status),
          actions: [
            {
              label: 'View',
              onClick: () => run(out, () => api('GET', `/workspaces/${ws()}/workflow-executions/${x.workflowExecutionId}`)),
            },
            {
              label: 'Use id ->',
              onClick: () => {
                document.getElementById('wfxResumeIdInput').value = x.workflowExecutionId;
                if (x.pendingHumanTask && x.pendingHumanTask.executionId) {
                  document.getElementById('wfxExpectedStepInput').value = x.pendingHumanTask.executionId;
                }
                if (typeof x.revision === 'number') {
                  document.getElementById('wfxExpectedRevInput').value = String(x.revision);
                }
              },
            },
          ],
        }),
    );
  }
}

/* ---------------------------------------------------------------------
 * Runtime console tab
 * ------------------------------------------------------------------- */

function initRuntimeTab() {
  const out = document.getElementById('rtOutput');

  document.getElementById('rtContextBtn').addEventListener('click', () => {
    run(out, () => api('GET', `/workspaces/${ws()}/runtime/context`));
  });

  document.getElementById('rtExecuteBtn').addEventListener('click', () => {
    const body = {
      input: document.getElementById('rtInputTextarea').value || '',
    };
    const capabilityId = document.getElementById('rtCapabilityIdInput').value.trim();
    const query = document.getElementById('rtQueryInput').value.trim();
    const model = document.getElementById('rtModelInput').value.trim();
    const hostFamily = document.getElementById('rtHostFamilyInput').value.trim();
    const hostCapsRaw = document.getElementById('rtHostCapsInput').value.trim();
    const tokenBudgetRaw = document.getElementById('rtTokenBudgetInput').value.trim();
    const maxTokensRaw = document.getElementById('rtMaxTokensInput').value.trim();

    if (capabilityId) body.capabilityId = capabilityId;
    if (query) body.query = query;
    if (model) body.model = model;
    if (hostFamily) body.hostFamily = hostFamily;
    if (hostCapsRaw) body.hostCapabilities = hostCapsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (tokenBudgetRaw) body.tokenBudget = Number(tokenBudgetRaw);
    if (maxTokensRaw) body.maxTokens = Number(maxTokensRaw);

    const headers = {};
    const provider = document.getElementById('rtProviderInput').value.trim();
    const providerKey = document.getElementById('rtProviderKeyInput').value.trim();
    const providerBaseUrl = document.getElementById('rtProviderBaseUrlInput').value.trim();
    const providerEndpoint = document.getElementById('rtProviderEndpointInput').value.trim();
    const providerApiVersion = document.getElementById('rtProviderApiVersionInput').value.trim();
    if (provider) headers['x-xo-provider'] = provider;
    if (providerKey) headers['x-xo-api-key'] = providerKey;
    if (providerBaseUrl) headers['x-xo-base-url'] = providerBaseUrl;
    if (providerEndpoint) headers['x-xo-endpoint'] = providerEndpoint;
    if (providerApiVersion) headers['x-xo-api-version'] = providerApiVersion;

    run(out, () => api('POST', `/workspaces/${ws()}/runtime/execute`, { json: body, headers }));
  });
}

/* ---------------------------------------------------------------------
 * Registry & Packages tab
 * ------------------------------------------------------------------- */

function initRegistryTab() {
  const out = document.getElementById('registryOutput');

  document.getElementById('pkgPublishBtn').addEventListener('click', async () => {
    const file = document.getElementById('pkgFileInput').files[0];
    if (!file) {
      out.textContent = 'Pick a .xo file first.';
      return;
    }
    await run(out, async () => {
      const buf = await fileToArrayBuffer(file);
      return apiRaw('POST', `/workspaces/${ws()}/registry/packages`, buf, {
        contentType: 'application/octet-stream',
      });
    });
  });

  document.getElementById('pkgListByCreatorBtn').addEventListener('click', () => {
    const creator = document.getElementById('pkgCreatorInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/registry/packages`, { query: { creator } }));
  });

  document.getElementById('pkgGetBtn').addEventListener('click', () => {
    const id = document.getElementById('pkgIdInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/registry/packages/${id}`));
  });

  document.getElementById('pkgInspectBtn').addEventListener('click', () => {
    const id = document.getElementById('pkgIdInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/registry/packages/${id}/inspect`));
  });

  document.getElementById('pkgSearchBtn').addEventListener('click', () => {
    const q = document.getElementById('pkgSearchInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/registry/search`, { query: { q } }));
  });

  document.getElementById('benchRecordBtn').addEventListener('click', () => {
    const id = document.getElementById('benchPkgIdInput').value.trim();
    const category = document.getElementById('benchCategoryInput').value.trim();
    const score = Number(document.getElementById('benchScoreInput').value.trim());
    const challengeable = document.getElementById('benchChallengeableInput').checked;
    run(out, () =>
      api('POST', `/workspaces/${ws()}/registry/packages/${id}/benchmarks`, {
        json: { category, score, challengeable },
      }),
    );
  });

  document.getElementById('benchListBtn').addEventListener('click', () => {
    const id = document.getElementById('benchPkgIdInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/registry/packages/${id}/benchmarks`));
  });

  document.getElementById('benchGetBtn').addEventListener('click', () => {
    const benchmarkId = document.getElementById('benchIdInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/registry/benchmarks/${benchmarkId}`));
  });

  document.getElementById('licCreateBtn').addEventListener('click', () => {
    const packageId = document.getElementById('licPkgIdInput').value.trim();
    const tier = document.getElementById('licTierInput').value.trim();
    let royaltySplit;
    try {
      royaltySplit = parseJsonField(document.getElementById('licRoyaltyTextarea'), []);
    } catch (e) {
      out.textContent = `Invalid JSON in royaltySplit: ${e.message}`;
      return;
    }
    run(out, () =>
      api('POST', `/workspaces/${ws()}/registry/licenses`, { json: { packageId, tier, royaltySplit } }),
    );
  });

  document.getElementById('licGetBtn').addEventListener('click', () => {
    const id = document.getElementById('licGetIdInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/registry/licenses/${id}`));
  });

  document.getElementById('ledgerVerifyBtn').addEventListener('click', () => {
    const entryHash = document.getElementById('ledgerHashInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/registry/ledger/${entryHash}/verify`));
  });

  document.getElementById('depResolveBtn').addEventListener('click', () => {
    const nameAtVersion = document.getElementById('depNameAtVersionInput').value.trim();
    run(out, () => api('POST', `/workspaces/${ws()}/packages/resolve`, { json: { nameAtVersion } }));
  });

  document.getElementById('depLockBtn').addEventListener('click', () => {
    const nameAtVersion = document.getElementById('depNameAtVersionInput').value.trim();
    run(out, () => api('POST', `/workspaces/${ws()}/packages/lock`, { json: { nameAtVersion } }));
  });

  document.getElementById('manifestGetBtn').addEventListener('click', () => {
    const name = document.getElementById('manifestNameInput').value.trim();
    const version = document.getElementById('manifestVersionInput').value.trim();
    run(out, () => api('GET', `/workspaces/${ws()}/packages/${name}/${version}/manifest`));
  });

  document.getElementById('validateBtn').addEventListener('click', async () => {
    const file = document.getElementById('validateFileInput').files[0];
    if (!file) {
      out.textContent = 'Pick a .xo file first.';
      return;
    }
    let publicKeys;
    try {
      publicKeys = parseJsonField(document.getElementById('validatePublicKeysTextarea'), undefined);
    } catch (e) {
      out.textContent = `Invalid JSON in publicKeys: ${e.message}`;
      return;
    }
    await run(out, async () => {
      const archiveBase64 = await fileToBase64(file);
      const body = publicKeys !== undefined ? { archiveBase64, publicKeys } : { archiveBase64 };
      return api('POST', '/packages/validate', { json: body });
    });
  });
}

/* ---------------------------------------------------------------------
 * Compiler playground tab
 * ------------------------------------------------------------------- */

function initCompilerPlaygroundTab() {
  const out = document.getElementById('compileOutput');

  document.getElementById('compileRunBtn').addEventListener('click', () => {
    const graphId = document.getElementById('compileGraphIdInput').value.trim();
    let graph;
    try {
      graph = parseJsonField(document.getElementById('compileGraphTextarea'), {});
    } catch (e) {
      out.textContent = `Invalid JSON in graph: ${e.message}`;
      return;
    }
    const body = { kind: 'xoir', graph };
    if (graphId) body.graphId = graphId;
    run(out, () => api('POST', '/compiler/compile', { json: body }));
  });
}

/* ---------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------- */

function boot() {
  initTabs();
  updateStatusBar();
  initConnectTab();
  initWorkspacesTab();
  initSourcesTab();
  initExecutionsTab();
  initHumanTasksTab();
  initWorkflowsTab();
  initRuntimeTab();
  initRegistryTab();
  initCompilerPlaygroundTab();
}

document.addEventListener('DOMContentLoaded', boot);
