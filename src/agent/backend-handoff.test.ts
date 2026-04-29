import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { buildBackendHandoffSummary } from './backend-handoff.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-handoff-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildBackendHandoffSummary', () => {
  it('builds a reference-only handoff from group memory and recent messages', () => {
    const db = _initTestDatabase('Andy');
    const groupDir = path.join(tmpDir, 'main');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'AGENTS.md'),
      '# Main\nUse concise replies.\n',
    );
    db.storeChatMetadata('self-chat', '2026-01-01T00:00:00.000Z', 'Main');
    db.storeMessageDirect({
      id: 'm1',
      chat_jid: 'self-chat',
      sender: 'user',
      sender_name: 'User',
      content: 'Continue the deployment checklist.',
      timestamp: '2026-01-01T00:00:00.000Z',
      is_from_me: false,
    });

    const summary = buildBackendHandoffSummary({
      db,
      chatJid: 'self-chat',
      groupFolder: 'main',
      groupsDir: tmpDir,
      assistantName: 'Andy',
      fromBackendType: 'claudeCode',
      toBackendType: 'codex',
    });

    expect(summary).toContain('status="available"');
    expect(summary).toContain('reference context');
    expect(summary).toContain('Use concise replies');
    expect(summary).toContain('Continue the deployment checklist');
  });

  it('returns a partial handoff marker when context collection fails', () => {
    const summary = buildBackendHandoffSummary({
      db: {
        getRecentMessages() {
          throw new Error('db unavailable');
        },
      } as unknown as ReturnType<typeof _initTestDatabase>,
      chatJid: 'self-chat',
      groupFolder: 'main',
      groupsDir: tmpDir,
      assistantName: 'Andy',
      fromBackendType: 'claudeCode',
      toBackendType: 'codex',
    });

    expect(summary).toContain('status="partial"');
    expect(summary).toContain('Automatic handoff summary was unavailable');
  });
});
