import { Writable } from 'stream';

import Docker from 'dockerode';
import { transformSync } from 'esbuild';
import { z } from 'zod';

export const SANDBOX_IMAGES = [
  'node:20-alpine',
  'python:3.11-alpine',
  'alpine:3',
] as const;

export interface CodeRunInput {
  language: 'javascript' | 'typescript' | 'python' | 'bash';
  code: string;
  timeout_ms?: number;
}

export interface CodeRunOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 30_000;
const TIMEOUT_EXIT_CODE = 124;

export const codeRunInputSchema = {
  language: z.enum(['javascript', 'typescript', 'python', 'bash']),
  code: z.string(),
  timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
};

const docker = new Docker();
const imagePromises = new Map<string, Promise<void>>();

export async function prePullSandboxImages(): Promise<void> {
  await Promise.all(SANDBOX_IMAGES.map((image) => ensureImage(image)));
}

export async function codeRun(input: CodeRunInput): Promise<CodeRunOutput> {
  const timeoutMs = normalizeTimeout(input.timeout_ms);
  const image = imageForLanguage(input.language);
  const cmd = commandForLanguage(input.language, input.code);
  const startedAt = Date.now();
  await ensureImage(image);
  const containerOptions: Docker.ContainerCreateOptions = {
    Image: image,
    Cmd: cmd,
    NetworkDisabled: true,
    WorkingDir: '/sandbox',
    HostConfig: {
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      PidsLimit: 50,
      Tmpfs: { '/sandbox': 'size=64m,exec' },
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      AutoRemove: true,
      SecurityOpt: ['no-new-privileges'],
    },
  };
  const container: Docker.Container =
    await docker.createContainer(containerOptions);

  let timedOut = false;
  const output = collectContainerOutput(container);
  const execution = (async (): Promise<CodeRunOutput> => {
    const wait = container.wait({ condition: 'next-exit' });
    await container.start();
    const waitResult = await wait;
    const collected = await output;
    return {
      stdout: collected.stdout,
      stderr: collected.stderr,
      exit_code: waitResult.StatusCode,
      duration_ms: Date.now() - startedAt,
    };
  })();

  const timeout = new Promise<CodeRunOutput>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      void killAndRemove(container);
      resolve({
        stdout: '',
        stderr: 'Execution timed out',
        exit_code: TIMEOUT_EXIT_CODE,
        duration_ms: Date.now() - startedAt,
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([execution, timeout]);
  } finally {
    if (!timedOut) {
      execution.catch(() => undefined);
    }
  }
}

export const runCode = codeRun;

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(timeoutMs), 1), MAX_TIMEOUT_MS);
}

function imageForLanguage(language: CodeRunInput['language']): string {
  switch (language) {
    case 'javascript':
    case 'typescript':
      return 'node:20-alpine';
    case 'python':
      return 'python:3.11-alpine';
    case 'bash':
      return 'alpine:3';
  }
}

function commandForLanguage(
  language: CodeRunInput['language'],
  code: string,
): string[] {
  switch (language) {
    case 'javascript':
      return ['node', '-e', code];
    case 'typescript': {
      const result = transformSync(code, {
        loader: 'ts',
        format: 'cjs',
        target: 'node20',
      });
      return ['node', '-e', result.code];
    }
    case 'python':
      return ['python', '-c', code];
    case 'bash':
      return ['sh', '-c', code];
  }
}

async function collectContainerOutput(
  container: Docker.Container,
): Promise<{ stdout: string; stderr: string }> {
  const stream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  docker.modem.demuxStream(stream, stdout, stderr);
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.once('end', () => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function killAndRemove(container: Docker.Container): Promise<void> {
  try {
    await container.kill();
  } catch {
    /* Container may have already exited. */
  }
  try {
    await container.remove({ force: true });
  } catch {
    /* AutoRemove may have already removed it. */
  }
}

async function pullImage(image: string): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function ensureImage(image: string): Promise<void> {
  if (!imagePromises.has(image)) {
    imagePromises.set(
      image,
      docker
        .getImage(image)
        .inspect()
        .then(() => undefined)
        .catch(() => pullImage(image)),
    );
  }
  await imagePromises.get(image);
}
