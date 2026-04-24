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

  // ── Reconnection tests (design §4, tests 6 & 7) ───────────────

  it('replays buffered deltas in order on reconnect (ring-buffer replay, design test 6)', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'chunk1' },
          }),
        );
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'chunk2' },
          }),
        );
        // Container exits without message_stop (mid-stream crash)
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    // Collect events during initial streaming
    const streamingEvents: AgentPartialContentEvent[] = [];
    agent.on('run.partial_content', (evt) => streamingEvents.push(evt));

    await agent.processGroupMessages('mock:stream');

    // Verify initial streaming events
    expect(streamingEvents).toHaveLength(2);

    // Simulate UI reconnect: clear streaming events and call resume
    streamingEvents.length = 0;
    agent.resumePartialContent('mock:stream');

    // Ring buffer should replay the two buffered deltas in order
    expect(streamingEvents).toHaveLength(2);
    expect(streamingEvents[0].delta).toBe('chunk1');
    expect(streamingEvents[1].delta).toBe('chunk2');
    expect(streamingEvents[0].jid).toBe('mock:stream');
  });

  it('emits buffer_evicted on reconnect after stream completed normally (design test 7)', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(
          streamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'complete response' },
          }),
        );
        // Stream completes normally — ring buffer is cleared on message_stop
        await onOutput?.(streamEvent({ type: 'message_stop' }));
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      },
    );

    await agent.processGroupMessages('mock:stream');

    // Stream is done; buffer was cleared on message_stop
    const interruptedEvents: AgentPartialContentInterruptedEvent[] = [];
    agent.on('run.partial_content.interrupted', (evt) => interruptedEvents.push(evt));

    // Reconnect after stream completed → buffer_evicted
    agent.resumePartialContent('mock:stream');

    expect(interruptedEvents).toHaveLength(1);
    expect(interruptedEvents[0]).toMatchObject({
      jid: 'mock:stream',
      reason: 'buffer_evicted',
    });
    expect(typeof interruptedEvents[0].timestamp).toBe('string');
  });

  // ── Concurrent streams (design test 8) ────────────────────────

  it('two concurrent streams: each jid receives its own events and both get interrupted on drain', async () => {
    const jidA = 'mock:stream-a';
    const jidB = 'mock:stream-b';

    // Set up agent with two registered jids and matching channel
    const agent = createAgent('concurrent-test');
    agent._setDbForTests(db);
    const twoJidGroup: RegisteredGroup = {
      ...MAIN_GROUP,
      trigger: 'always',
    };
    const groupB: RegisteredGroup = {
      name: 'GroupB',
      folder: 'group-b',
      trigger: 'always',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: false,
      requiresTrigger: false,
    };
    agent._setRegisteredGroups({ [jidA]: twoJidGroup, [jidB]: groupB });
    (agent as unknown as { _started: boolean })._started = true;

    const twoJidChannel = {
      name: 'mock-two',
      async connect(): Promise<void> {},
      async disconnect(): Promise<void> {},
      async sendMessage(): Promise<void> {},
      isConnected(): boolean { return true; },
      ownsJid(jid: string): boolean { return jid === jidA || jid === jidB; },
      async setTyping(): Promise<void> {},
    };
    (agent as unknown as { channels: Map<string, Channel> }).channels.set('mock-two', twoJidChannel);

    // Seed messages for both jids
    db.storeChatMetadata(jidA, '2026-04-13T00:00:00.000Z', 'Chat A');
    db.storeMessage({ id: 'msg-a', chat_jid: jidA, sender: 'u1', sender_name: 'U1', content: 'go', timestamp: '2026-04-13T00:00:01.000Z', is_from_me: false });
    db.storeChatMetadata(jidB, '2026-04-13T00:00:00.000Z', 'Chat B');
    db.storeMessage({ id: 'msg-b', chat_jid: jidB, sender: 'u2', sender_name: 'U2', content: 'go', timestamp: '2026-04-13T00:00:01.000Z', is_from_me: false });

    // Coordination: jidA waits until jidB has also emitted its delta before exiting
    let resolveJidADeltaSent: () => void;
    let resolveJidBDeltaSent: () => void;
    const jidADeltaSent = new Promise<void>((r) => { resolveJidADeltaSent = r; });
    const jidBDeltaSent = new Promise<void>((r) => { resolveJidBDeltaSent = r; });

    vi.mocked(runContainerAgent)
      .mockImplementationOnce(async (_g, _i, _r, _op, onOutput) => {
        // jidA emits its delta, signals jidB, then waits for jidB before stopping
        await onOutput?.(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tokenA' } }));
        resolveJidADeltaSent!();
        await jidBDeltaSent; // wait for jidB to have added itself to streamingJids
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      })
      .mockImplementationOnce(async (_g, _i, _r, _op, onOutput) => {
        // jidB waits for jidA's delta, then emits its own, then stops
        await jidADeltaSent;
        await onOutput?.(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tokenB' } }));
        resolveJidBDeltaSent!();
        await onOutput?.(stoppedState());
        return { status: 'success', result: null };
      });

    // Track events per jid
    const partialA: AgentPartialContentEvent[] = [];
    const partialB: AgentPartialContentEvent[] = [];
    const interruptedA: AgentPartialContentInterruptedEvent[] = [];
    const interruptedB: AgentPartialContentInterruptedEvent[] = [];

    agent.on('run.partial_content', (evt) => {
      if (evt.jid === jidA) partialA.push(evt);
      else if (evt.jid === jidB) partialB.push(evt);
    });
    agent.on('run.partial_content.interrupted', (evt) => {
      if (evt.jid === jidA) interruptedA.push(evt);
      else if (evt.jid === jidB) interruptedB.push(evt);
    });

    // Run both concurrently
    await Promise.all([
      agent.processGroupMessages(jidA),
      agent.processGroupMessages(jidB),
    ]);

    // Each jid received only its own partial_content event
    expect(partialA).toHaveLength(1);
    expect(partialA[0].delta).toBe('tokenA');
    expect(partialA[0].jid).toBe(jidA);
    expect(partialB).toHaveLength(1);
    expect(partialB[0].delta).toBe('tokenB');
    expect(partialB[0].jid).toBe(jidB);

    // drainStreamingJids must have emitted interrupted for both jids
    expect(interruptedA).toHaveLength(1);
    expect(interruptedA[0].reason).toBe('container_exit');
    expect(interruptedB).toHaveLength(1);
    expect(interruptedB[0].reason).toBe('container_exit');
  });
});
