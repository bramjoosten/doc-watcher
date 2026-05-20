# doc-watcher

Mirror a Confluence Server (DC 7.9+) tree to local files — the raw HTML (the durable source of truth) plus a clean Markdown view next to it for `rg`, editors, and local AI. PAT-authenticated, walks one or more configured page subtrees, incrementally re-syncs only changed pages.

Webhooks are out of scope (they need Confluence admin access; we only assume a user-level PAT). Change detection is CQL polling on `lastmodified`.

## Setup

```sh
git clone https://code.bramjoosten.nl/bram/doc-watcher.git
cd doc-watcher
npm install
cp config.example.yaml config.yaml
```

Open `config.yaml` and fill in:
- `confluence.base_url` — your Confluence root URL.
- `confluence.pat` — your Personal Access Token (creation steps are in the comment above the field).
- `root_page_ids` — one Confluence page id (as a string) or a list of them; each id is the root of a subtree to mirror.

`config.yaml` is gitignored; the example file stays clean.

## Run

```sh
npm start
```

That's the daily-driver. With no args it runs an **incremental sync** — the first invocation does the bulk download (state is empty), every subsequent run only fetches pages that changed since the last sync. Then it exits. Run it again whenever you want fresh docs.

The very first run also benchmarks download concurrency on a sample of pages and writes the chosen value into `config.yaml` under `sync.parallel_downloads`, so future runs reuse it. Comment out (or delete) that line to force a re-bench; edit it by hand to pin a specific value.

**Resumable**: state is flushed after every successful page write. If you Ctrl+C mid-sync (or anything else interrupts the process), just run `npm start` again — already-downloaded pages are skipped via their stored version number, and the sync picks up where it left off.

## One-shot verbs

For manual operations instead of the default sync flow:

- `npm start -- sync` — one incremental sync, then exit (same as the default).
- `npm start -- refresh` — full re-download (ignores `last_sync`, reconciles deletes).
- `npm start -- reconvert` — regenerate every `.md` from the saved `.html`. No network.

## Output layout

The local tree mirrors Confluence; each page's id is appended after `--` so title changes become clean `git mv`s. Every page produces two files side by side — `.html` (raw storage format, the source of truth) and `.md` (the human-readable view derived from it).

```
docs/
  .state.json                         # state, page metadata, link resolution (hidden)
  ENG/
    _index.html / _index.md
    onboarding--67890/
      _index.html / _index.md
      setup-guide--99999.html
      setup-guide--99999.md
    attachments/67890/diagram.png
```

The `.md` has no YAML frontmatter — just the page body, prefixed with a one-line autolink back to the Confluence source so anyone reading the file knows where it came from. All structured metadata (id, version, ancestors, links, embeds) lives in `<output_dir>/.state.json`.

## Limitations

- Webhooks are not supported — only PAT-level access is assumed. CQL polling is the change-detection mechanism.
- `ac:link`s pointing outside any configured scope fall back to absolute Confluence URLs.
- Attachments are downloaded only when referenced by an `ac:image` macro; arbitrary page attachments are not mirrored.

See [`CLAUDE.md`](./CLAUDE.md) for the full spec.
