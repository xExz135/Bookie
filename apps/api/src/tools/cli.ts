import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import { type AppConfig, loadConfig } from '../config/app-config';
import { findRepoRoot } from '../repo-root';

/** Shared start-up for command-line tools: root .env, settings, arguments. */
export function startCli<T extends NonNullable<ParseArgsConfig['options']>>(
  options: T,
  settings: { positionals?: boolean } = {},
): {
  root: string;
  config: AppConfig;
  values: ReturnType<typeof parseArgs<{ options: T }>>['values'];
  /** Words that are not options, e.g. a step name; only with `positionals: true`. */
  positionals: string[];
} {
  const root = findRepoRoot();
  const envFile = join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig();
  // pnpm may pass a leading "--" separator through; ignore it.
  const args = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'));
  const { values, positionals } = parseArgs({
    args,
    options,
    allowPositionals: settings.positionals ?? false,
  });
  return { root, config, values, positionals };
}

export function wholeNumber(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a whole number above 0, got "${value}"`);
  return n;
}

export function timestamp(): string {
  return `[${new Date().toISOString().slice(11, 19)}]`;
}

export function runCli(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
