import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { log } from './log.ts';
import { messages } from './messages.ts';

// `~` is a shell construct; Node doesn't expand it. Doing it manually so users
// can put `output_dir: '~/my-confluence-docs'` in config.ts without surprise.
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

// Flat schema — every setting lives at the top level. `roots` accepts either a
// single URL or an array of URLs. Each URL is a full Confluence page or space
// link as you'd paste from your browser; doc-watcher derives the base URL from
// the origin and resolves each to a page id at startup (no more `base_url`,
// no more raw numeric `root_page_ids`).
export const configSchema = z.object({
  pat: z.string().min(1, 'pat is required — paste your Confluence PAT'),
  output_dir: z.string().default('./docs').transform(expandTilde),
  roots: z
    .union([z.string().url(), z.array(z.string().url()).min(1)])
    .transform((v) => (Array.isArray(v) ? v : [v])),
});

// User-facing input shape — what you type in your config.ts. Use this with
// `satisfies` to get autocomplete + a compile error if you typo a key.
export type ConfigInput = z.input<typeof configSchema>;
// Internal normalised shape — tilde-expanded paths, roots guaranteed to be an
// array. Everything downstream of loadConfig uses this.
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
  // Catch the easy mistake of editing a stale config file from before the
  // TS-module migration. The TS module is the only source we read; anything
  // else lying around is ignored and silently leaves the user wondering why
  // their edits had no effect.
  const dir = dirname(configPath);
  for (const stale of ['config.yaml', 'config.yml', 'config.json']) {
    if (existsSync(resolve(dir, stale))) {
      log.warn(messages.config.staleConfigFile(stale));
    }
  }
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
