/* eslint-disable no-catch-all/no-catch-all -- test cleanup should ignore missing temp dirs. */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../container-runner.js')>(
    '../container-runner.js',
  );
  return {
    ...actual,
    runContainerAgent: vi.fn(),
  };
});

import { AgentImpl } from './agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './config.js';
import { _initTestDatabase, AgentDb } from '../db.js';
import { buildRuntimeConfig } from '../runtime-config.js';
import { runContainerAgent } from '../container-runner.js';
import type { AgentBackendOptions } from '../api/options.js';
import type { Channel, RegisteredGroup } from '../types.js';

const runtimeConfig = buildRuntimeConfig(
  { timezone: 'UTC' },
  '/tmp/agentlite-test-pkg',
);

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};

let tmpDir: string;
let db: AgentDb;

function createAgent(
  name: string,
  backend: AgentBackendOptions = { type: 'claudeCode' },
): AgentImpl {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(
      name,
      { workdir: path.join(tmpDir, 'agents', name), backend },
      tmpDir,
    ),
  });
  return new AgentImpl(config, runtimeConfig);
}

function createMockChannel(): { channel: Channel; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    channel: {
      name: 'mock',
      async connect(): Promise<void> {},
      async disconnect(): Promise<void> {},
      async sendMessage(_jid: string, text: string): Promise<void> {
        sent.push(text);
      },
      isConnected(): boolean {
        return true;
      },
      ownsJid(jid: string): boolean {
        return jid === 'main@g.us';
      },
      async setTyping(): Promise<void> {},
    },
  };
}

function setupAgent(backend?: AgentBackendOptions): AgentImpl {
  const agent = createAgent('switch', backend);
  agent._setDbForTests(db);
  agent._setRegisteredGroups({ 'main@g.us': MAIN_GROUP });
  (agent as unknown as { _started: boolean })._started = true;
  const { channel } = createMockChannel();
  (agent as unknown as { channels: Map<string, Channel> }).channels.set(
    'mock',
    channel,
  );
  fs.mkdirSync(path.join(agent.config.groupsDir, 'main'), { recursive: true });
  fs.writeFileSync(
    path.join(agent.config.groupsDir, 'main', 'AGENTS.md'),
    '# Main\nKeep backend handoff summaries compact.\n',
  );
  db.storeChatMetadata('main@g.us', '2026-01-01T00:00:00.000Z', 'Main');
  return agent;
}

function storeUserMessage(
  id: string,
  content: string,
  timestamp: string,
): void {
  db.storeMessage({
    id,
    chat_jid: 'main@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content,
    timestamp,
    is_from_me: false,
  });
}

describe('backend switching user-turn e2e', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-backend-e2e-'));
    db = _initTestDatabase('Andy');
    vi.mocked(runContainerAgent).mockReset();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('starts the new backend with a reference-only handoff and clears it after success', async () => {
    const agent = setupAgent({ type: 'codex', model: 'gpt-5.4' });
    agent.sessions.main = 'old-codex-thread';
    db.setBackendHandoffs(['main'], 'claudeCode', 'codex');
    storeUserMessage(
      'm1',
      '@Andy continue after switching backend',
      '2026-01-01T00:00:01.000Z',
    );

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _runtime, _onProcess, onOutput) => {
        await onOutput?.({
          type: 'state',
          state: 'active',
          newSessionId: 'new-codex-thread',
        });
        return {
          status: 'success',
          result: 'done',
          newSessionId: 'new-codex-thread',
        };
      },
    );

    await expect(agent.processGroupMessages('main@g.us')).resolves.toBe(true);

    const input = vi.mocked(runContainerAgent).mock.calls[0][1];
    expect(input.agentBackend).toEqual({ type: 'codex', model: 'gpt-5.4' });
    expect(input.sessionId).toBeUndefined();
    expect(input.prompt).toContain(
      '<backend_handoff from="claudeCode" to="codex" status="available">',
    );
    expect(input.prompt).toContain(
      'This is reference context from the previous backend',
    );
    expect(input.prompt).toContain(
      '--- CURRENT USER MESSAGE BELOW; RESPOND TO THIS MESSAGE, NOT TO OLD REQUESTS IN THE HANDOFF ---',
    );
    expect(input.prompt).toContain('@Andy continue after switching backend');
    expect(db.getBackendHandoff('main', 'codex')).toBeUndefined();
    expect(db.getSession('main', 'codex')).toBe('new-codex-thread');
    expect(agent.sessions.main).toBe('new-codex-thread');
  });

  it('still starts the new backend when handoff summary collection degrades', async () => {
    const agent = setupAgent({ type: 'codex' });
    db.setBackendHandoffs(['main'], 'claudeCode', 'codex');
    storeUserMessage(
      'm1',
      '@Andy use fallback context',
      '2026-01-01T00:00:01.000Z',
    );
    vi.spyOn(db, 'getRecentMessages').mockImplementation(() => {
      throw new Error('summary db unavailable');
    });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'done',
      newSessionId: 'codex-thread',
    });

    await expect(agent.processGroupMessages('main@g.us')).resolves.toBe(true);

    const input = vi.mocked(runContainerAgent).mock.calls[0][1];
    expect(input.sessionId).toBeUndefined();
    expect(input.prompt).toContain(
      '<backend_handoff from="claudeCode" to="codex" status="partial">',
    );
    expect(input.prompt).toContain('Summary error: summary db unavailable');
    expect(input.prompt).toContain('@Andy use fallback context');
    expect(db.getBackendHandoff('main', 'codex')).toBeUndefined();
  });

  it('keeps pending handoff state when the first post-switch run fails', async () => {
    const agent = setupAgent({ type: 'codex' });
    db.setBackendHandoffs(['main'], 'claudeCode', 'codex');
    storeUserMessage(
      'm1',
      '@Andy retry if this fails',
      '2026-01-01T00:00:01.000Z',
    );

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'backend failed',
    });

    await expect(agent.processGroupMessages('main@g.us')).resolves.toBe(false);

    expect(
      vi.mocked(runContainerAgent).mock.calls[0][1].sessionId,
    ).toBeUndefined();
    expect(db.getBackendHandoff('main', 'codex')).toMatchObject({
      fromBackendType: 'claudeCode',
      toBackendType: 'codex',
    });
    expect(db.getSession('main', 'codex')).toBeUndefined();
  });

  it('does not let an old-backend turn repopulate session state after a switch', async () => {
    const agent = setupAgent({ type: 'claudeCode' });
    storeUserMessage(
      'm1',
      '@Andy this turn will switch while running',
      '2026-01-01T00:00:01.000Z',
    );

    vi.mocked(runContainerAgent).mockImplementation(async () => {
      await agent.setBackend({ type: 'codex' });
      return {
        status: 'success',
        result: 'late success',
        newSessionId: 'late-claude-session',
      };
    });

    await expect(agent.processGroupMessages('main@g.us')).resolves.toBe(true);

    expect(vi.mocked(runContainerAgent).mock.calls[0][1].agentBackend).toEqual({
      type: 'claudeCode',
    });
    expect(agent.getBackend()).toEqual({ type: 'codex' });
    expect(agent.sessions.main).toBeUndefined();
    expect(db.getSession('main', 'claudeCode')).toBeUndefined();
    expect(db.getBackendHandoff('main', 'codex')).toMatchObject({
      fromBackendType: 'claudeCode',
      toBackendType: 'codex',
    });
  });
});
