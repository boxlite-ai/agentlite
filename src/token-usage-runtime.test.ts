import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runner.js')>(
    './container-runner.js',
  );
  return {
    ...actual,
    runContainerAgent: vi.fn(),
  };
});

import { AgentImpl } from './agent/agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './agent/config.js';
import { _initTestDatabase, AgentDb } from './db.js';
import { buildRuntimeConfig } from './runtime-config.js';
import { runContainerAgent } from './container-runner.js';
import type { Channel, RegisteredGroup } from './types.js';

const runtimeConfig = buildRuntimeConfig(
  { timezone: 'UTC' },
  '/tmp/agentlite-test-pkg',
);

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let tmpDir: string;
let db: AgentDb;

function createAgent(name: string): AgentImpl {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(
      name,
      { workdir: path.join(tmpDir, 'agents', name) },
      tmpDir,
    ),
  });
  return new AgentImpl(config, runtimeConfig);
}

function createMockChannel(): Channel {
  return {
    name: 'mock',
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    async sendMessage(): Promise<void> {},
    isConnected(): boolean {
      return true;
    },
    ownsJid(jid: string): boolean {
      return jid === 'mock:token-usage';
    },
    async setTyping(): Promise<void> {},
  };
}

describe('token usage runtime persistence', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-token-usage-'));
    db = _initTestDatabase();
    vi.mocked(runContainerAgent).mockReset();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('persists token usage emitted by the container runtime', async () => {
    const agent = createAgent('token-usage');
    agent._setDbForTests(db);
    agent._setRegisteredGroups({ 'mock:token-usage': MAIN_GROUP });
    (agent as unknown as { _started: boolean })._started = true;
    (agent as unknown as { channels: Map<string, Channel> }).channels.set(
      'mock',
      createMockChannel(),
    );

    db.storeChatMetadata(
      'mock:token-usage',
      '2026-04-19T00:00:00.000Z',
      'Token Usage Chat',
    );
    db.storeMessage({
      id: 'msg-1',
      chat_jid: 'mock:token-usage',
      sender: 'user1',
      sender_name: 'User 1',
      content: 'track this run',
      timestamp: '2026-04-19T00:00:01.000Z',
      is_from_me: false,
    });

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.({
          type: 'token_usage',
          usage: {
            group_jid: 'mock:token-usage',
            session_id: 'session-runtime',
            model: 'claude-sonnet-4-6',
            prompt_tokens: 111,
            completion_tokens: 22,
            total_tokens: 133,
            cache_read_tokens: 7,
            cache_write_tokens: 3,
            latency_ms: 456,
            ts: 1_710_000_000_123,
          },
        });
        await onOutput?.({
          type: 'result',
          result: 'done',
          newSessionId: 'session-runtime',
        });
        return {
          status: 'success',
          result: 'done',
          newSessionId: 'session-runtime',
        };
      },
    );

    const processed = await agent.processGroupMessages('mock:token-usage');
    expect(processed).toBe(true);

    const rows = db._getTokenUsageRowsForTests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      group_jid: 'mock:token-usage',
      session_id: 'session-runtime',
      model: 'claude-sonnet-4-6',
      prompt_tokens: 111,
      completion_tokens: 22,
      total_tokens: 133,
      cache_read_tokens: 7,
      cache_write_tokens: 3,
      latency_ms: 456,
      ts: 1_710_000_000_123,
    });
    expect(rows[0]?.cost_usd).toBeCloseTo(0.00067995);
  });
});
