# doc-watcher

A local watcher script that mirrors a Confluence Server (on-prem) tree to disk so it can be searched and queried by IDE's and local AI. Authenticates with a user-level Personal Access Token, downloads in parallel with adaptive concurrency, and re-runs incrementally — every run re-enumerates the full subtree metadata, but only pages whose `version` has changed actually get re-fetched.

Node.js, TypeScript, run via `tsx`.

## Requirements

### Must-have

- **Fast (parallel downloads).** A space can hold thousands of pages. The fetcher runs requests in parallel with bounded concurrency — enough to keep the network pipe full, not enough to get rate-limited.
- **Keep in sync.** Cheap re-runs: every run paginates the full subtree's page list (metadata only, no bodies) and diffs each page's `version` against the local state to decide what to actually re-fetch. Removes pages that have been deleted or moved out of scope. Two runs back-to-back should produce identical output.
- **Node.js only (no Python).** Many organisations keep their stack narrow. Ruling out Python up front means doc-watcher drops into any Node-based environment without adding a runtime.
- **Keep the source HTML alongside the markdown.** For each page we save both `<file>.html` (the raw Confluence storage-format response) and `<file>.md` (the readable conversion). The HTML is the durable source of truth; the markdown is a regeneratable view. Conversion runs through a deterministic script (cheerio + an in-house HTML→Markdown walker + a macro registry), never an LLM, so re-running the converter on the saved HTML always produces the same markdown. If a future converter improvement lands, the corpus can be re-derived without re-hitting Confluence.

### Nice-to-have

- **Write back to Confluence.** Local folder as source of truth, push edits back as page versions. Opens the door to git-versioned docs, AI-generated pages, and round-trip workflows. Not in the first version.
- **Conflict handling.** Once write-back exists, simultaneous Confluence/local edits become a real problem. Flag and defer.

## Architecture

### Stack

- **Node 22+** with **TypeScript**, run via `tsx` in dev (no build step).
- Built-in `fetch` (undici); a 15-line inline `pLimit` helper for bounded-concurrency parallel downloads.
- `cheerio` for parsing Confluence storage-format XHTML.
- In-house HTML→Markdown walker in `converter.ts` (no `turndown` — DOM-lib transitive deps kept tripping corp security scanners).
- `zod` for typed config validation; `yaml` for YAML parsing.
- Credentials live in `config.yaml` directly — no `.env` file, no env-var indirection.

**Minimize third-party dependencies.** Reach for the Node standard library first; a dep only earns its keep when the alternative would be hundreds of lines of nontrivial code (XHTML parsing, HTML→markdown conversion). **No native modules** — the tool has to install on locked-down corporate machines where the npm proxy MITMs TLS and prebuilt binaries fail to download. Pure JavaScript across the board. The CLI is a plain Node entry point using `process.argv` — no `commander` / `yargs` / etc. Logging is `console.log` / `console.error`. No test framework for now.

### State: per-root JSON indexes (source of truth) + lightweight frontmatter view

State lives in **per-root index files** at `<output_dir>/index-<slug>--<root_id>.json` — one per entry in `root_page_ids`. Each index covers the pages in its own subtree; the indexes are independent on disk but the resolver maps that link pages to local paths are merged across indexes at runtime so cross-root `ac:link` references still resolve. Writes are atomic via `tmp` + `rename` — interrupted runs never leave a half-written index file.

The index is the **source of truth** for all structural metadata: Confluence ID, version, ancestors, last-modified, links, embeds, webui URL. The `.md` files carry a small **regeneratable** YAML frontmatter view of the same data, so a single `.md` is self-describing without consulting the index — but the index always wins. Frontmatter fields are: `title`, `version`, `last_modified`, `last_modified_by`, `webui_url`. The frontmatter is rewritten by `reconvert` from index data on every run; nothing depends on the body of the frontmatter being canonical, so it can drift mid-run without consequence (the next sync or reconvert overwrites it).

The top of each index opens with a self-describing `description` string so anyone opening the file knows what it is and how it's maintained — regenerated on every full write, not state. Followed by identification and counters — `root_page_id`, `root_title`, `total_watched_pages_on_remote` (what Confluence reported in the last sync), `total_pages_downloaded` (current size of the `pages` map), and the `last_sync` timestamp. Counters are updated incrementally as each page is written, so an interrupted run leaves them in sync with what's actually on disk. The bulk `pages` map sits below.

Filename uses `--<root_id>` as the durable anchor — a root-title change just renames the file but leaves the index discoverable by id. Discovery is by glob (`index-*--<root_id>.json`); whoever owns the index wins.

State is **flushed after every successful page write** during a sync, not just at the end. So an interrupt (Ctrl+C, crash, network failure) leaves the state file reflecting exactly the pages already on disk. The next `npm start` re-enumerates the full subtree, diffs against the persisted per-page versions, and only fetches the pages not yet recorded. Resume is automatic — no `--resume` flag, no special verb.

**Failed pages get retried automatically on the next run.** `last_sync` only advances when a run completes with zero per-page errors. Any failure (exhausted 429 backoff, 4xx other than rate-limit, 5xx, network errors) keeps `last_sync` frozen at its previous value. Successful pages from prior runs are skipped via the version diff (`state.pages[id].version === current`); the failed ones — which have no `state.pages` entry — fall back into `toFetch` and get re-attempted. No separate retry queue or `failed_ids` list to maintain.

JSON over SQLite is deliberate: doc-watcher is single-process and the whole state is small (a few hundred KB even for 10k pages), so the durability and concurrency advantages of an embedded DB don't pay back the cost of a native dependency that may not install on locked-down corporate machines.

**Markdown frontmatter view.** Every converted `.md` starts with a YAML frontmatter block carrying `title`, `version`, `last_modified`, `last_modified_by`, and `webui_url`. The `webui_url` is the full clickable URL (with base) so the file is self-traceable without consulting the index. The frontmatter is composed from the per-root index entry at write time — the index is the source of truth, the frontmatter is a regeneratable view; `reconvert` rewrites it from index data on every run. The body itself starts with `# <title>` as the H1 (Confluence's storage-format body doesn't include the title, so we add it for plain markdown viewers that don't read frontmatter).

**Per-page write goes to a sibling `.jsonl`, finalized into `.json` at end of sync.** Rewriting the full ~MB-sized `.json` on every page flush was wasteful. Each per-page success appends one line to `<output_dir>/index-<slug>--<id>.jsonl` instead. At the end of each per-root sync, `finalizeIndex` collapses the in-memory state into a fresh `.json` snapshot and deletes the `.jsonl`. If a sync is interrupted, the `.jsonl` persists; the next `readIndex` overlays its lines onto the loaded `.json` (last-wins by id), so resume is transparent.

**Tree view.** Alongside each `index-<slug>--<id>.json`, a `tree-<slug>--<id>.json` carries a nested human-oriented view of the subtree — handy for IDE code-folding and visual navigation. Top-level shape is `{ description, root: { id, title, webui_url, last_modified, last_modified_by, children: [...] } }`. The `description` exists because the tree is a *reference document*, not state — the source of truth is the sibling index file. The `webui_url` on each node is a full clickable URL into Confluence. Regenerated from the index at every `finalizeIndex`.

### File layout

```
doc-watcher/
├── CLAUDE.md                       # this file — project spec
├── package.json
├── tsconfig.json
├── README.md
├── config.example.yaml
├── config.yaml                     # gitignored — base_url, pat, root_page_ids, etc.
├── .gitignore                      # ignores config.yaml, docs/, .claude/, node_modules/
└── src/
    ├── taskmanager.ts              # entry point: sync / refresh / reconvert
    ├── config.ts                   # zod schema, YAML loader
    ├── confluence.ts               # REST client (typed wrappers around fetch)
    ├── downloader.ts               # parallel fetch + write, p-limit-bounded
    ├── converter.ts                # storage-format → markdown: cheerio macro pre-pass + in-house walker
    ├── pathing.ts                  # title → slug, rename detection
    ├── adaptive-limiter.ts         # slow-start + AIMD + budget-aware concurrency
    ├── state.ts                    # JSON state file: read, atomic write
    └── log.ts
```

### Output layout (`docs/` mirrors Confluence)

```
docs/
  index-team-foo--12345.json              # per-root index for root id 12345
  tree-team-foo--12345.json               # nested view of the same subtree
  index-team-bar--67890.json              # per-root index for root id 67890
  tree-team-bar--67890.json               # nested view
  ENG/                                    # space key
    _index.html / _index.md               # space homepage
    onboarding--67890/                    # parent page → folder; ID after `--`
      _index.html / _index.md             #   the page itself; ID is in folder name
      setup-guide--99999.html             # leaf child — raw storage format
      setup-guide--99999.md               # leaf child — converted markdown
    attachments/<page_id>/diagram.png
```

**Filename rule.** Each page produces two files side-by-side: `<slug>--<id>.html` (raw Confluence storage format) and `<slug>--<id>.md` (derived markdown). Slug is the lowercase, kebab-cased, ASCII-folded page title. The `--<id>` suffix is the durable anchor — if the state file is ever lost, files can still be matched back to their Confluence pages by ID alone.

**Ancestors above the configured `root_page_id` are stripped from the path.** Confluence returns the full ancestor chain on every page (space root → intermediate → ... → configured root → page); using every level as a directory would create empty subdirs on disk for ancestors we don't watch. `pickPageRelPath` finds the deepest ancestor that's in the configured `root_page_ids` set and starts the path from there, producing `<space>/<configured-root>/<intermediate>/<page>` instead of `<space>/<intermediate-1>/<intermediate-2>/.../<configured-root>/<page>`.

**Page titles can change**, so filenames can change between syncs. The watcher detects renames via the state entry (keyed by ID): when title changes, it does the local rename (file or folder) without re-fetching the body. A re-parent moves the file or folder under a new parent. History is preserved if the user's `docs/` is under git.

**Parent vs leaf.** A page with children becomes a folder `<slug>--<id>/` containing `_index.html` and `_index.md`. A leaf is two flat files. This mirrors the way most static-site tools think about hierarchy.

### Change detection

Confluence Server has no dedicated sync endpoint. We enumerate each configured root via two paginated calls per root, both DB-backed:

- `GET /rest/api/content/{rootId}?expand=version,space,ancestors` — the root page itself.
- `GET /rest/api/content/{rootId}/descendant/page?expand=version,space,ancestors` — every descendant in the subtree.

The per-page `version` returned by Confluence is then diffed against the local index: pages with a higher version (or no entry in state) get fetched with `expand=body.storage`; everything else is skipped. New pages, edits, renames, re-parents and deletes all fall out of this single mechanism.

**Why `/descendant/page` and not CQL?** We previously enumerated via `/rest/api/content/search` (CQL: `(id = N OR ancestor = N) AND type = page`). CQL is fast but routes through Confluence's Lucene search index, which can lag the database — and on instances with an unhealthy background indexer, brand-new pages may not appear in the index at all (which also makes them invisible to the in-app search bar). `/descendant/page` walks the persisted parent-ancestor relationship table directly, so newly-created pages show up immediately, regardless of whether the search index has caught up. The cost is similar (~1 request per 100 descendants, no body expansion).

**Deletes.** A page that's been deleted or archived in Confluence disappears from the descendant listing. Anything in the local index but not in the latest enumeration falls into the orphan set; both its `.html` and `.md` are removed from disk and the state entry is dropped.

### Confluence REST endpoints used

- `GET /rest/api/content/{id}/descendant/page?expand=version,space,ancestors&limit=100` — every page in the subtree (DB-backed, bypasses Lucene). Paginated.
- `GET /rest/api/content/{id}?expand=body.storage,version,ancestors,space` — full page (storage-format XHTML). Also used to fetch the root page itself.
- `GET /rest/api/content/{id}/child/attachment?expand=version` — attachment list.
- `GET /download/attachments/{pageId}/{filename}` — binary download.

Auth: `Authorization: Bearer <pat from config.yaml>` on every request.

TLS certificate verification is disabled process-wide (`NODE_TLS_REJECT_UNAUTHORIZED=0`, set in `src/disable-tls-check.ts` which is imported first). Corporate Confluence instances often sit behind private CAs that Node doesn't trust out of the box; rather than asking every user to wrangle a PEM bundle, doc-watcher just skips cert verification. The deliberate scope: a single-user CLI talking to a Confluence on a network you already trust. The warning Node would otherwise print on every HTTPS connection is filtered out by patching `process.emitWarning`.

### Converter

Confluence "storage format" is XHTML with `<ac:structured-macro>` extensions. A pre-pass with cheerio rewrites macros to plain HTML, then an in-house walker emits markdown. A registry of macro handlers covers code blocks, callouts (info/warning/note), images and attachments, internal links, iframes/embeds, status badges, task lists, user mentions, and emoticons. Unknown macros become HTML comments — visible but inert. The walker handles the standard HTML tag set (p, h1–h6, ul/ol/li with nesting, strong/em/code, pre+code with language hint, a, img, blockquote with our callout data attribute, GFM tables, hr, br).

Always deterministic, always replayable. The `.html` file on disk is what the converter ran against; given the same HTML and the same converter version, you get the same `.md`.

### Core flows

**`npm start`** is the daily driver. With no args it runs `sync`: incremental if state exists, full enumeration if it doesn't (so the first invocation does the bulk download). Run it again whenever you want fresh docs — subsequent runs only fetch what changed.

Verbs:

- **`sync`** (default): enumerate the full subtree via `/rest/api/content/{rootId}/descendant/page` plus a direct fetch of the root (`expand=version,space,ancestors`, no body), diff each page's version against state, fetch any new-or-changed pages in parallel, write both `.html` and `.md`, atomic state-file replace at the end.
- **`refresh`**: same as `sync` but ignores `last_sync` (full re-download).
- **`reconvert`**: walk every `.html` already on disk and regenerate the `.md` next to it. No network calls. Used after a converter change.

Setup is manual: copy `config.example.yaml` → `config.yaml` and fill in the placeholders (`base_url`, `pat`, at least one `root_page_ids` entry). The YAML is intentionally flat — every key sits at the top level. `root_page_ids` accepts either a single string or a list of strings; each is a Confluence page id whose subtree gets mirrored.

### Concurrency: adaptive limiter informed by server headers

`parallel_downloads` in `config.yaml` is an *upper ceiling*, not a target. The adaptive limiter starts at concurrency = 1 (slow-start), doubles every 50 sustained successes up to the ceiling, and halves immediately on every 429-wave. `Retry-After` becomes a minimum inter-request spacing for the next window.

On top of that reactive AIMD, the client reads Confluence DC's `X-RateLimit-*` headers (`Limit`, `Remaining`, `Interval-Seconds`, `FillRate`) on *every* authenticated response and feeds them to the limiter. When `remaining/limit` drops below 20%, the limiter paces new requests at the sustainable refill rate (`intervalSeconds / fillRate`); below 5%, it pauses long enough for at least one token to refill. Goal: avoid hitting 429 in the first place rather than reacting after the fact. The first observed budget is also logged so you see what your server actually allows (e.g. *"50-token bucket, fills at 10/60s = 0.17 req/s sustainable"*).

The HTTP client also retries 429/503 with exponential backoff (up to 8 attempts, max 60 s per wait, `Retry-After` honoured) as a fallback for when budget signals arrive too late or are missing. The retry uses a **client-wide cooldown**: when any one in-flight request gets rate-limited, the wait window is broadcast to every other in-flight request via a shared `throttledUntilMs` on the client. Without that, parallel retries pile back onto the throttled server and turn a single 429 into a cascading storm even at low concurrency.

No explicit autotune step: with budget headers driving the rate, an upfront benchmark adds no information the limiter can't discover live. The ceiling is just a config knob (default 20); the limiter does the rest.

## Out of scope (for now)

- Webhooks. Confluence Server webhooks need admin-level configuration; we only have a user PAT. Polling is enough.
- Adapter abstractions for multiple sources (Notion, Confluence Cloud, etc.). Left as a one-source codebase until a second source actually exists.
- Write-back and conflict handling. See nice-to-haves above.
