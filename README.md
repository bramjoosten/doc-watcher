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

Incremental sync — the first invocation downloads everything, every later run only fetches what changed since `last_sync`. Resumable on Ctrl+C: just run again to pick up where you stopped. Concurrency self-tunes from Confluence's `X-RateLimit-*` headers, so there's nothing to manually configure beyond the optional `parallel_downloads` ceiling.

## Other verbs

- `npm start -- refresh` — full re-download (ignores `last_sync`, reconciles deletes)
- `npm start -- reconvert` — regenerate every `.md` from the saved `.html` (no network)

See [`CLAUDE.md`](./CLAUDE.md) for the full spec — output layout, file formats, frontmatter shape, adaptive concurrency, limitations.
