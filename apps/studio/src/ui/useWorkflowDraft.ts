import { useCallback, useEffect, useMemo, useState } from 'react';
import { draftFromWorkflow } from '../domain/workflowDraft';
import type { ApiProblem } from '../platform/client';
import type { Capability, Workflow } from '../platform/wire';
import type { DraftAnalysis, DraftEdge, DraftNode, WorkflowDraft, WorkflowDraftSummary } from '../platform/wire-studio';
import { useSession } from './session';

export interface DraftController {
  readonly name: string;
  readonly setName: (n: string) => void;
  readonly nodes: readonly DraftNode[];
  readonly edges: readonly DraftEdge[];
  readonly definitionId: string | undefined;
  readonly revision: number | undefined;
  readonly analysis: DraftAnalysis | undefined;
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
  const nodes = loaded?.nodes ?? base.nodes;
  const edges = loaded?.edges ?? base.edges;

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
