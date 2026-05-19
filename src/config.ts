import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

// .env is loaded by Node's --env-file-if-exists flag (see package.json `start` script),
// so process.env is already populated by the time this module runs.

const watchSpaceSchema = z.object({
  type: z.literal('space'),
  key: z.string().min(1),
});

const watchTreeSchema = z.object({
  type: z.literal('tree'),
  root_page_id: z.string().min(1),
});

export const watchSchema = z.discriminatedUnion('type', [watchSpaceSchema, watchTreeSchema]);

export const configSchema = z.object({
  confluence: z.object({
    base_url: z.string().url(),
    pat_env: z.string().min(1).default('CONFLUENCE_PAT'),
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
      // Missing/undefined = "needs autotune". `npm start` runs `bench` on startup
      // when this is unset, and bench writes the chosen value back into config.toml.
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
  pat: string;
  configPath: string;
  rootDir: string;
}

export async function loadConfig(configPath = resolve(process.cwd(), 'config.toml')): Promise<LoadedConfig> {
  const raw = await readFile(configPath, 'utf8');
  const parsed = parseToml(raw);
  const config = configSchema.parse(parsed);
  const envName = config.confluence.pat_env;
  const pat = process.env[envName];
  if (!pat) {
    throw new Error(`Missing PAT: env var "${envName}" is not set. Copy .env.example to .env and fill it in.`);
  }
  return { config, pat, configPath, rootDir: process.cwd() };
}
