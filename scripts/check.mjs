// `pnpm check`: format, lint, typecheck, unit tests with coverage and build, as before, but side
// by side instead of one after another. Formatting and linting read every file and take no
// part in Turborepo's graph, so they run beside it; Turborepo runs typecheck, tests and build
// in one graph, so each package starts as soon as what it needs is ready. Each line is
// prefixed with its check; the end lists each check's result and time. Fails if any failed.
import { spawn } from 'node:child_process';

/** @type {{ name: string; args: string[] }[]} */
const checks = [
  { name: 'format', args: ['format:check'] },
  { name: 'lint', args: ['lint'] },
  { name: 'turbo', args: ['exec', 'turbo', 'run', 'typecheck', 'test:coverage', 'build'] },
];

/**
 * Runs one check, its output prefixed with its name.
 * @param {{ name: string; args: string[] }} check
 * @returns {Promise<{ name: string; ok: boolean; seconds: number }>}
 */
function run({ name, args }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (/** @type {string} */ chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) process.stdout.write(`[${name}] ${line}\n`);
      });
      stream.on('end', () => {
        if (rest !== '') process.stdout.write(`[${name}] ${rest}\n`);
      });
    }
    child.on('close', (code) => {
      resolve({ name, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

const results = await Promise.all(checks.map(run));
process.stdout.write('\n');
for (const { name, ok, seconds } of results) {
  process.stdout.write(`${ok ? 'passed' : 'FAILED'}  ${name} (${String(seconds)} s)\n`);
}
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
