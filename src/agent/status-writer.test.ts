import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  summarizeArgs,
  writeStatusFile,
  type AgentStatus,
} from './status-writer.js';

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-status-'));
  tempDirs.push(dir);
  return dir;
}

function createStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    schemaVersion: 1,
    updatedAt: '2026-04-19T10:00:00.000Z',
    agentId: 'agent-1',
    agentName: 'Observer',
    status: 'working',
    phase: 'tool_call_start',
    currentTool: 'Read',
    toolArgsSummary: 'file: index.ts',
    lastToolDurationMs: null,
    turnCount: 2,
    workItemId: 'item-1',
    workItemTitle: 'Instrument agent activity',
    sessionId: 'session-1',
    sessionStartedAt: '2026-04-19T09:55:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('status-writer', () => {
  it('writes the status file under data/ipc with an atomic rename', () => {
    const dataDir = makeTempDir();
    const status = createStatus();

    writeStatusFile(dataDir, status);

    const statusPath = path.join(dataDir, 'ipc', 'status.json');
    const tmpPath = path.join(dataDir, 'ipc', 'status.json.tmp');

    expect(fs.existsSync(statusPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(statusPath, 'utf8')) as AgentStatus,
    ).toEqual(status);
  });

  it.each([
    ['Read', { file_path: '/tmp/project/src/index.ts' }, 'file: index.ts'],
    ['Write', { file_path: '/tmp/project/src/index.ts' }, 'file: index.ts'],
    ['Bash', { command: 'printf "hello"\n'.repeat(10) }, `$ ${'printf "hello"\n'.repeat(10).slice(0, 80)}`],
    ['call_action', { name: 'workflow_items_move' }, 'action: workflow_items_move'],
    ['UnknownTool', { anything: true }, 'UnknownTool'],
  ])('summarizes %s arguments', (toolName, payload, expected) => {
    expect(summarizeArgs(toolName, payload)).toBe(expected);
  });
});
