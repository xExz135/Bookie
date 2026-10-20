import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Finds the monorepo root (the folder holding pnpm-workspace.yaml). */
export function findRepoRoot(start: string = __dirname): string {
  let dir = start;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error('Could not find the repository root (pnpm-workspace.yaml).');
    dir = parent;
  }
  return dir;
}
