import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// `~` is a shell construct; Node doesn't expand it. Doing it manually so users
// can put `output_dir: ~/my-confluence-docs` in config.yaml without surprise.
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
  // Missing/undefined = "needs autotune". `npm start` runs the autotune on
  // startup when this is unset, and writes the chosen value back here.
  parallel_downloads: z.number().int().positive().optional(),
  include_attachments: z.boolean().default(false),
  root_page_ids: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .transform((v) => (Array.isArray(v) ? v : [v])),
});

export type Config = z.infer<typeof configSchema>;
// A page-id string — the unit a planScope / fetchAndWriteOne operates on.
export type WatchEntry = string;

export interface LoadedConfig {
  config: Config;
  configPath: string;
  rootDir: string;
}

export async function loadConfig(configPath = resolve(process.cwd(), 'config.yaml')): Promise<LoadedConfig> {
  const raw = await readFile(configPath, 'utf8');
  const parsed = parseYaml(raw);
  const config = configSchema.parse(parsed);
  return { config, configPath, rootDir: process.cwd() };
}
