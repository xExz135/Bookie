import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from './test-database';

/** Drops and recreates the test database, then applies every migration. */
export default async function globalSetup(): Promise<void> {
  const target = new URL(TEST_DATABASE_URL);
  const dbName = target.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": the test database name must end in _test.`);
  }

  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach PostgreSQL for the database tests (${target.host}). ` +
        `Start it with "docker compose up -d". Cause: ${(error as Error).message}`,
    );
  }
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }

  execSync('pnpm exec prisma migrate deploy', {
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
