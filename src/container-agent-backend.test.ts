import { describe, expect, it } from 'vitest';

import { buildCodexArgs } from '../container/agent-runner/src/agent-backend.js';

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
  });
});
