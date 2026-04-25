import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contextCompressionMocks = vi.hoisted(() => ({
  needsCompression: vi.fn(
    (utilization: number | null) => utilization !== null && utilization >= 0.8,
  ),
  compress: vi.fn(
    async (messages: Array<{ sender: string; content: string }>) => {
      const kept = Math.max(1, Math.floor(messages.length * 0.2));
      return {
        summary: 'condensed history',
        messagesCompressed: messages.length - kept,
        messagesKept: kept,
      };
    },
  ),
}));

vi.mock('../container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../container-runner.js')>(
    '../container-runner.js',
  );
  return {
    ...actual,
    runContainerAgent: vi.fn(),
  };
});

vi.mock('./context-compressor.js', () => ({
  ContextCompressor: class {
    needsCompression(utilization: number | null) {
      return contextCompressionMocks.needsCompression(utilization);
    }

    compress(messages: Array<{ sender: string; content: string }>) {
      return contextCompressionMocks.compress(messages);
    }

    formatSummaryBlock(summary: string, compressedAt: string) {
      return `<context_summary type="compressed" compressed_at="${compressedAt}">\nEarlier conversation summary (auto-generated):\n${summary}\n</context_summary>`;
    }
  },
}));

import { AgentImpl } from './agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './config.js';
import type { ContextCompressedEvent } from '../api/events.js';
import { runContainerAgent } from '../container-runner.js';
import { _initTestDatabase, AgentDb } from '../db.js';
import { buildRuntimeConfig } from '../runtime-config.js';
import type { Channel, RegisteredGroup } from '../types.js';

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
      return jid === 'mock:stream';
    },
    async setTyping(): Promise<void> {},
  };
}

function setupAgent(): AgentImpl {
  const agent = createAgent('message-processor-test');
  agent._setDbForTests(db);
  agent._setRegisteredGroups({ 'mock:stream': MAIN_GROUP });
  (agent as unknown as { _started: boolean })._started = true;
  const channel = createMockChannel();
  (agent as unknown as { channels: Map<string, Channel> }).channels.set(
    'mock',
    channel,
  );

  db.storeChatMetadata(
    'mock:stream',
    '2026-04-13T00:00:00.000Z',
    'Message Processor Test Chat',
  );
  db.storeMessage({
    id: 'msg-1',
    chat_jid: 'mock:stream',
    sender: 'user1',
    sender_name: 'User 1',
    content: 'do something',
    timestamp: '2026-04-13T00:00:01.000Z',
    is_from_me: false,
  });

  return agent;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-message-'));
  db = _initTestDatabase();
  vi.mocked(runContainerAgent).mockReset();
  contextCompressionMocks.needsCompression.mockReset();
  contextCompressionMocks.needsCompression.mockImplementation(
    (utilization: number | null) => utilization !== null && utilization >= 0.8,
  );
  contextCompressionMocks.compress.mockReset();
  contextCompressionMocks.compress.mockImplementation(
    async (messages: Array<{ sender: string; content: string }>) => {
      const kept = Math.max(1, Math.floor(messages.length * 0.2));
      return {
        summary: 'condensed history',
        messagesCompressed: messages.length - kept,
        messagesKept: kept,
      };
    },
  );
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sdkMsg(sdkType: string, message: unknown, sdkSubtype?: string) {
  return { type: 'sdk_message' as const, sdkType, sdkSubtype, message };
}

describe('MessageProcessor', () => {
  it('stores 0.75 from a rate_limit_event', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          sdkMsg('rate_limit_event', {
            utilization: 0.75,
          }),
        );
        await onOutput?.({
          type: 'state',
          state: 'stopped',
          reason: 'exit',
          exitCode: 0,
        });
        return { status: 'success', result: null };
      },
    );

    await agent.processGroupMessages('mock:stream');

    expect(db.getContextUtilization('mock:stream')).toBe(0.75);
  });

  it('stores 0.82 from a rate_limit_event', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          sdkMsg('rate_limit_event', {
            rate_limit_info: {
              utilization: 0.82,
            },
          }),
        );
        await onOutput?.({
          type: 'state',
          state: 'stopped',
          reason: 'exit',
          exitCode: 0,
        });
        return { status: 'success', result: null };
      },
    );

    await agent.processGroupMessages('mock:stream');

    expect(db.getContextUtilization('mock:stream')).toBe(0.82);
  });

  it('prepends a summary block, clears the session, and emits context_compressed when utilization is high', async () => {
    const agent = setupAgent();
    db.setSession('main', 'existing-session');
    (agent as unknown as { sessions: Record<string, string> }).sessions.main =
      'existing-session';
    db.setContextUtilization('mock:stream', 0.82);

    for (let i = 2; i <= 10; i++) {
      db.storeMessage({
        id: `msg-${i}`,
        chat_jid: 'mock:stream',
        sender: `user${i}`,
        sender_name: `User ${i}`,
        content: `message ${i}`,
        timestamp: `2026-04-13T00:00:${String(i).padStart(2, '0')}.000Z`,
        is_from_me: false,
      });
    }

    contextCompressionMocks.compress.mockResolvedValue({
      summary: 'compressed context',
      messagesCompressed: 8,
      messagesKept: 2,
    });

    let capturedInput:
      | {
          prompt: string;
          sessionId?: string;
        }
      | undefined;
    const events: ContextCompressedEvent[] = [];
    agent.on('context_compressed', (evt) => events.push(evt));

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, input, _rc, _onProcess, onOutput) => {
        capturedInput = input;
        await onOutput?.({
          type: 'state',
          state: 'stopped',
          reason: 'exit',
          exitCode: 0,
        });
        return { status: 'success', result: null };
      },
    );

    await agent.processGroupMessages('mock:stream');

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.sessionId).toBeUndefined();
    expect(capturedInput!.prompt.startsWith('<context_summary')).toBe(true);
    expect(capturedInput!.prompt).toContain('compressed context');
    expect(capturedInput!.prompt).toContain('message 9');
    expect(capturedInput!.prompt).toContain('message 10');
    expect(capturedInput!.prompt).not.toContain('message 2');
    expect(db.getContextUtilization('mock:stream')).toBeNull();
    expect(db.getSession('main')).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: agent.id,
      jid: 'mock:stream',
      utilization: 0.82,
      messagesCompressed: 8,
      messagesKept: 2,
    });
  });

  it('does not compress when utilization is below the threshold', async () => {
    const agent = setupAgent();
    db.setSession('main', 'existing-session');
    (agent as unknown as { sessions: Record<string, string> }).sessions.main =
      'existing-session';
    db.setContextUtilization('mock:stream', 0.79);

    let capturedInput:
      | {
          prompt: string;
          sessionId?: string;
        }
      | undefined;
    const events: ContextCompressedEvent[] = [];
    agent.on('context_compressed', (evt) => events.push(evt));

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, input, _rc, _onProcess, onOutput) => {
        capturedInput = input;
        await onOutput?.({
          type: 'state',
          state: 'stopped',
          reason: 'exit',
          exitCode: 0,
        });
        return { status: 'success', result: null };
      },
    );

    await agent.processGroupMessages('mock:stream');

    expect(contextCompressionMocks.compress).not.toHaveBeenCalled();
    expect(capturedInput).toBeDefined();
    expect(capturedInput!.sessionId).toBe('existing-session');
    expect(capturedInput!.prompt.startsWith('<context_summary')).toBe(false);
    expect(capturedInput!.prompt).toContain('do something');
    expect(db.getContextUtilization('mock:stream')).toBe(0.79);
    expect(db.getSession('main')).toBe('existing-session');
    expect(events).toHaveLength(0);
  });
});
