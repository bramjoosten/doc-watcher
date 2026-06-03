import type { ConfigInput } from './src/config.ts';

// Copy this file to `config.ts` (gitignored) and fill in the placeholders.
// Node 24 reads this directly — no separate parser, no `config.yaml`.
// The `satisfies ConfigInput` annotation gives you autocomplete in your
// editor and turns typos into compile-time errors.

export default {
  // Confluence Server/DC Personal Access Token (Bearer auth).
  // Create one at: <your-confluence>/plugins/personalaccesstokens/usertokens.action
  // (or: profile picture → Settings → Personal Access Tokens → Create token).
  pat: '',

  // Where the mirrored docs go. Both the .html / .md pair for each page and
  // the per-root index files (`index-<title>--<id>.json`) live inside this
  // directory, so moving or backing up the folder carries everything with
  // it. Accepts an absolute path, `~`-prefixed home-relative path, or a path
  // relative to the project working directory. Default puts it as a sibling
  // of the doc-watcher repo so you can open the mirrored corpus in a
  // separate IDE window (or just `cd ../docs` and ripgrep it) without the
  // doc-watcher source getting in the way.
  output_dir: '../docs',

  // Confluence page or space URL(s) whose subtree(s) to mirror. Paste the
  // URL from your browser address bar — any of these shapes work:
  //   /pages/viewpage.action?pageId=12345      (id form, no lookup needed)
  //   /spaces/<KEY>/pages/12345/Title          (newer DC style)
  //   /spaces/<KEY>/overview                    (newer-UI space homepage)
  //   /spaces/<KEY>                             (newer-UI space homepage, bare)
  //   /display/<KEY>/Page+Title                (pretty form — one lookup)
  //   /display/<KEY>                            (space homepage)
  //   /spaces/viewspace.action?key=<KEY>        (space homepage, action form)
  // The Confluence base URL is derived from the first URL's origin, so
  // there's no separate base_url to keep in sync. All roots must share an
  // origin (one Confluence per run). If you list a root that's nested
  // under another root in your config, the descendant is dropped at startup
  // with a warning — the parent already covers it.
  roots: 'https://confluence.example.com/pages/viewpage.action?pageId=123456',
} satisfies ConfigInput;
