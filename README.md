# doc-watcher

Mirrors a Confluence Server (DC 7.9+) tree to local Markdown so it can be searched with `rg` and fed into local AI tools. Authenticates via Personal Access Token, walks one or more configured scopes (whole space or a page subtree by root id), reproduces the Confluence hierarchy on disk, and incrementally re-syncs only changed pages on every run. Webhooks are out of scope (Confluence Server webhooks need admin); change detection is CQL polling on `lastmodified`.

## Install

```sh
pnpm install
```

Requires Node 22+.

## Configure

```sh
pnpm dev init
```

Then edit `config.toml` (set `base_url` and your `[[watch]]` scopes) and put your token in `.env`:

```
CONFLUENCE_PAT=your-personal-access-token
```

## Usage

- `pnpm dev init` — scaffold `config.toml`, `.env`, and working dirs.
- `pnpm dev sync` — incremental sync (delta from `last_sync`); a full id enumeration is folded in once per 24h to catch deletes. `--force-full-enumeration` forces it now.
- `pnpm dev refresh` — full re-download; ignores state and reconciles deletes.
- `pnpm dev poll` — loop `sync` forever at `poll_interval_seconds`.

## Output layout

The local tree mirrors Confluence; each page's id is appended after `--` so renames are clean `git mv`s.

```
docs/
  ENG/
    _index.md
    onboarding--67890/
      _index.md
      setup-guide--99999.md
    attachments/67890/diagram.png
```

## Frontmatter

Every `.md` opens with:

```yaml
---
confluence_id: "12345"
confluence_url: "https://confluence.example.com/pages/viewpage.action?pageId=12345"
space: "ENG"
title: "Setup guide"
version: 42
last_modified: "2026-05-01T12:00:00Z"
ancestors: ["10000", "12000"]
sync_time: "2026-05-04T08:30:00Z"
---
```

## Scheduling

launchd snippet for a persistent poller (macOS):

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/pnpm</string>
  <string>--dir</string>
  <string>/Users/you/Repositories/doc-watcher</string>
  <string>dev</string>
  <string>poll</string>
</array>
<key>KeepAlive</key><true/>
```

Or a cron line that re-runs `sync` every 10 minutes:

```
*/10 * * * * cd ~/Repositories/doc-watcher && pnpm dev sync >> ~/.local/state/doc-watcher.log 2>&1
```

## Limitations

- Webhook mode is not supported (requires Confluence Server admin access; only PAT is assumed).
- `ac:link`s pointing outside any configured scope fall back to absolute Confluence URLs.
- Attachments are downloaded only when referenced by an `ac:image` macro; arbitrary page attachments are not mirrored.

See `.claude/plans/doc-watcher.md` for the full design.
