import { readFile } from 'node:fs/promises';
import { interpretPrompt, listDomainProfiles, resolveDomainProfile } from '@xo/compiler';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';

export interface PromptPreviewOptions {
  /** Prompt text given directly. */
  readonly text?: string;
  /** Path to a file containing the prompt text (used when `text` is absent). */
  readonly file?: string;
  /** Optional domain profile id whose vocabulary extends the neutral grammar for this preview. */
  readonly profile?: string;
  readonly json?: boolean;
}

/**
 * `xo prompt-preview`: shows what the compiler understood a prompt to say — statements, intents, and the targeted questions
 * it needs answered — WITHOUT compiling anything, writing a package, or contacting a model. It is the review step that
 * precedes confirming a prompt: a prompt only contributes to a compilation once a person confirms it (`confirmedBy`).
 */
export async function promptPreviewCommand(options: PromptPreviewOptions): Promise<CommandResult> {
  let text = options.text;
  if (text === undefined && options.file !== undefined) {
    try {
      text = await readFile(options.file, 'utf8');
    } catch (cause) {
      return failWith(`could not read "${options.file}": ${(cause as Error).message}`);
    }
  }
  if (text === undefined || text.trim().length === 0) return failWith('no prompt text: pass the text as an argument or use --file <path>');

  let lexicon;
  if (options.profile !== undefined) {
    const profile = resolveDomainProfile(options.profile);
    if (profile === undefined) {
      const known = listDomainProfiles()
        .map((p) => p.id)
        .join(', ');
      return failWith(`unknown domain profile "${options.profile}" (known: ${known})`);
    }
    lexicon = profile.lexicon;
  }
  const interpretation = interpretPrompt(text, lexicon);

  if (options.json) return ok([JSON.stringify({ profile: options.profile ?? null, interpretation }, null, 2)]);

  const lines: string[] = [`status: ${interpretation.status}`];
  lines.push(`statements (${interpretation.statements.length}):`);
  for (const s of interpretation.statements) {
    lines.push(`  - [${s.kind}/${s.modality}/${s.outcomeType}${s.structurable ? '/structurable' : ''}] ${s.text}`);
  }
  lines.push(`intents (${interpretation.intents.length}) — purpose statements, never compiled into executable rules:`);
  for (const i of interpretation.intents) lines.push(`  - ${i.text}${i.behaviours.length > 0 ? `  => ${i.behaviours.join('; ')}` : ''}`);
  lines.push(`questions (${interpretation.questions.length}):`);
  for (const q of interpretation.questions) lines.push(`  - [${q.reason}] ${q.question}`);
  return ok(lines);
}
