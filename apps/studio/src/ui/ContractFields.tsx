import type { InputContract } from '../platform/wire';

/**
 * Fields generated from a rule's published input contract. Presentation only: the platform's validation stays the
 * authority, and `buildInputFromContract` (domain/review.ts) only converts what was typed to the declared types.
 */
export function ContractFields(props: {
  contract: InputContract;
  idPrefix: string;
  values: Readonly<Record<string, string>>;
  errors: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
}) {
  const { contract } = props;
  const names = Object.keys(contract.properties).sort(
    (a, b) => Number(contract.required.includes(b)) - Number(contract.required.includes(a)) || a.localeCompare(b),
  );
  if (names.length === 0) return <p className="small">This rule takes no details.</p>;
  return (
    <>
      {names.map((name) => {
        const def = contract.properties[name]!;
        const required = contract.required.includes(name);
        const id = `${props.idPrefix}-${name}`;
        const err = props.errors[name];
        return (
          <div className="field" key={name}>
            <label htmlFor={id}>
              {name}{' '}
              <span className="muted small">
                · {required ? 'required' : 'optional'} · {def.type === 'boolean' ? 'true or false' : def.type}
              </span>
            </label>
            {def.type === 'boolean' ? (
              <select
                id={id}
                value={props.values[name] ?? ''}
                onChange={(e) => props.onChange(name, e.target.value)}
                aria-invalid={err !== undefined}
              >
                <option value="">{required ? 'Choose…' : 'Not set'}</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                id={id}
                value={props.values[name] ?? ''}
                inputMode={def.type === 'number' ? 'decimal' : 'text'}
                onChange={(e) => props.onChange(name, e.target.value)}
                aria-invalid={err !== undefined}
                aria-describedby={err !== undefined ? `${id}-err` : undefined}
              />
            )}
            {err !== undefined ? (
              <p id={`${id}-err`} className="danger-text small" role="alert">
                {err}
              </p>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
