# doc-watcher

Mirror a Confluence Server (DC 7.9+) tree to local files — the raw HTML (the durable source of truth) plus a clean Markdown view next to it for `rg`, editors, and local AI. PAT-authenticated, walks one or more configured scopes (a whole space, or a page subtree by root id), incrementally re-syncs only changed pages.

Webhooks are out of scope (they need Confluence admin access; we only assume a user-level PAT). Change detection is CQL polling on `lastmodified`.

## Setup

```sh
git clone https://code.bramjoosten.nl/bram/doc-watcher.git
cd doc-watcher
npm install
npm start -- init
```

`init` writes `config.toml` and `.env` from the example templates and scaffolds the working dirs. Edit `config.toml` to set `base_url` and add your `[[watch]]` scopes, then put your token in `.env` (see `.env.example` for how to create the PAT).

## Run

```sh
npm start
```

That's the daily-driver mode: an initial sync, then a polling loop. The first run also benchmarks download concurrency on a sample of pages and writes the chosen value into `config.toml` under `[sync]`, so future runs reuse it. Delete that key to re-bench; edit it by hand to pin a value.

To leave it running, drop it under launchd / systemd / a tmux session. There's no cron: the process is the watcher.

## One-shot verbs

For manual operations instead of leaving the watcher running:

- `npm start -- sync` — one incremental sync, then exit.
- `npm start -- refresh` — full re-download (ignores `last_sync`, reconciles deletes).
- `npm start -- reconvert` — regenerate every `.md` from the saved `.html`. No network.
- `npm start -- bench` — re-run the concurrency benchmark, overwrite the stored value.
- `npm start -- init` — scaffold templates (see Setup).

## Output layout

The local tree mirrors Confluence; each page's id is appended after `--` so title changes become clean `git mv`s. Every page produces two files side by side — `.html` (raw storage format, the source of truth) and `.md` (the human-readable view derived from it).

```
.state/
  index.json                          # state, page metadata, link resolution
docs/
  ENG/
    _index.html / _index.md
    onboarding--67890/
      _index.html / _index.md
      setup-guide--99999.html
      setup-guide--99999.md
    attachments/67890/diagram.png
```

The `.md` has no YAML frontmatter — just the page body, prefixed with a one-line autolink back to the Confluence source so anyone reading the file knows where it came from. All structured metadata (id, version, ancestors, links, embeds) lives in `.state/index.json`.

## Limitations

- Webhooks are not supported — only PAT-level access is assumed. CQL polling is the change-detection mechanism.
- `ac:link`s pointing outside any configured scope fall back to absolute Confluence URLs.
- Attachments are downloaded only when referenced by an `ac:image` macro; arbitrary page attachments are not mirrored.

See [`CLAUDE.md`](./CLAUDE.md) for the full spec.
