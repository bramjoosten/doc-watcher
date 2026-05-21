import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

// `~` is a shell construct; Node doesn't expand it. Doing it manually so users
// can put `output_dir: '~/my-confluence-docs'` in config.ts without surprise.
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

// Flat schema — every setting lives at the top level. `root_page_ids` accepts
// either a single string or an array of strings; each is the id of a
// Confluence page whose subtree (the page + every descendant) gets mirrored.
export const configSchema = z.object({
  base_url: z.string().url(),
  pat: z.string().min(1, 'pat is required — paste your Confluence PAT'),
  output_dir: z.string().default('./docs').transform(expandTilde),
  include_attachments: z.boolean().default(false),
  root_page_ids: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .transform((v) => (Array.isArray(v) ? v : [v])),
});

// User-facing input shape — what you type in your config.ts. Use this with
// `satisfies` to get autocomplete + a compile error if you typo a key.
export type ConfigInput = z.input<typeof configSchema>;
// Internal normalised shape — tilde-expanded paths, root_page_ids guaranteed
// to be an array. Everything downstream of loadConfig uses this.
export type Config = z.infer<typeof configSchema>;

export interface LoadedConfig {
  config: Config;
  configPath: string;
  rootDir: string;
}

// Load the user's `config.ts` from the project root via dynamic import. The
// file is a TS module the user edits directly — Node strips its types at
// load time, so no separate parser/validator step is needed beyond the zod
// schema, which validates the runtime shape and applies tilde expansion +
// array normalisation.
export async function loadConfig(
  configPath = resolve(process.cwd(), 'config.ts'),
): Promise<LoadedConfig> {
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to load ${configPath}: ${cause}. Copy config.example.ts to config.ts and fill in the placeholders.`,
    );
  }
  if (mod.default === undefined) {
    throw new Error(
      `${configPath} has no default export. The file should \`export default { ... } satisfies ConfigInput;\` — see config.example.ts.`,
    );
  }
  const config = configSchema.parse(mod.default);
  return { config, configPath, rootDir: process.cwd() };
}
