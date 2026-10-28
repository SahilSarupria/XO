import { useRef, useState } from 'react';
import { describeProblem, type ProblemView } from '../domain/review';
import { SUPPORTED_UPLOAD_EXTENSIONS, type ApiProblem } from '../platform/client';
import type { Compilation, Source } from '../platform/wire';
import { useSession } from './session';

export type AddResult = { readonly ok: true } | { readonly ok: false; readonly problem: ApiProblem | string };

export interface AnalysisFailure {
  readonly sourceId: string;
  readonly view: ProblemView;
  readonly code?: string;
}

/**
 * Adding a document and having XO analyse it: the one implementation behind Documents and the Create XO wizard.
 * The file-type check is a convenience; the API enforces its own allowlist. A failed analysis is reported as a failure and
 * never moves the person forward.
 */
export function useDocuments(props: { workspaceId: string; onChanged: () => void; onAnalysed: (c: Compilation) => void }) {
  const { client } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProblem, setUploadProblem] = useState<ApiProblem | string | undefined>();
  const [analysing, setAnalysing] = useState<string | undefined>();
  const [analysisFailure, setAnalysisFailure] = useState<AnalysisFailure | undefined>();

  async function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined) return;
    setUploadProblem(undefined);
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop()!.toLowerCase()}` : '';
    // A convenience check only; the API enforces the same allowlist authoritatively.
    if (!SUPPORTED_UPLOAD_EXTENSIONS.includes(ext)) {
      setUploadProblem(
        `XO can read: ${SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}. “${file.name}” is not one of those.${ext === '.doc' ? ' Older .doc files are not supported: save it as .docx or PDF first.' : ''}`,
      );
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setUploading(true);
    const r = await client.uploadSource(props.workspaceId, file);
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
    if (r.ok) props.onChanged();
    else setUploadProblem(r.problem);
  }

  async function analyse(source: Source) {
    setAnalysing(source.sourceId);
    setAnalysisFailure(undefined);
    const r = await client.compileSource(props.workspaceId, source.sourceId);
    setAnalysing(undefined);
    if (!r.ok) {
      setAnalysisFailure({
        sourceId: source.sourceId,
        view: describeProblem(r.problem),
        ...(r.problem.code !== undefined ? { code: r.problem.code } : {}),
      });
      return;
    }
    if (r.value.status === 'succeeded') props.onAnalysed(r.value);
    else {
      // The platform recorded a failed analysis. Say so; do not move the person forward.
      setAnalysisFailure({
        sourceId: source.sourceId,
        view: {
          title: 'XO could not analyse this document',
          body: r.value.errorMessage ?? 'The analysis did not finish.',
          next: 'Check that the file is readable and try again, or upload a different version.',
        },
        ...(r.value.errorCode !== undefined ? { code: r.value.errorCode } : {}),
      });
      props.onChanged();
    }
  }

  /** Import a document from a link. The https-only check is a convenience; the platform decides everything else. */
  async function importLink(url: string): Promise<AddResult> {
    const trimmed = url.trim();
    if (!/^https:\/\//i.test(trimmed)) return { ok: false, problem: 'Links must start with https://.' };
    const r = await client.importSourceFromUrl(props.workspaceId, trimmed);
    if (!r.ok) return { ok: false, problem: r.problem };
    props.onChanged();
    return { ok: true };
  }

  /** Pasted text becomes a plain-text document through the normal upload path. */
  async function addText(name: string, text: string): Promise<AddResult> {
    if (text.trim() === '') return { ok: false, problem: 'Paste some text first.' };
    const base = name.trim() === '' ? 'Pasted text' : name.trim();
    const filename = /\.txt$/i.test(base) ? base : `${base}.txt`;
    const r = await client.uploadSource(props.workspaceId, new File([text], filename, { type: 'text/plain' }));
    if (!r.ok) return { ok: false, problem: r.problem };
    props.onChanged();
    return { ok: true };
  }

  return { fileInput, uploading, uploadProblem, analysing, analysisFailure, onFiles, analyse, importLink, addText };
}
