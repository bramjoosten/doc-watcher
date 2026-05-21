# doc-watcher

Mirror Confluence Server pages to local files — raw HTML alongside converted Markdown, incrementally re-synced. PAT-authenticated, CLI, built for `rg` and local AI workflows.

## Setup

```sh
git clone https://code.bramjoosten.nl/bram/doc-watcher.git
cd doc-watcher
nvm use            # picks up .nvmrc → Node 24
npm install
cp config.example.ts config.ts
```

Edit `config.ts`:

- `base_url` — your Confluence root URL
- `pat` — Personal Access Token (creation steps are in the file's comment)
- `root_page_ids` — one page id or a list; each is the root of a subtree to mirror

`config.ts` is a TypeScript module — your editor will autocomplete the keys and flag typos thanks to the `satisfies ConfigInput` annotation at the bottom.

## Run

```sh
npm start
```

Incremental sync — the first invocation downloads everything, every later run enumerates the subtree via CQL and only fetches pages whose version changed. Resumable on Ctrl+C: just run again to pick up where you stopped. Concurrency self-tunes from Confluence's `X-RateLimit-*` headers, so there's nothing to manually configure beyond the optional `parallel_downloads` ceiling.

**New pages take ~1 hour to show up.** CQL goes through Confluence's Lucene index, which lags page creation (existing-page edits are reflected instantly, since they trigger a per-page reindex). Two ways out: re-run later, or bypass the index entirely with the DB walk:

```sh
npm start -- --walkdb     # recursive /child/page walk — slower, but sees new pages immediately
```

## Other verbs

- `npm start -- refresh` — full re-download (ignores `last_sync`, reconciles deletes). Accepts `--walkdb`.
- `npm start -- reconvert` — regenerate every `.md` from the saved `.html` (no network)

## Risk profile

This tool runs locally with your Confluence PAT and writes to your filesystem. The PAT inherits your full Confluence read-permissions, so anything that can hijack the process can read what you can read. A few choices keep the attack surface small:

- **No transpiler at runtime.** Node 24 strips TypeScript types natively, so there's no `tsx` / `esbuild` / platform-specific prebuilt binary in the dependency tree. The `.nvmrc` pins to 24.
- **Three runtime dependencies, all single-package and mainline.** `cheerio` (XHTML parsing — its transitive tree is wide but well-audited), `zod` (config validation), and Node's built-in `fetch` (no separate HTTP library). YAML, env-loaders, CLI frameworks, loggers, test runners — all replaced by stdlib or ~20 lines of in-house code.
- **No native modules.** Everything is pure JavaScript. Corporate machines with MITM npm proxies and locked-down compilers can install cleanly. Equally: there's no native code path that could ship a compromised binary.
- **Config is a TypeScript module you write yourself.** No YAML/JSON/TOML parser, no `.env`, no env-var indirection. Your PAT lives in `config.ts`, gitignored.
- **TLS verification is disabled process-wide.** Deliberate: corporate Confluence instances often sit behind private CAs and asking every user to wrangle a PEM bundle is worse. The deliberate scope is a single-user CLI talking to a Confluence on a network you already trust. Don't point this at an untrusted host.
- **Outbound traffic goes to exactly one origin: your Confluence `base_url`.** No telemetry, no analytics, no auto-update check.

Two things to be aware of when auditing:

- `cheerio` pulls in ~15 transitive packages (htmlparser2, parse5, domhandler/domutils, undici, etc.). If you want to lock those, run `npm ci` against a committed `package-lock.json`.
- The dev-only `typescript` and `@types/node` aren't run with your PAT — they only execute under `npm run typecheck`.

See [`CLAUDE.md`](./CLAUDE.md) for the full spec — output layout, file formats, frontmatter shape, adaptive concurrency, limitations.
