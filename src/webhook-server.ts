/**
 * WebhookServer — local HTTP server that lets external systems trigger agents
 * by POSTing JSON payloads.
 *
 * Endpoint: POST /webhook/:group_jid
 *
 * Auth: If `config.secret` is set, the request must include a valid
 * `X-Hub-Signature-256` header (sha256=<hex(HMAC-SHA256(secret, rawBody))>).
 * Matches GitHub's webhook signature format for out-of-the-box compatibility.
 *
 * Body limit: 1 MB. Returns 413 if exceeded.
 *
 * If no secret is configured, a warning is logged on start (not recommended
 * for production).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import type { WebhookConfig } from './api/options.js';
import { detectSource, formatWebhookPayload } from './webhook-handlers.js';

const BODY_LIMIT_BYTES = 1024 * 1024; // 1 MB

export class WebhookServer {
  private server: http.Server | null = null;
  private port: number | null = null;

  constructor(
    private readonly config: WebhookConfig,
    private readonly onWebhook: (jid: string, content: string) => void,
    private readonly getRegisteredGroups: () => Set<string>,
  ) {}

  /** The actual port the server is listening on (available after start()). */
  get listenPort(): number {
    if (this.port === null) throw new Error('WebhookServer not started');
    return this.port;
  }

  async start(): Promise<void> {
    if (!this.config.secret) {
      logger.warn(
        '[WebhookServer] No secret configured — HMAC signature verification is disabled. Not recommended for production.',
      );
    }

    const host = this.config.host ?? '127.0.0.1';
    const port = this.config.port ?? 3456;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, '[WebhookServer] Unhandled request error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve());
      this.server!.once('error', reject);
    });

    const addr = this.server.address();
    this.port =
      addr && typeof addr === 'object' ? addr.port : (port as number);

    logger.info(
      { host, port: this.port },
      '[WebhookServer] Listening for webhook events',
    );
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
    this.port = null;
    logger.info('[WebhookServer] Stopped');
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Only POST /webhook/:group_jid is supported
    const url = req.url ?? '';
    const match = url.match(/^\/webhook\/([^/?#]+)/);

    if (req.method !== 'POST' || !match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    const pathJid = decodeURIComponent(match[1]);

    // Read body with size limit
    const rawBody = await this.readBody(req);
    if (rawBody === null) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
      return;
    }

    // HMAC verification
    if (this.config.secret) {
      const signature =
        (req.headers['x-hub-signature-256'] as string | undefined) ?? '';
      if (!this.verifySignature(this.config.secret, rawBody, signature)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: 'Invalid or missing signature' }),
        );
        return;
      }
    }

    // Parse JSON
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }

    // Determine event type from headers
    const eventType =
      (req.headers['x-event-type'] as string | undefined) ??
      (req.headers['x-github-event'] as string | undefined) ??
      (req.headers['x-slack-event'] as string | undefined);

    // Resolve target JID: check routes first, fall back to path JID
    const targetJid = this.resolveJid(eventType, pathJid);

    // Validate target JID is a registered group
    const registeredGroups = this.getRegisteredGroups();
    if (!registeredGroups.has(targetJid)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unknown group JID' }));
      return;
    }

    // Transform payload
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = v;
    }
    const source = detectSource(headers, body);
    const message = formatWebhookPayload(source, eventType, body);

    // Inject into agent
    this.onWebhook(targetJid, message);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private resolveJid(
    eventType: string | undefined,
    pathJid: string,
  ): string {
    if (eventType && this.config.routes) {
      const route = this.config.routes.find((r) => r.eventType === eventType);
      if (route) return route.targetJid;
    }
    return pathJid;
  }

  private verifySignature(
    secret: string,
    rawBody: Buffer,
    provided: string,
  ): boolean {
    if (!provided) return false;
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'utf8'),
        Buffer.from(provided, 'utf8'),
      );
    } catch {
      return false;
    }
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLarge = false;
      let settled = false;

      const settle = (val: Buffer | null) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };

      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        totalBytes += chunk.length;
        if (totalBytes > BODY_LIMIT_BYTES) {
          tooLarge = true;
          // Drain the remaining data so the socket stays usable for the response.
          req.resume();
          settle(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (!tooLarge) settle(Buffer.concat(chunks));
      });

      req.on('error', () => settle(null));
    });
  }
}
