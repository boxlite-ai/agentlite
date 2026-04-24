import Docker from 'dockerode';
import { beforeAll, describe, expect, it } from 'vitest';

import { runCode } from './code-run.js';
import { prePullSandboxImages } from './sandbox-images.js';

const docker = new Docker();

async function dockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

describe('code_run action', () => {
  beforeAll(async () => {
    if (!(await dockerAvailable())) {
      throw new Error('Docker is required for code_run tests');
    }
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

  it.skipIf(process.env.CI === 'true' || process.platform === 'darwin')(
    'runs TypeScript',
    async () => {
      const result = await runCode({
        language: 'typescript',
        code: "const msg: string = 'hello ts'; console.log(msg)",
      });

      expect(result.stdout).toBe('hello ts\n');
      expect(result.stderr).toBe('');
      expect(result.exit_code).toBe(0);
    },
  );

  it('times out long-running code', async () => {
    const result = await runCode({
      language: 'python',
      code: 'while True: pass',
      timeout_ms: 1000,
    });

    expect(result.exit_code).toBe(124);
    expect(result.stderr).toContain('Execution timed out');
  });

  it.skipIf(process.env.CI === 'true' || process.platform === 'darwin')(
    'enforces the memory limit',
    async () => {
      const result = await runCode({
        language: 'python',
        code: 'x = bytearray(1024 * 1024 * 1024); print(len(x))',
      });

      expect(result.exit_code).not.toBe(0);
    },
  );

  it('blocks network access', async () => {
    const result = await runCode({
      language: 'bash',
      code: 'wget -qO- -T 1 http://1.1.1.1',
      timeout_ms: 2000,
    });

    expect(result.exit_code).not.toBe(0);
  });
});
