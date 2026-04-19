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
      return jid === 'mock:tool-usage';
    },
    async setTyping(): Promise<void> {},
  };
}

function setupAgent(): AgentImpl {
  const agent = createAgent('tool-usage');
  agent._setDbForTests(db);
  agent._setRegisteredGroups({ 'mock:tool-usage': MAIN_GROUP });
  (agent as unknown as { _started: boolean })._started = true;
  (agent as unknown as { channels: Map<string, Channel> }).channels.set(
    'mock',
    createMockChannel(),
  );

  db.storeChatMetadata(
    'mock:tool-usage',
    '2026-04-19T00:00:00.000Z',
    'Tool Usage Chat',
  );
  db.storeMessage({
    id: 'msg-1',
    chat_jid: 'mock:tool-usage',
    sender: 'user1',
    sender_name: 'User 1',
    content: 'run the tool',
    timestamp: '2026-04-19T00:00:01.000Z',
    is_from_me: false,
  });

  return agent;
}

function sdkMsg(sdkType: string, message: unknown, sdkSubtype?: string) {
  return { type: 'sdk_message' as const, sdkType, sdkSubtype, message };
}

describe('tool usage analytics', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-tool-usage-'));
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

  it('records successful tool results from tool_use/tool_result SDK messages', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          sdkMsg('assistant', {
            uuid: 'a1',
            message: {
              content: [
                {
                  type: 'tool_use',
                  name: 'Bash',
                  id: 'tool-1',
                  input: { command: 'pwd' },
                },
              ],
            },
          }),
        );
        await onOutput?.(
          sdkMsg('user', {
            uuid: 'u1',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  is_error: false,
                  content: 'ok',
                },
              ],
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

    await agent.processGroupMessages('mock:tool-usage');

    expect(db.getToolUsageSummary()).toEqual([
      expect.objectContaining({
        tool_name: 'Bash',
        call_count: 1,
        success_count: 1,
        success_rate: 1,
      }),
    ]);
  });

  it('records failed tool results as success_rate 0', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          sdkMsg('assistant', {
            uuid: 'a1',
            message: {
              content: [
                {
                  type: 'tool_use',
                  name: 'Bash',
                  id: 'tool-2',
                  input: { command: 'false' },
                },
              ],
            },
          }),
        );
        await onOutput?.(
          sdkMsg('user', {
            uuid: 'u1',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-2',
                  is_error: true,
                  content: 'command failed',
                },
              ],
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

    await agent.processGroupMessages('mock:tool-usage');

    expect(db.getToolUsageSummary()).toEqual([
      expect.objectContaining({
        tool_name: 'Bash',
        call_count: 1,
        success_count: 0,
        success_rate: 0,
      }),
    ]);
  });
});
