import Docker from 'dockerode';

export const SANDBOX_IMAGES = [
  'node:20-alpine',
  'python:3.11-alpine',
  'alpine:3',
] as const;

let pullPromise: Promise<void> | null = null;

export async function pullImage(
  docker: Docker,
  image: (typeof SANDBOX_IMAGES)[number],
): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function prePullSandboxImages(): Promise<void> {
  if (!pullPromise) {
    const docker = new Docker();
    pullPromise = Promise.all(
      SANDBOX_IMAGES.map((img) => pullImage(docker, img)),
    ).then(() => undefined);
  }
  return pullPromise;
}

export function startSandboxImagePrepull(): void {
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID) {
    return;
  }
  prePullSandboxImages().catch(console.error);
}
