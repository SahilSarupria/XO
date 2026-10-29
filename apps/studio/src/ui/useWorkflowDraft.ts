import { useCallback, useEffect, useMemo, useState } from 'react';
import { draftFromWorkflow } from '../domain/workflowDraft';
import type { ApiProblem } from '../platform/client';
import type { Capability, Workflow } from '../platform/wire';
import type { DraftGraph } from '../domain/draftEdit';
import type {
  DraftAnalysis,
  DraftEdge,
  DraftIssue,
  DraftNode,
  NodeKindSupport,
  WorkflowDraft,
  WorkflowDraftSummary,
} from '../platform/wire-studio';
import { useSession } from './session';

export interface DraftController {
  readonly name: string;
  readonly setName: (n: string) => void;
  readonly nodes: readonly DraftNode[];
  readonly edges: readonly DraftEdge[];
  readonly definitionId: string | undefined;
  readonly revision: number | undefined;
  readonly analysis: DraftAnalysis | undefined;
  /** What the platform says about each node (errors and blockers that name it), keyed by node id. */
  readonly issuesByNode: ReadonlyMap<string, readonly DraftIssue[]>;
  /** Which node kinds (and variants) the platform can run; undefined until it has answered. */
  readonly kinds: readonly NodeKindSupport[] | undefined;
  /** True when the graph or name differs from what is saved (or nothing is saved yet). */
  readonly dirty: boolean;
  /** Apply an edit to the graph. The platform re-validates every change. */
  readonly edit: (change: (g: DraftGraph) => DraftGraph) => void;
  readonly validating: boolean;
  readonly saving: boolean;
  readonly problem: ApiProblem | undefined;
  /** A plain statement of what just happened that is not an error (saved, reloaded after a conflict). */
  readonly note: string | undefined;
  readonly drafts: readonly WorkflowDraftSummary[] | undefined;
  readonly save: () => Promise<void>;
  readonly open: (id: string) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly startOver: () => void;
}

/** Draft state for one workflow screen. Validation and every refusal come from the platform; nothing is judged locally. */
export function useWorkflowDraft(workspaceId: string, workflow: Workflow, caps: readonly Capability[] | undefined): DraftController {
  const { client } = useSession();
  const base = useMemo(() => draftFromWorkflow(workflow, caps), [workflow, caps]);
  const [name, setName] = useState(base.name);
  const [loaded, setLoaded] = useState<WorkflowDraft | undefined>();
  const [analysis, setAnalysis] = useState<DraftAnalysis | undefined>();
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [drafts, setDrafts] = useState<readonly WorkflowDraftSummary[] | undefined>();
  const [kinds, setKinds] = useState<readonly NodeKindSupport[] | undefined>();
  /** Unsaved edits. Undefined means the graph is exactly the loaded draft (or the starting copy). */
  const [edited, setEdited] = useState<DraftGraph | undefined>();
  const nodes = edited?.nodes ?? loaded?.nodes ?? base.nodes;
  const edges = edited?.edges ?? loaded?.edges ?? base.edges;
  const dirty = edited !== undefined || loaded === undefined || name.trim() !== loaded.name;
  const edit = useCallback((change: (g: DraftGraph) => DraftGraph) => setEdited((cur) => change(cur ?? { nodes, edges })), [nodes, edges]);
  const issuesByNode = useMemo(() => {
    const m = new Map<string, DraftIssue[]>();
    for (const i of [...(analysis?.errors ?? []), ...(analysis?.blockers ?? [])])
      if (i.nodeId !== undefined) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i]);
    return m;
  }, [analysis]);
  useEffect(() => {
    let live = true;
    void client.getNodeKinds(workspaceId).then((r) => {
      if (live && r.ok) setKinds(r.value);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  const reloadList = useCallback(async () => {
    const r = await client.listDrafts(workspaceId);
    if (r.ok) setDrafts(r.value);
  }, [client, workspaceId]);
  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  useEffect(() => {
    if (name.trim() === '') {
      setAnalysis(undefined);
      return;
    }
    let live = true;
    setValidating(true);
    const t = setTimeout(() => {
      void client.validateDraft(workspaceId, { name, nodes, edges }).then((r) => {
        if (!live) return;
        setValidating(false);
        if (r.ok) setAnalysis(r.value);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
      setValidating(false);
    };
  }, [client, workspaceId, name, nodes, edges]);

  const adopt = (d: WorkflowDraft) => {
    setEdited(undefined);
    setLoaded(d);
    setName(d.name);
    setAnalysis(d.analysis);
  };

  const save = useCallback(async () => {
    setSaving(true);
    setProblem(undefined);
    setNote(undefined);
    const body = { name: name.trim(), nodes, edges };
    const r =
      loaded === undefined
        ? await client.createDraft(workspaceId, body)
        : await client.saveDraft(workspaceId, loaded.definitionId, { ...body, expectedRevision: loaded.revision });
    if (r.ok) {
      adopt(r.value);
      setNote(`Saved as revision ${r.value.revision}. Saving a draft does not make it runnable.`);
      void reloadList();
    } else if (r.problem.reason === 'stale_revision' && loaded !== undefined) {
      const latest = await client.getDraft(workspaceId, loaded.definitionId);
      if (latest.ok) {
        adopt(latest.value);
        setNote(
          'This draft was changed by someone else. Their newer version is loaded and nothing was overwritten; your edit was not saved.',
        );
      } else setProblem(latest.problem);
      void reloadList();
    } else setProblem(r.problem);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, name, nodes, edges, loaded, reloadList]);

  const open = useCallback(
    async (id: string) => {
      setProblem(undefined);
      setNote(undefined);
      const r = await client.getDraft(workspaceId, id);
      if (r.ok) adopt(r.value);
      else {
        setProblem(r.problem);
        void reloadList();
      }
    },
    [client, workspaceId, reloadList],
  );

  const startOver = useCallback(() => {
    setEdited(undefined);
    setLoaded(undefined);
    setName(base.name);
    setProblem(undefined);
    setNote(undefined);
  }, [base.name]);

  const remove = useCallback(
    async (id: string) => {
      setProblem(undefined);
      setNote(undefined);
      const r = await client.deleteDraft(workspaceId, id);
      if (!r.ok && r.problem.kind !== 'not_found') setProblem(r.problem);
      else if (loaded?.definitionId === id) startOver();
      await reloadList();
    },
    [client, workspaceId, loaded, reloadList, startOver],
  );

  return {
    name,
    setName,
    nodes,
    edges,
    definitionId: loaded?.definitionId,
    revision: loaded?.revision,
    analysis,
    issuesByNode,
    kinds,
    dirty,
    edit,
    validating,
    saving,
    problem,
    note,
    drafts,
    save,
    open,
    remove,
    startOver,
  };
}
