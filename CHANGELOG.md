# Changelog

One entry per deploy. Newest at the top. Plain language — what changed for someone using the tool, not how it was built.

## 2026-06-11 — v1.1.0

- Your PAT can now come from a `DOC_WATCHER_PAT` environment variable instead of `config.ts`. Useful when you keep multiple checkouts and don't want to copy the same secret into each. If both are set the env var wins, and you'll see a one-line note at startup so the source is clear.

## 2026-06-08

- Moved the project to GitHub.
