import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../box-runtime.js', () => ({
  setBoxliteHome: vi.fn(),
  ensureRuntimeReady: vi.fn(),
  cleanupOrphans: vi.fn().mockResolvedValue(undefined),
  spawnBox: vi.fn(),
}));

import { createAgentLite } from '../api/sdk.js';
import type { Agent } from '../api/agent.js';
import type { AgentLite } from '../api/sdk.js';
import type { AgentDb } from '../db.js';
import type { ActionsHttp } from './actions-http.js';

type AgentWithHttpAndDb = Agent & {
  actionsHttp: ActionsHttp;
  db: AgentDb;
};

describe('usage_get_summary action', () => {
  let tmpDir: string;
  let platform: AgentLite;
  let agent: AgentWithHttpAndDb;
  let token: string | undefined;
  let url: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-usage-action-'));
    platform = await createAgentLite({ workdir: tmpDir });
    agent = platform.createAgent('usage-test') as AgentWithHttpAndDb;
    await agent.start();

    const info = agent.actionsHttp.getInfo();
    if (!info) {
      throw new Error('No LAN IP available — can not run usage action tests');
    }
    url = info.url;
    token = agent.actionsHttp.mintContainerToken('test-group', false)?.token;
  });

  afterEach(async () => {
    await agent?.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function seedUsageRows(): void {
    agent.db.recordTokenUsage({
      group_jid: 'group-1@g.us',
      session_id: 'session-a',
      model: 'claude-sonnet-4-6',
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      latency_ms: 100,
      ts: 1_000,
    });
    agent.db.recordTokenUsage({
      group_jid: 'group-1@g.us',
      session_id: 'session-a',
      model: 'claude-sonnet-4-6',
      prompt_tokens: 200,
      completion_tokens: 100,
      latency_ms: 125,
      ts: 2_000,
    });
    agent.db.recordTokenUsage({
      group_jid: 'group-2@g.us',
      session_id: 'session-b',
      model: 'claude-opus-4-6',
      prompt_tokens: 300,
      completion_tokens: 150,
      latency_ms: 150,
      ts: 3_000,
    });
  }

  async function callSummary(payload?: Record<string, unknown>) {
    const res = await fetch(`${url}/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'usage_get_summary',
        payload,
      }),
    });
    const json = (await res.json()) as {
      result: {
        total_tokens: number;
        prompt_tokens: number;
        completion_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        total_cost_usd: number | null;
        request_count: number;
        by_model: Array<{
          model: string;
          request_count: number;
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cost_usd: number | null;
        }>;
        by_session: Array<{
          session_id: string | null;
          request_count: number;
          total_tokens: number;
          cost_usd: number | null;
        }>;
      };
    };
    return { status: res.status, result: json.result };
  }

  it('returns all rows when no filters are provided', async () => {
    seedUsageRows();

    const response = await callSummary();
    expect(response.status).toBe(200);
    expect(response.result).toMatchObject({
      total_tokens: 900,
      prompt_tokens: 600,
      completion_tokens: 300,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      request_count: 3,
    });
    expect(response.result.total_cost_usd).toBeCloseTo(0.01892175);

    const bySessionA = response.result.by_session.find(
      (row) => row.session_id === 'session-a',
    );
    const bySessionB = response.result.by_session.find(
      (row) => row.session_id === 'session-b',
    );
    expect(bySessionA).toMatchObject({
      session_id: 'session-a',
      request_count: 2,
      total_tokens: 450,
    });
    expect(bySessionA?.cost_usd).toBeCloseTo(0.00317175);
    expect(bySessionB).toMatchObject({
      session_id: 'session-b',
      request_count: 1,
      total_tokens: 450,
    });
    expect(bySessionB?.cost_usd).toBeCloseTo(0.01575);
  });

  it('filters rows by group_jid', async () => {
    seedUsageRows();

    const response = await callSummary({ group_jid: 'group-1@g.us' });
    expect(response.status).toBe(200);
    expect(response.result).toMatchObject({
      total_tokens: 450,
      prompt_tokens: 300,
      completion_tokens: 150,
      request_count: 2,
    });
    expect(response.result.total_cost_usd).toBeCloseTo(0.00317175);
    expect(response.result.by_model).toHaveLength(1);
    expect(response.result.by_model[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      request_count: 2,
      total_tokens: 450,
    });
  });

  it('filters rows by since timestamp', async () => {
    seedUsageRows();

    const response = await callSummary({ since: 1_500 });
    expect(response.status).toBe(200);
    expect(response.result).toMatchObject({
      total_tokens: 750,
      prompt_tokens: 500,
      completion_tokens: 250,
      request_count: 2,
    });
    expect(response.result.total_cost_usd).toBeCloseTo(0.01785);
  });

  it('returns the correct by_model breakdown', async () => {
    seedUsageRows();

    const response = await callSummary();
    expect(response.status).toBe(200);

    const sonnet = response.result.by_model.find(
      (row) => row.model === 'claude-sonnet-4-6',
    );
    const opus = response.result.by_model.find(
      (row) => row.model === 'claude-opus-4-6',
    );

    expect(sonnet).toMatchObject({
      model: 'claude-sonnet-4-6',
      request_count: 2,
      prompt_tokens: 300,
      completion_tokens: 150,
      total_tokens: 450,
    });
    expect(sonnet?.cost_usd).toBeCloseTo(0.00317175);

    expect(opus).toMatchObject({
      model: 'claude-opus-4-6',
      request_count: 1,
      prompt_tokens: 300,
      completion_tokens: 150,
      total_tokens: 450,
    });
    expect(opus?.cost_usd).toBeCloseTo(0.01575);
  });
});
