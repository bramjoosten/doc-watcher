import type { ConfigInput } from './src/config.ts';

// Copy this file to `config.ts` (gitignored) and fill in the placeholders.
// Node 24 reads this directly — no separate parser, no `config.yaml`.
// The `satisfies ConfigInput` annotation gives you autocomplete in your
// editor and turns typos into compile-time errors.

export default {
  // Upper ceiling on parallel page fetches. The adaptive limiter starts at 1
  // and ramps up to this value based on what Confluence's X-RateLimit-* headers
  // say is safe. Lower this to enforce a hard cap; raise it to let the limiter
  // ramp higher. Default (when omitted) is 20.
  parallel_downloads: 20,

  // Root URL of your Confluence install (no trailing slash, no /rest/api).
  base_url: 'https://confluence.example.com',

  // Confluence Server/DC Personal Access Token (Bearer auth).
  // Create one at: <your-confluence>/plugins/personalaccesstokens/usertokens.action
  // (or: profile picture → Settings → Personal Access Tokens → Create token).
  pat: '',

  // Where the mirrored docs go. Both the .html / .md pair for each page and
  // the per-root index files (`index-<title>--<id>.json`) live inside this
  // directory, so moving or backing up the folder carries everything with
  // it. Accepts an absolute path, `~`-prefixed home-relative path, or a path
  // relative to the project working directory.
  output_dir: './docs',

  // Inline images referenced via ac:image macros. Set to true once you've
  // gauged bandwidth on a small first sync — a space with diagrams can
  // easily push tens of GB. Non-inline file attachments (PDFs, decks, etc.)
  // are not mirrored either way.
  include_attachments: false,

  // Confluence page id(s) whose subtree(s) to mirror. One id or a list:
  //   root_page_ids: '123456',
  //   root_page_ids: ['123456', '234567'],
  // Find the id in the URL (?pageId=NNNNN); if you only see the pretty
  // /display/SPACE/Title form, click Edit and the id appears.
  root_page_ids: '123456',
} satisfies ConfigInput;
