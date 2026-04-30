import { EventEmitter } from 'events';
import fs from 'fs';
import { PassThrough } from 'stream';
import { spawn } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import {
  buildCodexArgs,
  createQueryRunner,
  getAgentBackendModel,
} from '../container/agent-runner/src/agent-backend.js';

function createMockCodexProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function writeCodexJson(
  child: ReturnType<typeof createMockCodexProcess>,
  event: unknown,
) {
  child.stdout.write(`${JSON.stringify(event)}\n`);
}

function waitForLines(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('container agent backend helpers', () => {
  it('passes model to codex exec', () => {
    expect(buildCodexArgs({ model: 'gpt-5.4' })).toEqual([
      'exec',
      '--model',
      'gpt-5.4',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ]);
  });

  it('passes model to codex exec resume', () => {
    expect(
      buildCodexArgs({ sessionId: 'session-123', model: 'gpt-5.4' }),
    ).toEqual([
      'exec',
      'resume',
      '--model',
      'gpt-5.4',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'session-123',
      '-',
    ]);
  });

  it('omits model args when no model override is configured', () => {
    expect(buildCodexArgs({ sessionId: 'session-123' })).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'session-123',
      '-',
    ]);
    expect(buildCodexArgs({ sessionId: 'session-123', model: '   ' })).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'session-123',
      '-',
    ]);
  });

  it('normalizes model overrides before runner-specific option wiring', () => {
    expect(
      getAgentBackendModel({
        groupFolder: 'main',
        chatJid: 'main@g.us',
        isMain: true,
        agentBackend: { type: 'claudeCode', model: ' claude-opus-4-6 ' },
      }),
    ).toBe('claude-opus-4-6');
    expect(
      getAgentBackendModel({
        groupFolder: 'main',
        chatJid: 'main@g.us',
        isMain: true,
        agentBackend: { type: 'codex', model: '   ' },
      }),
    ).toBeUndefined();
  });
});

describe('CodexQueryRunner', () => {
  it('emits a single result after successful process exit using the latest agent message', async () => {
    const child = createMockCodexProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as never);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    const outputs: Array<{ type: string; [key: string]: unknown }> = [];
    const runner = createQueryRunner(
      { type: 'codex' },
      {
        log: vi.fn(),
        writeOutput: (output) => outputs.push(output),
      },
    );

    const run = runner.run({
      prompt: 'handle assigned work',
      sessionId: undefined,
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      containerInput: {
        groupFolder: 'main',
        chatJid: 'mock:main',
        isMain: true,
        agentBackend: { type: 'codex' },
      },
      sdkEnv: {},
    });

    writeCodexJson(child, {
      type: 'thread.started',
      thread_id: 'thread-123',
    });
    writeCodexJson(child, { type: 'turn.started' });
    writeCodexJson(child, {
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'agent_message',
        text: 'I will inspect the workflow first.',
      },
    });
    await waitForLines();

    expect(outputs.filter((output) => output.type === 'result')).toHaveLength(
      0,
    );

    writeCodexJson(child, {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'tool_call',
        name: 'mcp__agentlite__call_action',
      },
    });
    writeCodexJson(child, {
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'agent_message',
        text: 'Final answer after the tool work.',
      },
    });
    await waitForLines();

    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);

    await expect(run).resolves.toMatchObject({
      newSessionId: 'thread-123',
      closedDuringQuery: false,
    });

    expect(outputs.filter((output) => output.type === 'result')).toEqual([
      {
        type: 'result',
        result: 'Final answer after the tool work.',
        newSessionId: 'thread-123',
      },
    ]);
    expect(
      outputs.filter((output) => output.type === 'sdk_message'),
    ).toHaveLength(5);
  });
});
