import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../repo-root';
import { CONTRACT_ENUMS } from './enums';
import { ERROR_CODES } from './error-codes';

/**
 * Keeps the code and docs/CONTRACT.md in step: a change to either one
 * without the other fails here (CLAUDE.md: contract changes go in both).
 */
const contract = readFileSync(join(findRepoRoot(), 'docs', 'CONTRACT.md'), 'utf8');

function section(heading: string): string {
  const start = contract.indexOf(heading);
  if (start < 0) throw new Error(`Heading not found in CONTRACT.md: ${heading}`);
  const next = contract.indexOf('\n## ', start + heading.length);
  return contract.slice(start, next < 0 ? undefined : next);
}

/** Table rows as arrays of cells, skipping the header and divider rows. */
function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

describe('CONTRACT.md section 3: shared enums', () => {
  const documented: Record<string, string[]> = {};
  for (const [names, values] of tableRows(section('## 3. Shared enums'))) {
    const nameParts = (names ?? '').split(' / ');
    const valueParts = (values ?? '').split(' / ');
    nameParts.forEach((name, i) => {
      documented[ticks(name)[0] ?? name] = ticks(valueParts[i] ?? '');
    });
  }

  it('documents exactly the enums the code defines', () => {
    expect(Object.keys(documented).sort()).toEqual(Object.keys(CONTRACT_ENUMS).sort());
  });

  it.each(Object.entries(CONTRACT_ENUMS))('%s has the same values', (name, values) => {
    expect(documented[name]).toEqual([...values]);
  });
});

describe('CONTRACT.md section 2: error codes', () => {
  const documented: Record<string, number> = {};
  for (const [codes, statuses] of tableRows(section('### Error format'))) {
    const codeList = ticks(codes ?? '');
    const statusList = (statuses ?? '').split(',').map((s) => Number(s.trim()));
    codeList.forEach((code, i) => {
      documented[code] = statusList[i] ?? statusList[0] ?? NaN;
    });
  }

  it('documents exactly the codes the code defines, with the same HTTP status', () => {
    expect(documented).toEqual({ ...ERROR_CODES });
  });
});
