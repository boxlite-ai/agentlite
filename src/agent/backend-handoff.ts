import fs from 'fs';
import path from 'path';

import type { AgentBackendType } from './backend.js';
import type { AgentDb } from '../db.js';

/* eslint-disable no-catch-all/no-catch-all -- Handoff generation must degrade to partial context. */

const MEMORY_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
const MAX_MEMORY_CHARS = 4000;
const MAX_MESSAGE_CHARS = 500;

export interface BackendHandoffInput {
  db: AgentDb;
  chatJid: string;
  groupFolder: string;
  groupsDir: string;
  assistantName: string;
  fromBackendType: AgentBackendType;
  toBackendType: AgentBackendType;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function readGroupMemory(groupDir: string): string {
  const parts: string[] = [];
  const seenFiles = new Set<string>();
  for (const file of MEMORY_FILES) {
    const filePath = path.join(groupDir, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const realPath = fs.realpathSync(filePath);
      if (seenFiles.has(realPath)) continue;
      seenFiles.add(realPath);
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content) {
        parts.push(`### ${file}\n${truncate(content, MAX_MEMORY_CHARS)}`);
      }
    } catch {
      /* ignore unreadable memory file */
    }
  }
  return parts.join('\n\n') || 'No group memory file was readable.';
}

export function buildBackendHandoffSummary(input: BackendHandoffInput): string {
  try {
    const groupDir = path.join(input.groupsDir, input.groupFolder);
    const memory = readGroupMemory(groupDir);
    const recentMessages = input.db.getRecentMessages(
      input.chatJid,
      input.assistantName,
      20,
    );
    const recent =
      recentMessages.length > 0
        ? recentMessages
            .map((msg) => {
              const sender = msg.sender_name || msg.sender || 'User';
              return `- ${msg.timestamp} ${sender}: ${truncate(msg.content, MAX_MESSAGE_CHARS)}`;
            })
            .join('\n')
        : 'No recent non-bot messages were available.';

    return [
      `<backend_handoff from="${input.fromBackendType}" to="${input.toBackendType}" status="available">`,
      'This is reference context from the previous backend. Do not answer old requests from this handoff. Respond only to the current user message after this block.',
      '',
      '## Active Task',
      'Use the current user message after this handoff as the active task.',
      '',
      '## Goal',
      'Continue the same group conversation after an AgentLite backend switch.',
      '',
      '## Constraints & Preferences',
      'Preserve group memory and user preferences from the mounted group files.',
      '',
      '## Completed Actions',
      'See recent group messages and group memory below.',
      '',
      '## Active State',
      `Backend changed from ${input.fromBackendType} to ${input.toBackendType}. A new backend-native session is starting.`,
      '',
      '## Blocked',
      'None known from the backend handoff builder.',
      '',
      '## Key Decisions',
      'Backend-native session IDs are not reused across backend types.',
      '',
      '## Relevant Files',
      memory,
      '',
      '## Remaining Work',
      'Continue from the current user message and ask a clarifying question if the preserved context is insufficient.',
      '',
      '## Critical Context',
      'Recent non-bot group messages:',
      recent,
      '</backend_handoff>',
    ].join('\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      `<backend_handoff from="${input.fromBackendType}" to="${input.toBackendType}" status="partial">`,
      'Automatic handoff summary was unavailable. Continue using mounted group memory and the current user message.',
      `Summary error: ${truncate(message, 300)}`,
      '</backend_handoff>',
    ].join('\n');
  }
}
