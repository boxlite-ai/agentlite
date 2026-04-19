import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface AgentStatus {
  schemaVersion: 1;
  updatedAt: string;
  agentId: string;
  agentName: string;
  status: 'working' | 'idle' | 'done' | 'error';
  phase: 'tool_call_start' | 'tool_call_done' | 'idle' | 'done' | 'error';
  currentTool: string | null;
  toolArgsSummary: string | null;
  lastToolDurationMs: number | null;
  turnCount: number;
  workItemId: string | null;
  workItemTitle: string | null;
  sessionId: string;
  sessionStartedAt: string;
}

export function writeStatusFile(dataDir: string, status: AgentStatus): void {
  const ipcDir = join(dataDir, 'ipc');
  const statusPath = join(ipcDir, 'status.json');
  const tmpPath = `${statusPath}.tmp`;

  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(status, null, 2), 'utf8');
  renameSync(tmpPath, statusPath);
}

export function summarizeArgs(toolName: string, payload: unknown): string {
  const record =
    payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {};

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return `file: ${String(record.file_path ?? '?').split('/').pop()}`;
    case 'Bash':
      return `$ ${String(record.command ?? '').slice(0, 80)}`;
    case 'call_action':
      return `action: ${String(record.name ?? '?')}`;
    case 'Grep':
      return `pattern: ${String(record.pattern ?? '?').slice(0, 60)}`;
    case 'Glob':
      return `pattern: ${String(record.pattern ?? '?')}`;
    default:
      return toolName;
  }
}
