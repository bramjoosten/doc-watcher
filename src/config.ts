import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Each watch entry mirrors one Confluence page subtree (the root page and
// everything beneath it). Add more entries to mirror additional roots.
export const watchSchema = z.object({
  root_page_id: z.string().min(1),
});

export const configSchema = z.object({
  confluence: z.object({
    base_url: z.string().url(),
    pat: z.string().min(1, 'pat is required in confluence: — paste your Confluence PAT here'),
    verify_tls: z.boolean().default(true),
  }),
  paths: z
    .object({
      output_dir: z.string().default('./docs'),
      state_dir: z.string().default('./.state'),
      cache_html: z.boolean().default(false),
    })
    .default({ output_dir: './docs', state_dir: './.state', cache_html: false }),
  sync: z
    .object({
      // Missing/undefined = "needs autotune". `npm start` runs the autotune on
      // startup when this is unset, and writes the chosen value back here.
      parallel_downloads: z.number().int().positive().optional(),
      include_attachments: z.boolean().default(false),
      poll_interval_seconds: z.number().int().positive().default(600),
    })
    .default({ include_attachments: false, poll_interval_seconds: 600 }),
  watch: z.array(watchSchema).min(1),
});

export type Config = z.infer<typeof configSchema>;
export type WatchEntry = z.infer<typeof watchSchema>;

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
