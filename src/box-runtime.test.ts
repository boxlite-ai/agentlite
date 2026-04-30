import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRuntime } = vi.hoisted(() => ({
  mockRuntime: {
    create: vi.fn(),
    listInfo: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@boxlite-ai/boxlite', () => ({
  JsBoxlite: class {
    create = mockRuntime.create;
    listInfo = mockRuntime.listInfo;
    remove = mockRuntime.remove;

    static withDefaultConfig() {
      return new this();
    }
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  cleanupOrphans,
  registerActiveBox,
  setBoxliteHome,
  spawnBox,
  unregisterActiveBox,
} from './box-runtime.js';
import type { RuntimeConfig } from './runtime-config.js';

const testRuntimeConfig: RuntimeConfig = {
  packageRoot: '/tmp/agentlite-test-package',
  workdir: '/tmp/agentlite-test',
  boxImage: 'agentlite-agent:latest',
  boxRootfsPath: '',
  boxMemoryMib: 2048,
  boxCpus: 2,
  maxConcurrentContainers: 5,
  containerTimeout: 1800000,
  containerMaxOutputSize: 10485760,
  idleTimeout: 1800000,
  onecliUrl: 'http://localhost:10254',
  timezone: 'America/Los_Angeles',
  pollInterval: 2000,
  schedulerPollInterval: 60000,
  ipcPollInterval: 1000,
};

function activeRecordPath(tmpDir: string, name: string): string {
  return path.join(tmpDir, 'agentlite-active-boxes', `${name}.json`);
}

function currentProcessBootId(): string {
  return `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;
}

describe('cleanupOrphans', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-box-runtime-'));
    setBoxliteHome(tmpDir);
    mockRuntime.create.mockReset();
    mockRuntime.listInfo.mockReset();
    mockRuntime.remove.mockReset();
  });

  afterEach(() => {
    unregisterActiveBox('agentlite-agent1-main-live');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not force-remove a running box owned by this live process', async () => {
    registerActiveBox('agentlite-agent1-main-live');
    mockRuntime.listInfo.mockResolvedValue([
      {
        name: 'agentlite-agent1-main-live',
        state: { running: true },
      },
      {
        name: 'agentlite-agent1-main-stale',
        state: { running: true },
      },
    ]);

    await cleanupOrphans('agent1');

    expect(mockRuntime.remove).toHaveBeenCalledTimes(1);
    expect(mockRuntime.remove).toHaveBeenCalledWith(
      'agentlite-agent1-main-stale',
      true,
    );
  });

  it('does not force-remove a running box with a matching owner boot id', async () => {
    const boxName = 'agentlite-agent1-main-cross-process';
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(tmpDir, 'agentlite-active-boxes'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, 'agentlite-active-boxes', `${boxName}.json`),
      JSON.stringify({
        name: boxName,
        pid: process.pid,
        bootId: currentProcessBootId(),
        startedAt: now,
        updatedAt: now,
      }),
    );
    mockRuntime.listInfo.mockResolvedValue([
      {
        name: boxName,
        state: { running: true },
      },
    ]);

    await cleanupOrphans('agent1');

    expect(mockRuntime.remove).not.toHaveBeenCalled();
  });

  it('force-removes a fresh heartbeat when the boot id is stale', async () => {
    const boxName = 'agentlite-agent1-main-reused-pid';
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(tmpDir, 'agentlite-active-boxes'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, 'agentlite-active-boxes', `${boxName}.json`),
      JSON.stringify({
        name: boxName,
        pid: process.pid,
        bootId: `${process.pid}:1`,
        startedAt: now,
        updatedAt: now,
      }),
    );
    mockRuntime.listInfo.mockResolvedValue([
      {
        name: boxName,
        state: { running: true },
      },
    ]);

    await cleanupOrphans('agent1');

    expect(mockRuntime.remove).toHaveBeenCalledWith(boxName, true);
  });

  it('force-removes running boxes when explicitly requested', async () => {
    registerActiveBox('agentlite-agent1-main-live');
    mockRuntime.listInfo.mockResolvedValue([
      {
        name: 'agentlite-agent1-main-live',
        state: { running: true },
      },
    ]);

    await cleanupOrphans('agent1', { includeLive: true });

    expect(mockRuntime.remove).toHaveBeenCalledWith(
      'agentlite-agent1-main-live',
      true,
    );
  });

  it('clears the active heartbeat even when remove races with exit', async () => {
    const boxName = 'agentlite-agent1-main-live';
    registerActiveBox(boxName);
    mockRuntime.listInfo.mockResolvedValue([
      {
        name: boxName,
        state: { running: true },
      },
    ]);
    mockRuntime.remove.mockRejectedValue(new Error('already stopped'));

    await cleanupOrphans('agent1', { includeLive: true });

    expect(mockRuntime.remove).toHaveBeenCalledWith(boxName, true);
    expect(fs.existsSync(activeRecordPath(tmpDir, boxName))).toBe(false);
  });
});

describe('spawnBox active heartbeat', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-box-runtime-'));
    setBoxliteHome(tmpDir);
    mockRuntime.create.mockReset();
  });

  afterEach(() => {
    unregisterActiveBox('agentlite-agent1-main-live');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers the active box immediately after creation', async () => {
    const boxName = 'agentlite-agent1-main-live';
    let recordExistsDuringExec = false;
    const stdin = {
      writeString: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const execution = {
      stdin: vi.fn().mockResolvedValue(stdin),
    };
    const box = {
      exec: vi.fn().mockImplementation(async () => {
        recordExistsDuringExec = fs.existsSync(
          activeRecordPath(tmpDir, boxName),
        );
        return execution;
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    mockRuntime.create.mockResolvedValue(box);

    const result = await spawnBox(
      'Main',
      boxName,
      [],
      {},
      undefined,
      '{}',
      testRuntimeConfig,
    );

    expect('status' in result).toBe(false);
    expect(recordExistsDuringExec).toBe(true);
  });

  it('publishes active heartbeat records with an atomic rename', () => {
    const boxName = 'agentlite-agent1-main-live';
    const recordPath = activeRecordPath(tmpDir, boxName);
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');

    try {
      registerActiveBox(boxName);

      expect(writeSpy).not.toHaveBeenCalledWith(recordPath, expect.any(String));
      expect(renameSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\.tmp$/),
        recordPath,
      );
      expect(fs.existsSync(recordPath)).toBe(true);
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('clears the active heartbeat when exec setup fails', async () => {
    const boxName = 'agentlite-agent1-main-live';
    const box = {
      exec: vi.fn().mockRejectedValue(new Error('exec failed')),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    mockRuntime.create.mockResolvedValue(box);

    const result = await spawnBox(
      'Main',
      boxName,
      [],
      {},
      undefined,
      '{}',
      testRuntimeConfig,
    );

    expect(result).toMatchObject({ status: 'error' });
    expect(box.stop).toHaveBeenCalled();
    expect(fs.existsSync(activeRecordPath(tmpDir, boxName))).toBe(false);
  });
});
