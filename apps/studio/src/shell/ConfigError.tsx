export function ConfigError(props: { readonly message: string }) {
  return (
    <main className="connect">
      <div className="connect-card">
        <p className="brand brand-large">
          <span className="brand-mark" aria-hidden="true" />
          XO Studio
        </p>
        <div className="notice notice-danger" role="alert">
          <strong>XO Studio can&rsquo;t start</strong>
          <p>{props.message}</p>
          <p className="muted">This is a configuration problem, not something you did. Ask your XO administrator to correct it.</p>
        </div>
      </div>
    </main>
  );
}
