# doc-watcher

Download and watch changes on Confluence docs. Confluence Data Center only, not Cloud.

## Setup

```sh
git clone <repo-url> doc-watcher
cd doc-watcher
nvm use            # optional — picks up .nvmrc → Node 24. If you don't use nvm, just make sure `node --version` is 24+.
npm install
cp config.example.ts config.ts
```

Edit `config.ts`:

- `pat` — Personal Access Token (creation steps are in the file's comment). Can also be supplied via the `DOC_WATCHER_PAT` environment variable, in which case env wins over the file — useful when you keep multiple checkouts and don't want to duplicate the secret. Doc-watcher logs a one-liner at startup when an env override is in effect.
- `roots` — one Confluence URL or a list. Paste whatever page or space URL you have in front of you; doc-watcher figures out which Confluence page that points to. The base URL is derived from the origin, so there's no separate `base_url`. All roots must share an origin (one Confluence per run); if you list two roots and one happens to live under the other, the descendant is dropped at startup with a warning.

`config.ts` is a TypeScript module — your editor will autocomplete the keys and flag typos thanks to the `satisfies ConfigInput` annotation at the bottom.

## Run

```sh
npm start
```

Incremental sync. The first invocation paginates the whole subtree via CQL and downloads everything. Every later run uses a `lastmodified >= last_sync` filter, so it's typically one request that returns only the pages edited since last run — sub-second on a normal day. Resumable on Ctrl+C: just run again to pick up where you stopped. Concurrency self-tunes from Confluence's `X-RateLimit-*` headers — there's no knob to turn.

**Confluence Data Center index gotcha's.** The default sync goes through Confluence's search index, which may not have indexed a freshly-watched section yet (descendant relationships in particular). On a first run that returns ≤1 page, doc-watcher prints a hint pointing at `--includeNew` so you can opt into the slower-but-direct subtree walk explicitly. It never falls back silently.

**Page comments are folded into the `.md`.** Every sync pulls the comments under each root via a single CQL call, threads them, and appends a `## Comments` section to the page they belong to. Inline-anchored comments emit an inline footnote (`[c<n>]`) at their marker position; the Comments section quotes the anchored text so a reader has context. Footer comments follow as a threaded discussion. A page is re-rendered when either its body or its comment set changes.

**New and deleted pages on existing roots need an opt-in mode.** CQL goes through Confluence's Lucene index, which lags page creation by ~1 hour on existing roots (existing-page edits are reflected instantly, since they trigger a synchronous per-page reindex), and a filtered CQL result can't tell "unchanged" from "deleted." Either re-run later, or pick them up immediately with a DB walk:

```sh
npm start -- --includeNew  # recursive /child/page walk — slower, but sees new and deleted pages
```

## What it doesn't mirror

**Attachments are out of scope.** Inline images, PDFs, diagrams, decks — none of it lands on disk; rendered markdown links back to the live Confluence URL so they only resolve when you're on a network with access.

## Other verbs

- `npm start -- --reset` — wipe in-memory state so every page is treated as new; re-downloads everything in one pass. Composable with `--includeNew`.

## Risk profile

This tool runs locally with your Confluence PAT and writes to your filesystem. The PAT inherits your full Confluence read-permissions, so anything that can hijack the process can read what you can read. A few choices keep the attack surface small:

- **No transpiler at runtime.** Node 24 strips TypeScript types natively, so there's no `tsx` / `esbuild` / platform-specific prebuilt binary in the dependency tree. The `.nvmrc` pins to 24.
- **Three runtime dependencies, all single-package and mainline.** `cheerio` (XHTML parsing — its transitive tree is wide but well-audited), `zod` (config validation), and Node's built-in `fetch` (no separate HTTP library). YAML, env-loaders, CLI frameworks, loggers, test runners — all replaced by stdlib or ~20 lines of in-house code.
- **No native modules.** Everything is pure JavaScript. Corporate machines with MITM npm proxies and locked-down compilers can install cleanly. Equally: there's no native code path that could ship a compromised binary.
- **Config is a TypeScript module you write yourself.** No YAML/JSON/TOML parser, no `.env` loader, no auto-discovered config paths. Your PAT lives in `config.ts` (gitignored), or — opt-in — in a single `DOC_WATCHER_PAT` env var you set yourself, which the loader logs when it takes effect.
- **TLS verification is disabled process-wide.** Deliberate: corporate Confluence instances often sit behind private CAs and asking every user to wrangle a PEM bundle is worse. The deliberate scope is a single-user CLI talking to a Confluence on a network you already trust. Don't point this at an untrusted host.
- **Outbound traffic goes to exactly one origin: the Confluence host derived from your `roots`.** Mixed origins are rejected at startup. No telemetry, no analytics, no auto-update check.

Two things to be aware of when auditing:

- `cheerio` pulls in ~15 transitive packages (htmlparser2, parse5, domhandler/domutils, undici, etc.). If you want to lock those, run `npm ci` against a committed `package-lock.json`.
- The dev-only `typescript` and `@types/node` aren't run with your PAT — they only execute under `npm run typecheck`.

See [`CLAUDE.md`](./CLAUDE.md) for the full spec — output layout, file formats, frontmatter shape, adaptive concurrency, limitations.
