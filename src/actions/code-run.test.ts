import Docker from 'dockerode';
import { beforeAll, describe, expect, it } from 'vitest';

import { prePullSandboxImages, runCode } from './code-run.js';

async function dockerIsAvailable(): Promise<boolean> {
  try {
    await new Docker().ping();
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await dockerIsAvailable();
const runIfDocker = dockerAvailable ? describe : describe.skip;

runIfDocker('code_run', () => {
  beforeAll(async () => {
    await prePullSandboxImages();
  }, 120_000);

  it('runs JavaScript', async () => {
    const result = await runCode({
      language: 'javascript',
      code: "console.log('hello')",
    });

    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('');
    expect(result.exit_code).toBe(0);
  });

  it('runs Python', async () => {
    const result = await runCode({
      language: 'python',
      code: "print('world')",
    });

    expect(result.stdout).toBe('world\n');
    expect(result.stderr).toBe('');
    expect(result.exit_code).toBe(0);
  });

  it('runs Bash', async () => {
    const result = await runCode({
      language: 'bash',
      code: 'echo test',
    });

    expect(result.stdout).toBe('test\n');
    expect(result.stderr).toBe('');
    expect(result.exit_code).toBe(0);
  });

  it('times out long-running code', async () => {
    const result = await runCode({
      language: 'python',
      code: 'while True: pass',
      timeout_ms: 1000,
    });

    expect(result.exit_code).toBe(124);
    expect(result.stderr).toBe('Execution timed out');
  }, 10_000);

  it('enforces the memory limit', async () => {
    const result = await runCode({
      language: 'python',
      code: 'data = bytearray(300 * 1024 * 1024)\nprint(len(data))',
    });

    expect(result.exit_code).not.toBe(0);
  }, 10_000);

  it('blocks network access', async () => {
    const result = await runCode({
      language: 'bash',
      code: 'wget -T 1 -qO- https://example.com',
      timeout_ms: 3000,
    });

    expect(result.exit_code).not.toBe(0);
  }, 10_000);
});
