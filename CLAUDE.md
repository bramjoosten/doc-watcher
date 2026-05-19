# doc-watcher

A local watcher script that mirrors a Confluence Server (on-prem) tree to disk so it can be searched and queried by IDE's and local AI. Authenticates with a user-level Personal Access Token, downloads fast (in parallel with concurrency, and re-runs incrementally — only fetching pages whose `lastmodified` is newer than the last sync.

Node.js, TypeScript, run via `tsx`.

## Requirements

### Must-have

- **Fast (parallel downloads).** A space can hold thousands of pages. The fetcher runs requests in parallel with bounded concurrency — enough to keep the network pipe full, not enough to get rate-limited.
- **Keep in sync.** Cheap re-runs that only fetch what changed since the last sync (using each page's `lastmodified` timestamp, queried via CQL). Removes pages that have been deleted or moved out of scope. Two runs back-to-back should produce identical output.
- **Node.js only (no Python).** Many organisations keep their stack narrow. Ruling out Python up front means doc-watcher drops into any Node-based environment without adding a runtime.
- **Keep the source HTML alongside the markdown.** For each page we save both `<file>.html` (the raw Confluence storage-format response) and `<file>.md` (the readable conversion). The HTML is the durable source of truth; the markdown is a regeneratable view. Conversion runs through a deterministic script (cheerio + turndown + a macro registry), never an LLM, so re-running the converter on the saved HTML always produces the same markdown. If a future converter improvement lands, the corpus can be re-derived without re-hitting Confluence.

### Nice-to-have

- **Write back to Confluence.** Local folder as source of truth, push edits back as page versions. Opens the door to git-versioned docs, AI-generated pages, and round-trip workflows. Not in the first version.
- **Conflict handling.** Once write-back exists, simultaneous Confluence/local edits become a real problem. Flag and defer.

## Architecture

### Stack

- **Node 22+** with **TypeScript**, run via `tsx` in dev (no build step).
- Built-in `fetch` (undici) + `p-limit` for bounded-concurrency parallel downloads.
- `cheerio` for parsing Confluence storage-format XHTML.
- `turndown` for HTML → Markdown, with custom rules for Confluence macros.
- `better-sqlite3` for the local index.
- `zod` for typed config validation; `smol-toml` for TOML parsing.
- `dotenv` for loading `CONFLUENCE_PAT`.

**Minimize third-party dependencies.** Reach for the Node standard library first; a dep only earns its keep when the alternative would be hundreds of lines of nontrivial code (XHTML parsing, HTML→markdown conversion, SQLite bindings). The CLI is a plain Node entry point using `process.argv` — no `commander` / `yargs` / etc. Logging is `console.log` / `console.error`. No test framework for now.

### State: SQLite, not frontmatter

The `.md` files have **no YAML frontmatter** — they're plain prose, easier for grep, editors, and LLMs to consume. All structural metadata (Confluence ID, version, ancestors, last-modified, links, embeds) lives in `docs/index.sqlite`, with one row per page keyed by Confluence ID. The SQLite file is the source of truth for change detection and link resolution; the on-disk tree is the human-facing view derived from it.

**Source-URL header.** The first line of every converted `.md` is a markdown autolink to the Confluence source page, e.g. `<https://confluence.example.com/pages/viewpage.action?pageId=12345>`. It renders as a clickable link in any markdown viewer, keeps the file traceable when SQLite isn't at hand, and is regenerated from the database during `reconvert`. Beyond this single line the body is unadorned markdown.

### File layout

```
doc-watcher/
├── CLAUDE.md                       # this file — project spec
├── package.json
├── tsconfig.json
├── README.md
├── config.example.toml
├── config.toml                     # gitignored
├── .env.example                    # CONFLUENCE_PAT=...
├── .gitignore                      # ignores config.toml, .env, docs/, .claude/, node_modules/
└── src/
    ├── taskmanager.ts              # entry point: init / sync / refresh / reconvert / poll
    ├── config.ts                   # zod schema, TOML loader
    ├── confluence.ts               # REST client (typed wrappers around fetch)
    ├── walker.ts                   # expand watch scopes → page id list (CQL)
    ├── downloader.ts               # parallel fetch + write, p-limit-bounded
    ├── converter.ts                # storage-format → markdown via cheerio + turndown
    ├── pathing.ts                  # title → slug, rename detection
    ├── state.ts                    # better-sqlite3 wrapper, schema migrations
    └── log.ts
```

### Output layout (`docs/` mirrors Confluence)

```
docs/
  index.sqlite                            # state + structural metadata
  ENG/                                    # space key
    _index.html / _index.md               # space homepage
    onboarding--67890/                    # parent page → folder; ID after `--`
      _index.html / _index.md             #   the page itself; ID is in folder name
      setup-guide--99999.html             # leaf child — raw storage format
      setup-guide--99999.md               # leaf child — converted markdown
    attachments/<page_id>/diagram.png
```

**Filename rule.** Each page produces two files side-by-side: `<slug>--<id>.html` (raw Confluence storage format) and `<slug>--<id>.md` (derived markdown). Slug is the lowercase, kebab-cased, ASCII-folded page title. The `--<id>` suffix is the durable anchor — if the directory tree is ever rebuilt without SQLite, files can still be matched back to their Confluence pages by ID alone.

**Page titles can change**, so filenames can change between syncs. The watcher detects renames via the SQLite row (keyed by ID): when title changes, it does the local rename (file or folder) without re-fetching the body. A re-parent moves the file or folder under a new parent. History is preserved if the user's `docs/` is under git.

**Parent vs leaf.** A page with children becomes a folder `<slug>--<id>/` containing `_index.html` and `_index.md`. A leaf is two flat files. This mirrors the way most static-site tools think about hierarchy.

### Change detection

Confluence Server has no dedicated sync endpoint, but CQL on `/rest/api/content/search` is enough:

```
(space = "ENG" OR ancestor = 12345) AND type = page AND lastmodified >= "<last_sync_iso>"
```

For a 10k-page space the typical delta per 5-minute window is 0–50 pages — sub-second API time. `sources.last_sync` in SQLite is the lower bound; first run has none and does a full enumeration. Every subsequent run is delta-only.

**Deletes** aren't visible in the incremental query (they're just absent). The default `sync` runs a cheap id-only full enumeration once per day to reconcile orphans (gated by `sources.last_full_enum`). `refresh` always does a full enumeration.

### Confluence REST endpoints used

- `GET /rest/api/content/search?cql=...&limit=100&expand=version` — list pages, with paging.
- `GET /rest/api/content/{id}?expand=body.storage,version,ancestors,space` — full page (storage-format XHTML).
- `GET /rest/api/content/{id}/child/attachment?expand=version` — attachment list.
- `GET /download/attachments/{pageId}/{filename}` — binary download.

Auth: `Authorization: Bearer $CONFLUENCE_PAT` on every request.

### Converter

Confluence "storage format" is XHTML with `<ac:structured-macro>` extensions. A pre-pass with cheerio rewrites macros to plain HTML, then turndown converts to markdown. A registry of macro handlers covers code blocks, callouts (info/warning/note), images and attachments, internal links, iframes/embeds, status badges, task lists, user mentions, and emoticons. Unknown macros become HTML comments — visible but inert.

Always deterministic, always replayable. The `.html` file on disk is what the converter ran against; given the same HTML and the same converter version, you get the same `.md`.

### Core flows

**`npm start`** is the daily driver: it runs an initial `sync` (full enumeration if state is empty, incremental otherwise), then enters the polling loop. The first run does the bulk download; everything after is cheap deltas. This is the "set it and forget it" mode.

Verbs available when you want a one-shot operation instead:

- **`sync`** (incremental): build CQL with `lastmodified` lower bound, page through results, diff against SQLite, fetch changed pages in parallel, write both `.html` and `.md`, atomic file replace, commit SQLite transaction.
- **`refresh`**: same as `sync` but ignores `last_sync` (full re-download).
- **`reconvert`**: walk every `.html` already on disk and regenerate the `.md` next to it. No network calls. Used after a converter change.
- **`poll`**: `while (true) { await sync(); await sleep(poll_interval); }`. Once-per-day full enumeration is built in so deletes get caught.
- **`bench`**: re-run the concurrency autotune (see below) and persist the result.
- **`init`**: copy `config.example.toml` → `config.toml`, create `.env` template, scaffold dirs.

### Concurrency autotune

The first run is the one that hurts. A space can hold thousands of pages, and the right tuning depends on the network, the server's load, the CPU, and what else is on the machine — there's no universal number that's right. Too low and the initial sync drags; too high and we either saturate the link or trip Confluence's rate limit.

So before the first real `sync`, doc-watcher runs a short empirical benchmark. It sweeps the relevant levers — download concurrency primarily, processing parallelism if it turns out to matter — over a small grid of values, measures elapsed time and error rate at each point, and picks the combination that gave the best throughput without errors. The chosen values get written back into `config.toml` under `[sync]`, alongside any other settings.

After that, every run just reads the values from `config.toml`. The bench doesn't run again unless one of three things happens:

- The relevant value is **missing** from `config.toml` — treated as "re-bench, decide for me." This is also how the user opts back in: delete the value, next run benches.
- The user **manually edits** the value — left alone, treated as user intent. The bench won't overwrite a non-empty value during normal startup.
- The user runs **`npm start -- bench`** explicitly — always re-benches and overwrites, regardless of current values.

There's also a fallback heuristic (`min(50, max(4, cpu_cores * 2))`) for the awkward case where the bench is somehow skipped *and* no value exists in config — but in practice, missing-means-bench keeps this from triggering.

The bench is worth running again when conditions change — moving to a slower link, the Confluence server getting upgraded, etc.

## Out of scope (for now)

- Webhooks. Confluence Server webhooks need admin-level configuration; we only have a user PAT. CQL polling is enough.
- Adapter abstractions for multiple sources (Notion, Confluence Cloud, etc.). Left as a one-source codebase until a second source actually exists.
- Write-back and conflict handling. See nice-to-haves above.
