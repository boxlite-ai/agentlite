import { spawnSync } from 'node:child_process';

const args = [];
const rawArgs = process.argv.slice(2);
const npmTestPathPattern = process.env.npm_config_testpathpattern;

if (
  npmTestPathPattern &&
  !rawArgs.some(
    (arg) =>
      arg === '--testPathPattern' || arg?.startsWith('--testPathPattern='),
  )
) {
  args.push(npmTestPathPattern);
}

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--testPathPattern') {
    const pattern = rawArgs[i + 1];
    if (pattern) {
      args.push(pattern);
      i += 1;
    }
    continue;
  }
  if (arg?.startsWith('--testPathPattern=')) {
    const pattern = arg.slice('--testPathPattern='.length);
    if (pattern) args.push(pattern);
    continue;
  }
  args.push(arg);
}

const result = spawnSync('vitest', ['run', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
