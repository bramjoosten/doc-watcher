import type { ConfigInput } from './src/config.ts';

// Copy to `config.ts` (gitignored) and fill in the placeholders.
//
// Environment overrides: any value below can be overridden by an environment
// variable, handy when you keep multiple checkouts and don't want to copy a
// secret into each config.ts. Currently supported:
//   - DOC_WATCHER_PAT  →  pat
// If set (non-empty) the env var wins over the value here, and a one-liner is
// logged at startup so you can see it took effect. Set it in your shell
// profile, or pass it inline: `DOC_WATCHER_PAT=xxx npm start`.

export default {
  // Confluence PAT. Create at: <confluence>/plugins/personalaccesstokens/usertokens.action
  // Leave blank if you set DOC_WATCHER_PAT in your environment.
  pat: '',

  // Where to store the downloaded docs. By default, next to this project.
  output_dir: '../docs',

  // Confluence page or space URLs to mirror — paste from your browser.
  roots: [
    'https://confluence.example.com/pages/viewpage.action?pageId=123456',
    'https://confluence.example.com/display/ENG/Onboarding+Guide',
  ],
} satisfies ConfigInput;
