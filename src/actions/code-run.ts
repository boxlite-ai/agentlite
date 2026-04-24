import { Writable } from 'stream';

import Docker from 'dockerode';
import { transform } from 'esbuild';
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
const MEMORY_BYTES = 256 * 1024 * 1024;

export const codeRunInputSchema = {
  language: z.enum(['javascript', 'typescript', 'python', 'bash']),
  code: z.string(),
  timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
};

const docker = new Docker();
const pullPromises = new Map<string, Promise<void>>();

export function prePullSandboxImages(): Promise<void> {
  return Promise.all(SANDBOX_IMAGES.map((image) => ensureImage(image))).then(
    () => undefined,
  );
}

export function prePullCodeRunImages(): void {
  void prePullSandboxImages().catch(() => undefined);
}

export async function codeRun(input: CodeRunInput): Promise<CodeRunOutput> {
  const parsed = z.object(codeRunInputSchema).parse(input);
  const timeoutMs = normalizeTimeout(parsed.timeout_ms);
  const image = imageForLanguage(parsed.language);
  const cmd = await commandForLanguage(parsed.language, parsed.code);
  const startedAt = Date.now();

  await ensureImage(image);

  const containerOptions = {
    Image: image,
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    NetworkDisabled: true,
    ReadonlyRootfs: true,
    WorkingDir: '/sandbox',
    HostConfig: {
      Memory: MEMORY_BYTES,
      MemorySwap: MEMORY_BYTES,
      PidsLimit: 50,
      Tmpfs: { '/sandbox': 'size=64m,exec' },
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      AutoRemove: true,
      SecurityOpt: ['no-new-privileges'],
    },
  } as Docker.ContainerCreateOptions & { ReadonlyRootfs: boolean };
  const container = await docker.createContainer(containerOptions);

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

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CodeRunOutput>((resolve) => {
    timer = setTimeout(() => {
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
    if (timer) clearTimeout(timer);
    execution.catch(() => undefined);
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

async function commandForLanguage(
  language: CodeRunInput['language'],
  code: string,
): Promise<string[]> {
  switch (language) {
    case 'javascript':
      return ['node', '-e', code];
    case 'typescript': {
      const result = await transform(code, {
        loader: 'ts',
        format: 'cjs',
        platform: 'node',
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

async function ensureImage(image: string): Promise<void> {
  const existing = pullPromises.get(image);
  if (existing) return existing;

  const pullPromise = docker
    .getImage(image)
    .inspect()
    .then(() => undefined)
    .catch(() => pullImage(image));
  pullPromises.set(image, pullPromise);
  return pullPromise;
}

async function pullImage(image: string): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
