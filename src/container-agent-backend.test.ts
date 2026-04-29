import { describe, expect, it } from 'vitest';

import {
  buildCodexArgs,
  getAgentBackendModel,
} from '../container/agent-runner/src/agent-backend.js';

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
