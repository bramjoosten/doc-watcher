import type { ConfigInput } from './src/config.ts';

// Copy to `config.ts` (gitignored) and fill in the placeholders.

export default {
  // Confluence PAT. Create at: <confluence>/plugins/personalaccesstokens/usertokens.action
  pat: '',

  // Where mirrored docs go (per-root index JSONs live here too).
  output_dir: '../docs',

  // Confluence page or space URLs to mirror — paste from your browser.
  roots: [
    'https://confluence.example.com/pages/viewpage.action?pageId=123456',
    'https://confluence.example.com/display/ENG/Onboarding+Guide',
  ],
} satisfies ConfigInput;
