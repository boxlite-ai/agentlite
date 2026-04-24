/**
 * Tests for WebhookServer — auth, routing, handlers, lifecycle.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookServer } from './webhook-server.js';
import type { WebhookConfig } from './api/options.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REGISTERED_JIDS = new Set(['group-a@g.us', 'group-b@g.us']);

function makeServer(
  config: WebhookConfig,
  onWebhook?: (jid: string, content: string) => void,
): WebhookServer {
  return new WebhookServer(
    config,
    onWebhook ?? vi.fn(),
    () => new Set(REGISTERED_JIDS),
  );
}

function sign(secret: string, body: string): string {
  return (
    'sha256=' +
    crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')
  );
}

async function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhookServer', () => {
  let server: WebhookServer;

  afterEach(async () => {
    await server?.stop();
  });

  // 1. HMAC auth tests

  describe('HMAC auth', () => {
    const SECRET = 'test-secret';
    const JID = 'group-a@g.us';
    const BODY = JSON.stringify({ action: 'opened', pull_request: {} });

    beforeEach(async () => {
      server = makeServer({ port: 0, secret: SECRET });
      await server.start();
    });

    it('passes with a valid signature', async () => {
      const sig = sign(SECRET, BODY);
      const r = await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID)}`,
        BODY,
        { 'X-Hub-Signature-256': sig },
      );
      expect(r.status).toBe(200);
    });

    it('returns 401 with an invalid signature', async () => {
      const r = await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID)}`,
        BODY,
        { 'X-Hub-Signature-256': 'sha256=deadbeef' },
      );
      expect(r.status).toBe(401);
    });

    it('returns 401 with missing signature', async () => {
      const r = await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID)}`,
        BODY,
      );
      expect(r.status).toBe(401);
    });

    it('skips signature check when no secret is configured', async () => {
      const s = makeServer({ port: 0 });
      await s.start();
      try {
        const r = await post(
          s.listenPort,
          `/webhook/${encodeURIComponent(JID)}`,
          BODY,
        );
        expect(r.status).toBe(200);
      } finally {
        await s.stop();
      }
    });
  });

  // 2. Routing tests

  describe('routing', () => {
    const JID_A = 'group-a@g.us';
    const JID_B = 'group-b@g.us';
    const BODY = JSON.stringify({ hello: 'world' });

    it('uses URL path JID when no event header is present', async () => {
      const onWebhook = vi.fn();
      server = makeServer({ port: 0 }, onWebhook);
      await server.start();

      await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID_A)}`,
        BODY,
      );
      expect(onWebhook).toHaveBeenCalledWith(JID_A, expect.any(String));
    });

    it('overrides URL path JID via config.routes when event header matches', async () => {
      const onWebhook = vi.fn();
      server = makeServer(
        {
          port: 0,
          routes: [{ eventType: 'push', targetJid: JID_B }],
        },
        onWebhook,
      );
      await server.start();

      await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID_A)}`,
        BODY,
        { 'X-Event-Type': 'push' },
      );
      expect(onWebhook).toHaveBeenCalledWith(JID_B, expect.any(String));
    });

    it('falls back to URL path JID when routes are configured but no route matches', async () => {
      const onWebhook = vi.fn();
      server = makeServer(
        {
          port: 0,
          routes: [{ eventType: 'push', targetJid: JID_B }],
        },
        onWebhook,
      );
      await server.start();

      await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID_A)}`,
        BODY,
        { 'X-Event-Type': 'deployment' },
      );
      expect(onWebhook).toHaveBeenCalledWith(JID_A, expect.any(String));
    });

    it('returns 404 for an unknown JID', async () => {
      server = makeServer({ port: 0 });
      await server.start();

      const r = await post(
        server.listenPort,
        `/webhook/${encodeURIComponent('unknown@g.us')}`,
        BODY,
      );
      expect(r.status).toBe(404);
    });
  });

  // 3. GitHub PR handler

  describe('GitHub PR handler', () => {
    const JID = 'group-a@g.us';

    beforeEach(async () => {
      server = makeServer({ port: 0 });
      await server.start();
    });

    it('formats a pull_request event correctly', async () => {
      const onWebhook = vi.fn();
      const s = makeServer({ port: 0 }, onWebhook);
      await s.start();
      try {
        const body = JSON.stringify({
          action: 'opened',
          number: 42,
          pull_request: {
            number: 42,
            title: 'Add webhook support',
            html_url: 'https://github.com/example/repo/pull/42',
            user: { login: 'alice' },
          },
          repository: { full_name: 'example/repo' },
        });
        await post(
          s.listenPort,
          `/webhook/${encodeURIComponent(JID)}`,
          body,
          { 'X-GitHub-Event': 'pull_request' },
        );
        expect(onWebhook).toHaveBeenCalledWith(
          JID,
          expect.stringContaining('GitHub PR #42 opened: Add webhook support'),
        );
        const [, msg] = onWebhook.mock.calls[0] as [string, string];
        expect(msg).toContain('Repo: example/repo');
        expect(msg).toContain('Author: alice');
      } finally {
        await s.stop();
      }
    });
  });

  // 4. Slack slash command handler

  describe('Slack slash command handler', () => {
    const JID = 'group-a@g.us';

    it('formats a slash command body correctly', async () => {
      const onWebhook = vi.fn();
      server = makeServer({ port: 0 }, onWebhook);
      await server.start();

      const body = JSON.stringify({
        command: '/deploy',
        text: 'production',
        user_name: 'bob',
        channel_name: 'releases',
      });
      await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID)}`,
        body,
      );
      expect(onWebhook).toHaveBeenCalledWith(
        JID,
        expect.stringContaining('Slack slash command: /deploy production'),
      );
      const [, msg] = onWebhook.mock.calls[0] as [string, string];
      expect(msg).toContain('User: bob in #releases');
    });
  });

  // 5. Generic handler

  describe('generic handler', () => {
    const JID = 'group-a@g.us';

    it('passes through an unknown event type as JSON', async () => {
      const onWebhook = vi.fn();
      server = makeServer({ port: 0 }, onWebhook);
      await server.start();

      const body = JSON.stringify({ foo: 'bar' });
      await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID)}`,
        body,
        { 'X-Event-Type': 'custom_event' },
      );
      expect(onWebhook).toHaveBeenCalledWith(
        JID,
        expect.stringContaining('Webhook event: custom_event'),
      );
      const [, msg] = onWebhook.mock.calls[0] as [string, string];
      expect(msg).toContain('"foo": "bar"');
    });
  });

  // 6. Port config

  describe('port config', () => {
    it('binds to a kernel-assigned port when port: 0', async () => {
      server = makeServer({ port: 0 });
      await server.start();
      expect(server.listenPort).toBeGreaterThan(0);
    });
  });

  // 7. Body size limit

  describe('body size limit', () => {
    const JID = 'group-a@g.us';

    it('returns 413 for payloads larger than 1 MB', async () => {
      server = makeServer({ port: 0 });
      await server.start();

      // 1 MB + 1 byte of data (JSON string)
      const big = JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 100) });
      const r = await post(
        server.listenPort,
        `/webhook/${encodeURIComponent(JID)}`,
        big,
      );
      expect(r.status).toBe(413);
    });
  });

  // 8. Lifecycle

  describe('lifecycle', () => {
    it('starts and stops cleanly', async () => {
      server = makeServer({ port: 0 });
      await server.start();
      const port = server.listenPort;
      expect(port).toBeGreaterThan(0);
      await server.stop();

      // After stop, the port should be released (connecting should fail)
      await expect(
        new Promise<void>((resolve, reject) => {
          const req = http.request(
            { hostname: '127.0.0.1', port, method: 'GET', path: '/' },
            () => resolve(),
          );
          req.on('error', reject);
          req.end();
        }),
      ).rejects.toThrow();
    });
  });
});
