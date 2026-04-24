/**
 * Tests for run.partial_content streaming events.
 * These events are derived from stream_event SDK messages and enable
 * the Dune UI to render agent responses token-by-token as they arrive.
 */
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
import type {
  AgentPartialContentEvent,
  AgentPartialToolCallEvent,
  AgentPartialContentDoneEvent,
  AgentPartialContentInterruptedEvent,
} from './api/events.js';
import type { Channel, RegisteredGroup } from './types.js';

const runtimeConfig = buildRuntimeConfig(
  { timezone: 'UTC' },
  '/tmp/agentlite-streaming-test-pkg',
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
  const agent = createAgent('partial-test');
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
    'Partial Content Test Chat',
  );
  db.storeMessage({
    id: 'msg-1',
    chat_jid: 'mock:stream',
    sender: 'user1',
    sender_name: 'User 1',
    content: 'stream something',
    timestamp: '2026-04-13T00:00:01.000Z',
    is_from_me: false,
  });

  return agent;
}

function streamEvent(event: unknown) {
  return { type: 'sdk_message' as const, sdkType: 'stream_event', message: { event } };
}

function stoppedState() {
  return { type: 'state' as const, state: 'stopped' as const, reason: 'exit', exitCode: 0 };
}

describe('run.partial_content (text token deltas)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-partial-'));
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

  it('emits run.partial_content for text_delta with correct payload', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'text_delta', text: 'Hello' },
          }),
        );
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    const events: AgentPartialContentEvent[] = [];
    agent.on('run.partial_content', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: agent.id,
      jid: 'mock:stream',
      delta: 'Hello',
      contentBlockIndex: 2,
    });
    expect(typeof events[0].timestamp).toBe('string');
  });

  it('emits run.partial_tool_call for input_json_delta with correct payload', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
          }),
        );
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    const events: AgentPartialToolCallEvent[] = [];
    agent.on('run.partial_tool_call', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: agent.id,
      jid: 'mock:stream',
      jsonDelta: '{"cmd":',
      contentBlockIndex: 1,
    });
  });

  it('does not emit run.partial_content for non-delta stream events (message_start)', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          streamEvent({ type: 'message_start', message: { id: 'msg-x' } }),
        );
        await onOutput?.(
          streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        );
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    const partialEvents: AgentPartialContentEvent[] = [];
    const toolCallEvents: AgentPartialToolCallEvent[] = [];
    agent.on('run.partial_content', (evt) => partialEvents.push(evt));
    agent.on('run.partial_tool_call', (evt) => toolCallEvents.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(partialEvents).toHaveLength(0);
    expect(toolCallEvents).toHaveLength(0);
  });

  it('emits run.partial_content.done on message_stop', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'token' },
          }),
        );
        await onOutput?.(streamEvent({ type: 'message_stop' }));
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    const doneEvents: AgentPartialContentDoneEvent[] = [];
    agent.on('run.partial_content.done', (evt) => doneEvents.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({
      agentId: agent.id,
      jid: 'mock:stream',
    });
    expect(typeof doneEvents[0].timestamp).toBe('string');
  });

  it('emits run.partial_content.interrupted with container_error reason on container error', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'partial' },
          }),
        );
        await onOutput?.({ type: 'error', error: 'container crashed' });
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    const interruptedEvents: AgentPartialContentInterruptedEvent[] = [];
    agent.on('run.partial_content.interrupted', (evt) =>
      interruptedEvents.push(evt),
    );

    await agent.processGroupMessages('mock:stream');

    expect(interruptedEvents).toHaveLength(1);
    expect(interruptedEvents[0]).toMatchObject({
      agentId: agent.id,
      jid: 'mock:stream',
      reason: 'container_error',
    });
  });

  it('emits run.partial_content.interrupted with container_exit reason on stopped state while streaming', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'mid-stream' },
          }),
        );
        // Container stops abruptly without message_stop (SIGKILL / ungraceful exit)
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    const interruptedEvents: AgentPartialContentInterruptedEvent[] = [];
    agent.on('run.partial_content.interrupted', (evt) =>
      interruptedEvents.push(evt),
    );

    await agent.processGroupMessages('mock:stream');

    expect(interruptedEvents).toHaveLength(1);
    expect(interruptedEvents[0]).toMatchObject({
      agentId: agent.id,
      jid: 'mock:stream',
      reason: 'container_exit',
    });
  });

  it('omits contentBlockIndex when streamEvent.index is undefined', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        // delta event without an index field
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'no-index' },
          }),
        );
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    const events: AgentPartialContentEvent[] = [];
    agent.on('run.partial_content', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe('no-index');
    expect(Object.prototype.hasOwnProperty.call(events[0], 'contentBlockIndex')).toBe(false);
  });

  it('emits one run.partial_content per text_delta (multiple sequential deltas)', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        for (const text of ['Hello', ' ', 'world', '!']) {
          await onOutput?.(
            streamEvent({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            }),
          );
        }
        await onOutput?.(streamEvent({ type: 'message_stop' }));
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    const partialEvents: AgentPartialContentEvent[] = [];
    const doneEvents: AgentPartialContentDoneEvent[] = [];
    agent.on('run.partial_content', (evt) => partialEvents.push(evt));
    agent.on('run.partial_content.done', (evt) => doneEvents.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(partialEvents).toHaveLength(4);
    expect(partialEvents.map((e) => e.delta)).toEqual(['Hello', ' ', 'world', '!']);
    expect(doneEvents).toHaveLength(1);
  });
});
