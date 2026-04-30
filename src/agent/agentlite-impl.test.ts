import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../box-runtime.js', () => ({
  setBoxliteHome: vi.fn(),
  ensureRuntimeReady: vi.fn(),
  cleanupOrphans: vi.fn().mockResolvedValue(undefined),
  spawnBox: vi.fn(),
}));

import { AgentImpl } from './agent-impl.js';
import { createAgentLiteImpl } from './agentlite-impl.js';
import { getAgentRegistryDbPath, initAgentRegistryDb } from './registry-db.js';
import { cleanupOrphans } from '../box-runtime.js';
import { _initTestDatabase } from '../db.js';
import type { AgentLite, AgentOptions } from '../api/sdk.js';
import type { MountAllowlist } from '../types.js';

const allowlist: MountAllowlist = {
  allowedRoots: [{ path: '~/projects', allowReadWrite: true }],
  blockedPatterns: ['**/.ssh/**'],
  nonMainReadOnly: true,
};

let tmpDir: string;
const platforms: AgentLite[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-platform-'));
});

afterEach(async () => {
  while (platforms.length > 0) {
    await platforms.pop()!.stop();
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('AgentLite platform registry', () => {
  it('creates the shared registry at workdir/store/agentlite.db and persists new agents', async () => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    expect(fs.existsSync(getAgentRegistryDbPath(tmpDir))).toBe(true);

    const agent = platform.createAgent('alice', {
      name: 'Alice',
      backend: { type: 'codex', model: 'gpt-5.4' },
      mountAllowlist: allowlist,
    });

    const registry = initAgentRegistryDb(tmpDir);
    try {
      const row = registry.getAgent('alice');
      expect(row).toBeDefined();
      expect(row!.agentId).toBe(agent.id);
      expect(row!.assistantName).toBe('Alice');
      expect(row!.backend).toEqual({ type: 'codex', model: 'gpt-5.4' });
      expect(row!.workDir).toBe(path.join(tmpDir, 'agents', 'alice'));
      expect(row!.mountAllowlist).toEqual(allowlist);
    } finally {
      registry.close();
    }
  });

  it('restores persisted agents on startup without backfilling existing directories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'agents', 'ghost'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'agents', 'ghost', '.agent-id'),
      'ghost000\n',
      'utf8',
    );

    const firstPlatform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(firstPlatform);

    const created = firstPlatform.createAgent('alice', {
      name: 'Alice',
      backend: { type: 'codex' },
      workdir: path.join(tmpDir, 'custom-agents', 'alice'),
      mountAllowlist: allowlist,
    });
    await firstPlatform.stop();

    const secondPlatform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(secondPlatform);

    expect(secondPlatform.agents.has('ghost')).toBe(false);
    expect(secondPlatform.agents.has('alice')).toBe(true);

    const restored = secondPlatform.agents.get('alice') as AgentImpl;
    expect(restored.id).toBe(created.id);
    expect(restored.config.assistantName).toBe('Alice');
    expect(restored.config.backend.type).toBe('codex');
    expect(restored.config.workDir).toBe(
      path.join(tmpDir, 'custom-agents', 'alice'),
    );
    expect(restored.config.mountAllowlist).toEqual(allowlist);
    expect((restored as unknown as { _started: boolean })._started).toBe(false);
  });

  it('migrates registry rows created before backend_model existed', async () => {
    const registryPath = getAgentRegistryDbPath(tmpDir);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const raw = new Database(registryPath);
    raw.exec(`
      CREATE TABLE agents (
        name TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        workdir TEXT NOT NULL,
        assistant_name TEXT NOT NULL,
        backend_type TEXT NOT NULL DEFAULT 'claudeCode',
        mount_allowlist_json TEXT,
        instructions TEXT,
        skills_sources_json TEXT,
        mcp_servers_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agents (
        name,
        agent_id,
        workdir,
        assistant_name,
        backend_type,
        mount_allowlist_json,
        instructions,
        skills_sources_json,
        mcp_servers_json,
        created_at,
        updated_at
      ) VALUES (
        'legacy',
        'legacy01',
        '${path.join(tmpDir, 'legacy-agent').replaceAll("'", "''")}',
        'Legacy',
        'codex',
        NULL,
        NULL,
        NULL,
        NULL,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      );
    `);
    raw.close();

    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    const restored = platform.agents.get('legacy') as AgentImpl | undefined;
    expect(restored).toBeDefined();
    expect(restored!.getBackend()).toEqual({ type: 'codex' });

    const registry = initAgentRegistryDb(tmpDir);
    try {
      expect(registry.getAgent('legacy')!.backend).toEqual({ type: 'codex' });
    } finally {
      registry.close();
    }
  });

  it('getOrCreateAgent merges runtime-only options and rejects conflicting serializable options', async () => {
    const firstPlatform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(firstPlatform);
    firstPlatform.createAgent('alice', { name: 'Alice' });
    await firstPlatform.stop();

    const secondPlatform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(secondPlatform);

    const credentials = vi.fn(async () => ({ TOKEN: 'secret' }));
    const channelFactory = vi.fn(async () => {
      throw new Error('channel factory should not run before start');
    });
    const acpPeer = {
      name: 'codex',
      command: 'echo',
      args: ['noop'],
    };

    const restored = secondPlatform.getOrCreateAgent('alice', {
      acp: { peers: [acpPeer] },
      channels: { mock: channelFactory },
      credentials,
    });

    const runtimeOptions = (restored as unknown as { _options: AgentOptions })
      ._options;
    expect(runtimeOptions.acp?.peers).toEqual([acpPeer]);
    expect(runtimeOptions.credentials).toBe(credentials);
    expect(runtimeOptions.channels?.mock).toBe(channelFactory);

    expect(() =>
      secondPlatform.getOrCreateAgent('alice', { name: 'Bob' }),
    ).toThrow('assistant name');
    expect(() =>
      secondPlatform.getOrCreateAgent('alice', {
        workdir: path.join(tmpDir, 'other'),
      }),
    ).toThrow('workdir');
    expect(() =>
      secondPlatform.getOrCreateAgent('alice', { backend: { type: 'codex' } }),
    ).toThrow('backend');
  });

  it('rejects conflicting creation-time backend models', async () => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    platform.createAgent('alice', {
      backend: { type: 'claudeCode', model: 'claude-sonnet-4-6' },
    });

    expect(() =>
      platform.getOrCreateAgent('alice', {
        backend: { type: 'claudeCode', model: 'claude-opus-4-6' },
      }),
    ).toThrow('backend');
    expect(() =>
      platform.getOrCreateAgent('alice', {
        backend: { type: 'claudeCode', model: ' claude-sonnet-4-6 ' },
      }),
    ).not.toThrow();
  });

  it('setBackend persists changes and marks backend switches for handoff', async () => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    const agent = platform.createAgent('alice') as AgentImpl;
    agent.db = _initTestDatabase();
    agent.registeredGroups['self-chat'] = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: new Date().toISOString(),
      isMain: true,
    };
    agent.sessions.main = 'old-codex-thread';
    agent.db.setSession('main', 'old-codex-thread', 'codex');
    const closeSpy = vi.spyOn(agent.queue, 'closeStdin');
    (agent as unknown as { _started: boolean })._started = true;

    expect(agent.backendRevision).toBe(0);
    const result = await agent.setBackend({
      type: 'codex',
      model: 'gpt-5.4',
    });

    expect(result).toMatchObject({
      previous: { type: 'claudeCode' },
      current: { type: 'codex', model: 'gpt-5.4' },
      applies: 'nextTurn',
      handoff: 'pending',
    });
    expect(agent.getBackend()).toEqual({ type: 'codex', model: 'gpt-5.4' });
    expect(agent.sessions.main).toBeUndefined();
    expect(agent.db.getSession('main', 'codex')).toBeUndefined();
    expect(agent.db.getBackendHandoff('main', 'codex')).toMatchObject({
      fromBackendType: 'claudeCode',
      toBackendType: 'codex',
    });
    expect(closeSpy).toHaveBeenCalledWith('self-chat');
    expect(agent.backendRevision).toBe(1);

    const registry = initAgentRegistryDb(tmpDir);
    try {
      expect(registry.getAgent('alice')!.backend).toEqual({
        type: 'codex',
        model: 'gpt-5.4',
      });
    } finally {
      registry.close();
    }
  });

  it('same-backend model changes do not create handoff state', async () => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    const agent = platform.createAgent('alice') as AgentImpl;
    agent.db = _initTestDatabase();
    agent.registeredGroups['self-chat'] = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: new Date().toISOString(),
      isMain: true,
    };
    (agent as unknown as { _started: boolean })._started = true;

    expect(agent.backendRevision).toBe(0);
    const result = await agent.setBackend({
      type: 'claudeCode',
      model: 'claude-opus-4-6',
    });

    expect(result.handoff).toBe('notNeeded');
    expect(agent.db.getBackendHandoff('main', 'claudeCode')).toBeUndefined();
    expect(agent.backendRevision).toBe(0);
  });

  it('same-backend model changes can clear overrides without replacing the native session', async () => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    const agent = platform.createAgent('alice', {
      backend: { type: 'codex', model: 'gpt-5.4' },
    }) as AgentImpl;
    agent.db = _initTestDatabase();
    agent.registeredGroups['self-chat'] = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: new Date().toISOString(),
      isMain: true,
    };
    agent.sessions.main = 'codex-thread';
    agent.db.setSession('main', 'codex-thread', 'codex');
    const closeSpy = vi.spyOn(agent.queue, 'closeStdin');
    (agent as unknown as { _started: boolean })._started = true;

    const result = await agent.setBackend({ type: 'codex' });

    expect(result).toMatchObject({
      previous: { type: 'codex', model: 'gpt-5.4' },
      current: { type: 'codex' },
      applies: 'nextTurn',
      handoff: 'notNeeded',
    });
    expect(agent.getBackend()).toEqual({ type: 'codex' });
    expect(agent.sessions.main).toBe('codex-thread');
    expect(agent.db.getSession('main', 'codex')).toBe('codex-thread');
    expect(agent.backendRevision).toBe(0);
    expect(closeSpy).toHaveBeenCalledWith('self-chat');

    const registry = initAgentRegistryDb(tmpDir);
    try {
      expect(registry.getAgent('alice')!.backend).toEqual({ type: 'codex' });
    } finally {
      registry.close();
    }
  });

  it('backend switches can request fresh context without creating handoff state', async () => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    const agent = platform.createAgent('alice') as AgentImpl;
    agent.db = _initTestDatabase();
    agent.registeredGroups['self-chat'] = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: new Date().toISOString(),
      isMain: true,
    };
    agent.sessions.main = 'claude-session';
    agent.db.setSession('main', 'claude-session', 'claudeCode');
    agent.db.setSession('main', 'stale-codex-thread', 'codex');
    (agent as unknown as { _started: boolean })._started = true;

    const result = await agent.setBackend(
      { type: 'codex' },
      { context: 'fresh' },
    );

    expect(result.handoff).toBe('skipped');
    expect(agent.getBackend()).toEqual({ type: 'codex' });
    expect(agent.sessions.main).toBeUndefined();
    expect(agent.db.getSession('main', 'claudeCode')).toBe('claude-session');
    expect(agent.db.getSession('main', 'codex')).toBeUndefined();
    expect(agent.db.getBackendHandoff('main', 'codex')).toBeUndefined();
    expect(agent.backendRevision).toBe(1);
  });

  it.each([
    {
      label: 'before start',
      started: false,
      groups: {
        'self-chat': {
          name: 'Main',
          folder: 'main',
          trigger: 'always',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      },
    },
    {
      label: 'with no registered groups',
      started: true,
      groups: {},
    },
  ])('backend switches skip handoff $label', async ({ started, groups }) => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    const agent = platform.createAgent('alice') as AgentImpl;
    agent.db = _initTestDatabase();
    agent.registeredGroups = groups;
    const closeSpy = vi.spyOn(agent.queue, 'closeStdin');
    (agent as unknown as { _started: boolean })._started = started;

    const result = await agent.setBackend({ type: 'codex' });

    expect(result).toMatchObject({
      previous: { type: 'claudeCode' },
      current: { type: 'codex' },
      applies: 'nextTurn',
      handoff: 'skipped',
    });
    expect(agent.getBackend()).toEqual({ type: 'codex' });
    expect(agent.backendRevision).toBe(1);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid backend updates without mutating the current backend', async () => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    const agent = platform.createAgent('alice', {
      backend: { type: 'claudeCode', model: 'claude-sonnet-4-6' },
    }) as AgentImpl;
    const closeSpy = vi.spyOn(agent.queue, 'closeStdin');
    (agent as unknown as { _started: boolean })._started = true;

    await expect(
      agent.setBackend({ type: 'unknown' } as never),
    ).rejects.toThrow('Invalid agent backend');

    expect(agent.getBackend()).toEqual({
      type: 'claudeCode',
      model: 'claude-sonnet-4-6',
    });
    expect(agent.backendRevision).toBe(0);
    expect(closeSpy).not.toHaveBeenCalled();

    const registry = initAgentRegistryDb(tmpDir);
    try {
      expect(registry.getAgent('alice')!.backend).toEqual({
        type: 'claudeCode',
        model: 'claude-sonnet-4-6',
      });
    } finally {
      registry.close();
    }
  });

  it('setBackend no-ops when backend and model are unchanged', async () => {
    const platform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(platform);

    const agent = platform.createAgent('alice') as AgentImpl;
    agent.db = _initTestDatabase();
    agent.registeredGroups['self-chat'] = {
      name: 'Main',
      folder: 'main',
      trigger: 'always',
      added_at: new Date().toISOString(),
      isMain: true,
    };
    const closeSpy = vi.spyOn(agent.queue, 'closeStdin');
    (agent as unknown as { _started: boolean })._started = true;

    const result = await agent.setBackend({ type: 'claudeCode' });

    expect(result.handoff).toBe('notNeeded');
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('keeps createAgent strict for restored names, deletes the workdir, and removes registry rows on delete', async () => {
    const firstPlatform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(firstPlatform);
    const agentWorkdir = path.join(tmpDir, 'custom-agents', 'alice');
    const agent = firstPlatform.createAgent('alice', {
      name: 'Alice',
      workdir: agentWorkdir,
    });
    fs.mkdirSync(agentWorkdir, { recursive: true });
    fs.writeFileSync(path.join(agentWorkdir, 'sentinel.txt'), 'alive', 'utf8');
    await firstPlatform.stop();

    const secondPlatform = await createAgentLiteImpl({ workdir: tmpDir });
    platforms.push(secondPlatform);

    expect(() => secondPlatform.createAgent('alice')).toThrow(
      'Agent "alice" already exists',
    );

    await secondPlatform.deleteAgent('alice');
    expect(cleanupOrphans).toHaveBeenCalledWith(agent.id, {
      includeLive: true,
    });
    expect(secondPlatform.agents.has('alice')).toBe(false);
    expect(fs.existsSync(agentWorkdir)).toBe(false);
    expect(fs.existsSync(getAgentRegistryDbPath(tmpDir))).toBe(true);

    const registry = initAgentRegistryDb(tmpDir);
    try {
      expect(registry.getAgent('alice')).toBeUndefined();
    } finally {
      registry.close();
    }
  });
});
