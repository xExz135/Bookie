// Runs the offline evaluation harness with the Python in eval/.venv (BE-14).
//   pnpm eval:setup          create eval/.venv and install eval/requirements.txt
//   pnpm eval [extract|run]  python -m bookie_eval (see eval/README.md)
//   pnpm eval:test           the harness tests
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const venv = join(here, '.venv');
const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');

function run(exe, args) {
  const result = spawnSync(exe, args, { cwd: here, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

let status;
if (command === 'setup') {
  const system = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  status = existsSync(python) ? 0 : run(system, ['-m', 'venv', venv]);
  if (status === 0) status = run(python, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt']);
} else if (!existsSync(python)) {
  console.error('No eval/.venv yet. Run `pnpm eval:setup` first.');
  status = 1;
} else if (command === 'test') {
  status = run(python, ['-m', 'pytest', '-q', ...rest]);
} else {
  status = run(python, ['-m', 'bookie_eval', ...(command ? [command] : []), ...rest]);
}
process.exit(status);
