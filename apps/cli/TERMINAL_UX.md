# apps/cli — interactive terminal experience

`xo` now behaves like Gemini CLI: run it with no arguments in a terminal and you
get a persistent, styled session; run it with arguments and it behaves exactly as
before (plus colors on a TTY). **No `@xo/*` package was touched, no existing
command file was modified, and no new dependency was added.**

## Modes

| Invocation | What happens |
|---|---|
| `xo` (stdin+stdout are TTYs) | Interactive session: banner, boxed prompt, `/` commands, `@` file picker, `!` shell mode |
| `xo -i "<text>"` | Same, but `<text>` is submitted first |
| `xo -p "<text>" --store <dir>` | Non-interactive natural-language query against the XOs in `<dir>`. Answer → stdout, receipt → stderr. Piped stdin is appended (`cat claim.txt \| xo -p "assess this" --store s`). `-o json` prints `run --json`'s payload |
| `xo <command> …` | Unchanged. On a color TTY the output is colorized; `--json`, pipes, `NO_COLOR`, `--no-color` are never touched |
| `xo` (no TTY) / `xo --help` | The usage text, as before, plus `Interactive:` and `Global options:` sections |
| `xo <command> --help` / `-h` | That command's usage only (previously: the global usage) |
| `xo -v` / `--version` | Prints `xo <version>` (previously: usage). `xo init --version <v>` is unaffected — short aliases are only expanded *before* the command word |

Global options: `-h/--help`, `-v/--version`, `-p/--prompt`, `-i/--prompt-interactive`,
`-m/--model`, `--provider`, `-o/--output-format text|json` (shorthand for `--json`), `--no-color`.

## Inside the session

* **`/command`** — every registered `xo` command works as `/compile policy.pdf`, `/verify pkg.xo`, …
  It is looked up in the same `CommandRegistry` as one-shot mode and its output is diverted into a status box
  (`✓`/`✗`, duration in the border). `--json` output is pretty-printed and colored in the box.
* **Session commands**: `/help [cmd]`, `/clear`, `/quit`, `/about`, `/theme [name]`, `/store [dir|none]`,
  `/reg [dir|none]`, `/provider [name]`, `/model [id|default]`, `/cd <dir>`, `/stats`, `/copy`, `/settings [witty on|off]`.
* **Session store/registry defaults** — `/store` and `/reg` are injected as `--store` / `--registry` into
  `install uninstall lock run inspect <n>@<v> publish search registry` when you don't pass the flag
  (an explicit flag always wins; a `note: using session store …` line says so).
* **Plain text** = a capability query: goes through `runCommand` (the code behind `xo run`) with `query` set and no
  capability id. Needs `/store` and a provider API key **in the environment** (keys are never saved).
  `@file` in the text attaches text files (≤200 KB; binaries are skipped with a note — use `/compile` for documents).
* **`@`** — Tab-completes paths anywhere; `/compile @policy.pdf` works (the `@` is stripped only if the file exists).
* **`!cmd`** — shell mode (type `!` on an empty prompt; Esc/Backspace leaves it).
* **Menu**: typing `/` opens the command menu with descriptions; `--` completes flags from each command's usage string;
  path arguments, `/theme`, `/provider`, `/help` complete their values. Tab accepts; Enter accepts a command
  *name* (and runs it if it takes no arguments) but submits path/value lines exactly as typed.
* **Keys**: ↑/↓ history (persisted, `--api-key` values redacted) · Ctrl+J or `\`+Enter newline · bracketed paste ·
  Ctrl+A/E/U/K/W, Alt+B/F, Ctrl+←/→ · Ctrl+L clear · Ctrl+C clears the line, twice on an empty line exits (Ctrl+D likewise).
* **Footer**: `cwd (git branch)` · `store …` · `provider · model`.
* **Themes**: `xo-dark` (default), `xo-light`, `dracula`, `github-dark`, `ansi` (your terminal's own palette).
  Truecolor / 256 / 16-color / none are detected (`NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `TERM`).

Persistence: `$XO_HOME` (default `~/.xo`) → `settings.json` (theme, store, registry, provider, model, spinner phrases) and
`history`, both `0600`. Nothing credential-like has a place to be stored.

## Files

New — `src/tui/`: `ansi` `theme` `box` `banner` `highlight` `markdown` `spinner` `tokenize` `catalog` `completion`
`input` (prompt editor) `history` `settings` `session` `slash-commands` `repl` `capture` `env-info` `query`
`prompt-mode`. New tests: `test/tui-{helpers,render,logic,editor,repl}.ts`, `test/cli-terminal.test.ts`.
Modified — `src/index.ts` (new entry flow; `buildRegistry` and `normalizeShortFlags` exported; `run()` takes an optional
3rd `RunOptions` arg), `bin/xo.js` (passes the real terminal in).

## Design decisions (and the tradeoffs)

1. **No Ink/React.** Gemini CLI is built on Ink. Adding it means React + a JSX toolchain in a repo whose `arg-parser.ts`
   explicitly prefers zero-dep, and I could not build it against the real monorepo. The look/feel (boxed prompt, live menu,
   spinner, status boxes, themes) is plain ANSI. Cost: no mouse, no vim mode, no Ctrl+R search.
2. **Terminal behavior is opt-in via `run(argv, logger, { terminal })`; only `bin/xo.js` passes it.** So the test suite and
   any library caller get today's exact non-TTY behavior — even if someone runs a test file directly in a terminal.
3. **Commands are wrapped, not changed.** All commands print directly to stdout; the session diverts stdout/stderr for the
   duration of a command (`capture.ts`) and re-renders it. The highlighter is proven (test) to never change the visible text
   of a non-JSON line.
4. **`describeUsage()` parses the existing `usage` strings** for menu descriptions rather than adding a `description` field
   to ~25 registrations. A test fails if any registered command's usage stops being parsable, and another fails if a session
   command name ever shadows a registered one.
5. **Query-output coupling**: the session/`-p` split the answer from the receipt at the `--- receipt ---` line `run.ts` prints.

## Known limitations

* Commands cannot be cancelled (the compiler/runtime APIs take no `AbortSignal`). Ctrl+C **twice** while one runs exits the
  session with 130; a `.zip` source extraction temp dir may be left behind in that case.
* Multi-line paste without bracketed-paste support submits line by line.
* Wide-character width is a compact heuristic, not a full Unicode table.
* Not implemented because XO has no analog: MCP/extensions, GEMINI.md-style memory, checkpoints/`/restore`, tool approval modes.
* Windows terminals: code paths exist (`clip`, `shell: true`) but were not exercised.

## Validation status

Only `apps/cli` and `apps/api` were available, so this was built and exercised against **generated stand-ins** for the `@xo/*`
packages, not the real ones:
* 97 new tests pass; the 159 test cases in the *existing* test files have an identical pass/fail set before vs. after the
  change in that same environment (60 pass in both; the rest need the real packages).
* The real `bin/xo.js` was driven through a pseudo-terminal with a terminal emulator (typing, Tab/Enter semantics, paste,
  history, Ctrl+C/D, resize, `-i`, `-p`, NO_COLOR / 16 / 256 / truecolor) — screen contents and cursor positions checked.

**Still to run in the monorepo** (per the usual bar — real binary, scrubbed env):
```
npm run build --workspaces && npm test -w @xo/cli          # existing 75 + the new tests
cd apps/cli
env -i PATH="$PATH" node bin/xo.js -v
env -i PATH="$PATH" node bin/xo.js compile --help
env -i PATH="$PATH" TERM=xterm-256color HOME="$HOME" node bin/xo.js      # then: /compile @../../examples/vertical-test/burglary-policy.pdf
env -i PATH="$PATH" HOME="$HOME" node bin/xo.js -p "what needs manager approval?" --store ./store   # exits 1 cleanly without a key
```
