/**
 * BoxLite runtime abstraction for AgentLite.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 * Replaces the previous container-runtime.ts (Docker-based).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'node:child_process';

import { JsBoxlite } from '@boxlite-ai/boxlite';

import { logger } from './logger.js';
import type { RuntimeConfig } from './runtime-config.js';

type BoxliteRuntime = InstanceType<typeof JsBoxlite>;

let runtime: BoxliteRuntime | null = null;
let _homeDir: string | undefined;

const ACTIVE_BOX_HEARTBEAT_MS = 5_000;
const ACTIVE_BOX_STALE_MS = 30_000;
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1000);
const PROCESS_BOOT_ID = `${process.pid}:${PROCESS_STARTED_AT_MS}`;

interface ActiveBoxRecord {
  name: string;
  pid: number;
  bootId: string;
  startedAt: string;
  updatedAt: string;
}

const activeBoxes = new Map<
  string,
  { interval: ReturnType<typeof setInterval>; recordPath: string }
>();

/** Set the BoxLite home directory. Must be called before getRuntime(). */
export function setBoxliteHome(homeDir: string): void {
  _homeDir = homeDir;
}

/** Get the BoxLite runtime singleton. */
export function getRuntime(): BoxliteRuntime {
  if (!runtime) {
    runtime = _homeDir
      ? new JsBoxlite({ homeDir: _homeDir })
      : JsBoxlite.withDefaultConfig();
  }
  return runtime;
}

function activeBoxesDir(): string {
  return path.join(
    _homeDir ?? path.join(os.tmpdir(), 'agentlite-boxlite'),
    'agentlite-active-boxes',
  );
}

function activeBoxRecordPath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(activeBoxesDir(), `${safeName}.json`);
}

function writeActiveBoxRecord(
  recordPath: string,
  record: ActiveBoxRecord,
): void {
  const recordDir = path.dirname(recordPath);
  fs.mkdirSync(recordDir, { recursive: true });
  const tmpPath = path.join(
    recordDir,
    `.${path.basename(recordPath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(
      tmpPath,
      JSON.stringify(
        { ...record, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    fs.renameSync(tmpPath, recordPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* already removed */
    }
    throw err;
  }
}

function readActiveBoxRecord(name: string): ActiveBoxRecord | null {
  try {
    const raw = fs.readFileSync(activeBoxRecordPath(name), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ActiveBoxRecord>;
    if (
      parsed.name !== name ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.bootId !== 'string' ||
      typeof parsed.updatedAt !== 'string'
    ) {
      return null;
    }
    return parsed as ActiveBoxRecord;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseBootId(
  bootId: string,
): { pid: number; startedAtMs: number } | null {
  const [pidText, startedAtText] = bootId.split(':');
  const pid = Number(pidText);
  const startedAtMs = Number(startedAtText);
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !Number.isFinite(startedAtMs) ||
    startedAtMs <= 0
  ) {
    return null;
  }
  return { pid, startedAtMs };
}

function getProcessStartedAtMs(pid: number): number | null {
  if (pid === process.pid) return PROCESS_STARTED_AT_MS;
  try {
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!startedAt) return null;
    const parsed = Date.parse(startedAt);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasMatchingBootId(record: ActiveBoxRecord): boolean {
  const boot = parseBootId(record.bootId);
  if (!boot || boot.pid !== record.pid) return false;

  const startedAtMs = getProcessStartedAtMs(record.pid);
  if (startedAtMs === null) return false;

  return Math.abs(startedAtMs - boot.startedAtMs) <= 2_000;
}

function hasLiveOwner(name: string): boolean {
  if (activeBoxes.has(name)) return true;

  const record = readActiveBoxRecord(name);
  if (!record) return false;

  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;

  const heartbeatFresh = Date.now() - updatedAt <= ACTIVE_BOX_STALE_MS;
  return heartbeatFresh && isPidAlive(record.pid) && hasMatchingBootId(record);
}

export function registerActiveBox(name: string): void {
  if (activeBoxes.has(name)) return;

  const recordPath = activeBoxRecordPath(name);
  const now = new Date().toISOString();
  const record: ActiveBoxRecord = {
    name,
    pid: process.pid,
    bootId: PROCESS_BOOT_ID,
    startedAt: now,
    updatedAt: now,
  };

  writeActiveBoxRecord(recordPath, record);
  const interval = setInterval(() => {
    try {
      writeActiveBoxRecord(recordPath, record);
    } catch (err) {
      logger.warn({ err, name }, 'Failed to update active box heartbeat');
    }
  }, ACTIVE_BOX_HEARTBEAT_MS);
  interval.unref?.();

  activeBoxes.set(name, { interval, recordPath });
}

export function unregisterActiveBox(name: string): void {
  const active = activeBoxes.get(name);
  const recordPath = active?.recordPath ?? activeBoxRecordPath(name);

  if (active) {
    clearInterval(active.interval);
    activeBoxes.delete(name);
  }
  try {
    fs.unlinkSync(recordPath);
  } catch {
    /* already removed */
  }
}

/** Ensure the BoxLite runtime is available. */
export function ensureRuntimeReady(): void {
  try {
    getRuntime();
    logger.debug('BoxLite runtime ready');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize BoxLite runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: BoxLite runtime failed to initialize                   ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without BoxLite. To fix:                    ║',
    );
    console.error(
      '║  macOS: Ensure Apple Silicon (M1+) and macOS 12+              ║',
    );
    console.error(
      '║  Linux: Ensure /dev/kvm exists and user is in kvm group       ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('BoxLite runtime is required but failed to initialize', {
      cause: err,
    });
  }
}

/** Kill orphaned AgentLite boxes from previous runs. Scoped by agent id if provided. */
export async function cleanupOrphans(
  agentId?: string,
  opts: { includeLive?: boolean } = {},
): Promise<void> {
  try {
    const rt = getRuntime();
    const boxes = await rt.listInfo();
    const prefix = agentId ? `agentlite-${agentId}-` : 'agentlite-';
    const candidates = boxes.filter(
      (b: { name?: string; state: { running: boolean } }) =>
        b.name && b.name.startsWith(prefix) && b.state.running,
    );
    const orphans = opts.includeLive
      ? candidates
      : candidates.filter(
          (box: { name?: string }) => box.name && !hasLiveOwner(box.name),
        );
    for (const box of orphans) {
      const name = (box as { name: string }).name;
      try {
        await rt.remove(name, true);
      } catch {
        /* already stopped */
      } finally {
        unregisterActiveBox(name);
      }
    }
    if (orphans.length > 0) {
      logger.info(
        {
          count: orphans.length,
          names: orphans.map((b: { name?: string }) => b.name),
        },
        'Stopped orphaned boxes',
      );
    }
    const skipped = candidates.length - orphans.length;
    if (skipped > 0) {
      logger.debug({ count: skipped, prefix }, 'Skipped live AgentLite boxes');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned boxes');
  }
}

/** Stop and remove a box by name. */
export async function stopBox(name: string): Promise<void> {
  try {
    const rt = getRuntime();
    await rt.remove(name, true);
  } catch {
    /* already stopped or doesn't exist */
  } finally {
    unregisterActiveBox(name);
  }
}

// --- Box spawning (extracted from container-runner) ---

export interface SpawnVolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface SpawnResult {
  box: any;
  execution: any;
}

interface SpawnErrorResult {
  status: 'error';
  result: null;
  error: string;
}

/**
 * Create a BoxLite VM, run the image entrypoint, and write input via stdin.
 * Returns the box + execution handles on success, or an error result.
 */
export async function spawnBox(
  groupName: string,
  containerName: string,
  mounts: SpawnVolumeMount[],
  boxEnv: Record<string, string>,
  userStr: string | undefined,
  stdinData: string,
  rtConfig: RuntimeConfig,
): Promise<SpawnResult | SpawnErrorResult> {
  const runtime = getRuntime();
  const envArray = Object.entries(boxEnv).map(([key, value]) => ({
    key,
    value,
  }));

  let box;
  try {
    // Use local OCI layout if available (from container/build.sh), else pull from registry.
    // Check for oci-layout file to distinguish a valid OCI directory from an empty one.
    const useLocalRootfs =
      rtConfig.boxRootfsPath &&
      fs.existsSync(path.join(rtConfig.boxRootfsPath, 'oci-layout'));
    box = await runtime.create(
      {
        image: useLocalRootfs ? undefined : rtConfig.boxImage,
        rootfsPath: useLocalRootfs ? rtConfig.boxRootfsPath : undefined,
        autoRemove: true,
        memoryMib: rtConfig.boxMemoryMib,
        cpus: rtConfig.boxCpus,
        volumes: mounts.map((m) => ({
          hostPath: m.hostPath,
          guestPath: m.containerPath,
          readOnly: m.readonly,
        })),
        env: envArray,
        workingDir: '/workspace/group',
        user: userStr,
        security: { networkEnabled: true },
      },
      containerName,
    );
    registerActiveBox(containerName);
  } catch (err) {
    logger.error(
      { group: groupName, containerName, error: err },
      'Box creation failed',
    );
    if (box) {
      try {
        await box.stop();
      } catch {
        /* ignore */
      }
      unregisterActiveBox(containerName);
    }
    return {
      status: 'error',
      result: null,
      error: `Box creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Run the image's /app/entrypoint.sh via box.exec — box.exec doesn't honor
  // the OCI ENTRYPOINT, so we invoke it explicitly.
  let execution;
  try {
    const timeoutSecs = Math.max(
      Math.floor(rtConfig.containerTimeout / 1000),
      Math.floor((rtConfig.idleTimeout + 30_000) / 1000),
    );

    execution = await box.exec(
      '/app/entrypoint.sh',
      [],
      null, // env already set on box creation
      false, // tty
      null, // user already set on box creation
      timeoutSecs,
      '/workspace/group',
    );
  } catch (err) {
    logger.error(
      { group: groupName, containerName, error: err },
      'Failed to start agent in box',
    );
    try {
      await box.stop();
    } catch {
      /* ignore */
    }
    unregisterActiveBox(containerName);
    return {
      status: 'error',
      result: null,
      error: `Failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Write input via stdin (same protocol as Docker's container.stdin.write)
  try {
    const stdin = await execution.stdin();
    await stdin.writeString(stdinData);
    await stdin.close();
  } catch (err) {
    logger.error(
      { group: groupName, containerName, error: err },
      'Failed to write stdin to box',
    );
    try {
      await execution.kill();
    } catch {
      /* ignore */
    }
    try {
      await box.stop();
    } catch {
      /* ignore */
    }
    unregisterActiveBox(containerName);
    return {
      status: 'error',
      result: null,
      error: `Failed to write stdin: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { box, execution };
}
