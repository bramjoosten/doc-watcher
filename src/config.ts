import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Flat schema — every setting lives at the top level. `watch` is a list of
// Confluence page ids; each one is mirrored along with everything beneath it.
export const configSchema = z.object({
  base_url: z.string().url(),
  pat: z.string().min(1, 'pat is required — paste your Confluence PAT'),
  output_dir: z.string().default('./docs'),
  // Missing/undefined = "needs autotune". `npm start` runs the autotune on
  // startup when this is unset, and writes the chosen value back here.
  parallel_downloads: z.number().int().positive().optional(),
  include_attachments: z.boolean().default(false),
  watch: z.array(z.string().min(1)).min(1),
});

export type Config = z.infer<typeof configSchema>;
// A `WatchEntry` is just a page id now — kept as an alias so existing code
// continues to import the same name.
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
