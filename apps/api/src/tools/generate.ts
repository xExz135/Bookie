/**
 * Writes the generated files, or with --check fails when they are out of date (used in CI):
 *   contract/openapi.json   from the API's controllers and DTOs
 *   .env.example            from src/config/params.ts
 */
import 'reflect-metadata';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createApp } from '../app.factory';
import { loadConfig } from '../config/app-config';
import { renderEnvExample } from '../config/env-example';
import { buildOpenApiDocument } from '../openapi/document';
import { findRepoRoot } from '../repo-root';

async function renderOpenApi(): Promise<string> {
  const app = await createApp(loadConfig({ NODE_ENV: 'test' }), { logger: false });
  const document = buildOpenApiDocument(app);
  await app.close();
  return JSON.stringify(document, null, 2) + '\n';
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const root = findRepoRoot();
  const outputs: Array<[string, string]> = [
    [join(root, 'contract', 'openapi.json'), await renderOpenApi()],
    [join(root, '.env.example'), renderEnvExample()],
  ];

  let stale = false;
  for (const [path, text] of outputs) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === text) continue;
    if (check) {
      console.error(`Out of date: ${path}. Run "pnpm generate" and commit the result.`);
      stale = true;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`Wrote ${path}`);
    }
  }
  if (stale) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
