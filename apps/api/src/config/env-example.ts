import { PARAMS } from './params';

const HEADER = `# Bookie environment settings.
# Generated from apps/api/src/config/params.ts: run \`pnpm generate\` from the repository root.
# Copy to .env and fill in the secrets. Never commit .env.
# Numbers marked "hypothesis" are defaults to be measured, not facts (spec parameter rule).
`;

const COMPOSE_SECTION = `
# --- Docker Compose (local services only) ---
POSTGRES_USER=bookie
POSTGRES_PASSWORD=bookie
POSTGRES_DB=bookie
POSTGRES_PORT=5432
REDIS_PORT=6379
MAILPIT_UI_PORT=8025
`;

function defaultValue(schema: (typeof PARAMS)[keyof typeof PARAMS]['schema']): string {
  const parsed = schema.safeParse(undefined);
  if (!parsed.success || parsed.data === undefined) return '';
  return String(parsed.data);
}

/** Builds the .env.example text from the parameter list. */
export function renderEnvExample(): string {
  const lines: string[] = [HEADER];
  for (const [key, def] of Object.entries(PARAMS)) {
    const value = 'secret' in def && def.secret ? '' : defaultValue(def.schema);
    lines.push(`# ${def.description} [${def.source}]`);
    lines.push(`${key}=${value}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n' + COMPOSE_SECTION;
}
