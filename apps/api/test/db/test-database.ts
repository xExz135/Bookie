/**
 * Database tests run against a separate database, rebuilt from the
 * migrations at the start of every test run (see global-setup.ts).
 * Needs PostgreSQL running: `docker compose up -d`.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://bookie:bookie@localhost:5432/bookie_test';
