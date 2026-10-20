import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma commands run from apps/api; settings come from the repository-root .env.
const rootEnv = join(process.cwd(), '..', '..', '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Same default as DATABASE_URL in src/config/params.ts (matches docker-compose.yml).
    url: process.env.DATABASE_URL ?? 'postgresql://bookie:bookie@localhost:5432/bookie',
  },
});
