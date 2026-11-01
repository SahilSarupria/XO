/**
 * Reference grammar. Every value a step reads is addressed by one of:
 *   input.<name>            workflow input
 *   run.id | run.index      run identity (index: forEach item index, 0 otherwise)
 *   item.<name>             field of the current forEach item
 *   steps.<stepId>.<name>   declared output of an upstream step
 * Templates (idempotency keys, summaries) embed refs as `{{ref}}` and may also use
 * the identity placeholders `{{step.id}}`, `{{workflow.id}}`, `{{workflow.version}}`.
 */

export type ParsedRef =
  | { readonly kind: 'input'; readonly name: string }
  | { readonly kind: 'run'; readonly name: 'id' | 'index' }
  | { readonly kind: 'item'; readonly name: string }
  | { readonly kind: 'step'; readonly step: string; readonly output: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const STEP_ID = /^[a-z][a-z0-9_]{0,63}$/;

export function parseRef(from: string): ParsedRef | undefined {
  const parts = from.split('.');
  if (parts[0] === 'input' && parts.length === 2 && NAME.test(parts[1] ?? '')) return { kind: 'input', name: parts[1] as string };
  if (parts[0] === 'item' && parts.length === 2 && NAME.test(parts[1] ?? '')) return { kind: 'item', name: parts[1] as string };
  if (parts[0] === 'run' && parts.length === 2 && (parts[1] === 'id' || parts[1] === 'index')) return { kind: 'run', name: parts[1] };
  if (parts[0] === 'steps' && parts.length === 3 && STEP_ID.test(parts[1] ?? '') && NAME.test(parts[2] ?? ''))
    return { kind: 'step', step: parts[1] as string, output: parts[2] as string };
  return undefined;
}

export type TemplatePart =
  { readonly literal: string } | { readonly ref: ParsedRef } | { readonly ident: 'step.id' | 'workflow.id' | 'workflow.version' };

/** Parses a `{{...}}` template. Returns `{ error }` on an unterminated, empty or unknown placeholder. */
export function parseTemplate(template: string): { readonly parts: readonly TemplatePart[] } | { readonly error: string } {
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{{', i);
    if (open === -1) {
      parts.push({ literal: template.slice(i) });
      break;
    }
    if (open > i) parts.push({ literal: template.slice(i, open) });
    const close = template.indexOf('}}', open + 2);
    if (close === -1) return { error: 'unterminated "{{" placeholder' };
    const body = template.slice(open + 2, close).trim();
    if (body === '') return { error: 'empty placeholder' };
    if (body === 'step.id' || body === 'workflow.id' || body === 'workflow.version') parts.push({ ident: body });
    else {
      const ref = parseRef(body);
      if (ref === undefined) return { error: `unknown placeholder "{{${body}}}"` };
      parts.push({ ref });
    }
    i = close + 2;
  }
  return { parts };
}

export function refToString(r: ParsedRef): string {
  switch (r.kind) {
    case 'input':
      return `input.${r.name}`;
    case 'item':
      return `item.${r.name}`;
    case 'run':
      return `run.${r.name}`;
    case 'step':
      return `steps.${r.step}.${r.output}`;
  }
}

/** Identifiers a closed-language expression reads (string literals, function names and keywords excluded). */
export function expressionIdentifiers(source: string): string[] {
  const stripped = source.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const found = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const id = m[0];
    const after = stripped.slice(m.index + id.length).trimStart();
    if (id === 'true' || id === 'false' || id === 'null') continue;
    if (after.startsWith('(')) continue; // function call
    found.add(id);
  }
  return [...found];
}
