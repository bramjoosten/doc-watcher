# doc-watcher

Mirror Confluence Server pages to local files — raw HTML alongside converted Markdown, incrementally re-synced. PAT-authenticated, CLI, built for `rg` and local AI workflows.

## Setup

```sh
git clone https://code.bramjoosten.nl/bram/doc-watcher.git
cd doc-watcher
npm install
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

- `base_url` — your Confluence root URL
- `pat` — Personal Access Token (creation steps are in the file's comment)
- `root_page_ids` — one page id or a list; each is the root of a subtree to mirror

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

See [`CLAUDE.md`](./CLAUDE.md) for the full spec — output layout, file formats, frontmatter shape, adaptive concurrency, limitations.
