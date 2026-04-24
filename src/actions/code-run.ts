import { PassThrough } from 'stream';

import Docker from 'dockerode';
import { transform } from 'esbuild';

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
const MAX_TIMEOUT_MS = 30_000;
const SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024;

const docker = new Docker();

const imageByLanguage: Record<CodeRunInput['language'], string> = {
  javascript: 'node:20-alpine',
  typescript: 'node:20-alpine',
  python: 'python:3.11-alpine',
  bash: 'alpine:3',
};

interface PreparedCommand {
  cmd: string[];
  env: string[];
}

function wrapCommand(command: string): PreparedCommand {
  return {
    cmd: ['sh', '-c', `${command}; status=$?; sleep 0.1; exit $status`],
    env: [],
  };
}

async function commandForInput(input: CodeRunInput): Promise<PreparedCommand> {
  switch (input.language) {
    case 'javascript':
      return {
        cmd: [
          'sh',
          '-c',
          'node -e "$CODE"; status=$?; sleep 0.1; exit $status',
        ],
        env: [`CODE=${input.code}`],
      };
    case 'typescript': {
      const result = await transform(input.code, {
        loader: 'ts',
        platform: 'node',
        target: 'node20',
        format: 'cjs',
      });
      return {
        cmd: [
          'sh',
          '-c',
          'node -e "$CODE"; status=$?; sleep 0.1; exit $status',
        ],
        env: [`CODE=${result.code}`],
      };
    }
    case 'python':
      return {
        cmd: [
          'sh',
          '-c',
          'python -c "$CODE"; status=$?; sleep 0.1; exit $status',
        ],
        env: [`CODE=${input.code}`],
      };
    case 'bash':
      return {
        ...wrapCommand('sh -c "$CODE"'),
        env: [`CODE=${input.code}`],
      };
  }
}

function timeoutForInput(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(0, timeoutMs), MAX_TIMEOUT_MS);
}

function streamToString(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function waitForStreamClose(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForContainerDie(
  dockerClient: Docker,
  containerId: string,
): { promise: Promise<number>; ready: Promise<void>; close: () => void } {
  let eventStream: NodeJS.ReadableStream | undefined;
  let buffer = '';
  let settled = false;
  let markReady: () => void;

  const close = () => {
    const destroyable = eventStream as
      | (NodeJS.ReadableStream & { destroy(): void })
      | undefined;
    destroyable?.destroy();
  };

  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const promise = new Promise<number>((resolve, reject) => {
    const finish = (exitCode: number) => {
      if (!settled) {
        settled = true;
        close();
        resolve(exitCode);
      }
    };

    dockerClient
      .getEvents({
        filters: {
          type: ['container'],
          event: ['die'],
          container: [containerId],
        },
      })
      .then((stream) => {
        eventStream = stream;
        markReady();
        stream.on('data', (chunk: Buffer | string) => {
          buffer += chunk.toString();
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) {
              const event = JSON.parse(line) as {
                id?: string;
                Actor?: { Attributes?: { exitCode?: string } };
              };
              if (event.id === containerId) {
                finish(Number(event.Actor?.Attributes?.exitCode ?? 0));
              }
            }
            newlineIndex = buffer.indexOf('\n');
          }
        });
        stream.on('error', (err) => {
          if (!settled) reject(err);
        });
      })
      .catch((err: unknown) => {
        markReady();
        if (!settled) reject(err);
      });
  });

  return { promise, ready, close };
}

async function tryKill(container: Docker.Container): Promise<void> {
  try {
    await container.kill();
  } catch (err) {
    const dockerErr = err as { statusCode?: number; reason?: string };
    if (dockerErr.statusCode !== 304 && dockerErr.statusCode !== 404) {
      throw err;
    }
  }
}

export async function runCode(input: CodeRunInput): Promise<CodeRunOutput> {
  const startedAt = Date.now();
  const timeoutMs = timeoutForInput(input.timeout_ms);
  const image = imageByLanguage[input.language];
  const command = await commandForInput(input);

  const container = await (docker.createContainer({
    Image: image,
    Cmd: command.cmd,
    Env: command.env,
    WorkingDir: '/sandbox',
    NetworkDisabled: true,
    HostConfig: {
      Memory: SANDBOX_MEMORY_BYTES,
      MemorySwap: SANDBOX_MEMORY_BYTES,
      PidsLimit: 50,
      ReadonlyRootfs: true,
      Tmpfs: { '/sandbox': 'size=64m,exec' },
      NetworkMode: 'none',
      AutoRemove: true,
      SecurityOpt: ['no-new-privileges'],
    },
  }) as Promise<Docker.Container>);

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutText = streamToString(stdout);
  const stderrText = streamToString(stderr);

  const logStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });
  const logStreamClosed = waitForStreamClose(logStream);
  const dieEvent = waitForContainerDie(docker, container.id);
  docker.modem.demuxStream(logStream, stdout, stderr);

  let timeoutHandle: NodeJS.Timeout | undefined;
  let didTimeout = false;

  await dieEvent.ready;
  await container.start();

  const waitForExit = container
    .wait()
    .then((result: { StatusCode?: number }) => result.StatusCode ?? 0)
    .catch(async (err: unknown) => {
      const dockerErr = err as { statusCode?: number };
      if (dockerErr.statusCode === 404) {
        return dieEvent.promise;
      }
      throw err;
    });

  const timeout = new Promise<number>((resolve) => {
    timeoutHandle = setTimeout(() => {
      didTimeout = true;
      void tryKill(container).finally(() => resolve(124));
    }, timeoutMs);
  });

  const exitCode = await Promise.race([waitForExit, dieEvent.promise, timeout]);
  dieEvent.close();
  if (timeoutHandle) clearTimeout(timeoutHandle);

  await Promise.race([logStreamClosed, delay(100)]);
  (logStream as NodeJS.ReadWriteStream & { destroy(): void }).destroy();
  stdout.end();
  stderr.end();

  const [out, err] = await Promise.all([stdoutText, stderrText]);
  return {
    stdout: out,
    stderr: didTimeout
      ? err
        ? `${err}\nExecution timed out`
        : 'Execution timed out'
      : err,
    exit_code: didTimeout ? 124 : exitCode,
    duration_ms: Date.now() - startedAt,
  };
}
