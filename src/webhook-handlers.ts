/**
 * Built-in webhook payload handlers for GitHub, Slack, and generic events.
 */

export type WebhookSource = 'github' | 'slack' | 'generic';

/** Detects the source of a webhook from request headers and body. */
export function detectSource(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): WebhookSource {
  const githubEvent = headers['x-github-event'];
  if (githubEvent) return 'github';

  const slackSig = headers['x-slack-signature'];
  if (slackSig) return 'slack';

  if (body && typeof body === 'object' && 'command' in body) return 'slack';

  return 'generic';
}

/** Format a GitHub pull_request event as a human-readable message. */
function formatGitHubPr(body: Record<string, unknown>): string {
  const pr = body['pull_request'] as Record<string, unknown> | undefined;
  const repo = body['repository'] as Record<string, unknown> | undefined;
  const action = (body['action'] as string | undefined) ?? 'unknown';

  const number = pr?.['number'] ?? '?';
  const title = (pr?.['title'] as string | undefined) ?? '(no title)';
  const login =
    (pr?.['user'] as Record<string, unknown> | undefined)?.['login'] ?? '?';
  const htmlUrl = (pr?.['html_url'] as string | undefined) ?? '';
  const repoName = (repo?.['full_name'] as string | undefined) ?? '?';

  return [
    `GitHub PR #${number} ${action}: ${title}`,
    `Repo: ${repoName}`,
    `Author: ${login}`,
    `URL: ${htmlUrl}`,
  ].join('\n');
}

/** Format a Slack slash command body as a human-readable message. */
function formatSlashCommand(body: Record<string, unknown>): string {
  const command = (body['command'] as string | undefined) ?? '?';
  const text = (body['text'] as string | undefined) ?? '';
  const userName = (body['user_name'] as string | undefined) ?? '?';
  const channelName = (body['channel_name'] as string | undefined) ?? '?';

  return [
    `Slack slash command: ${command} ${text}`.trim(),
    `User: ${userName} in #${channelName}`,
  ].join('\n');
}

/** Format a generic event body as a human-readable message. */
function formatGeneric(
  eventType: string | undefined,
  body: Record<string, unknown>,
): string {
  return [
    `Webhook event: ${eventType ?? 'unknown'}`,
    JSON.stringify(body, null, 2),
  ].join('\n');
}

/**
 * Transform an incoming webhook payload into a formatted string suitable for
 * injecting into an agent group chat.
 */
export function formatWebhookPayload(
  source: WebhookSource,
  eventType: string | undefined,
  body: Record<string, unknown>,
): string {
  switch (source) {
    case 'github': {
      if (eventType === 'pull_request') {
        return formatGitHubPr(body);
      }
      return formatGeneric(eventType, body);
    }
    case 'slack':
      return formatSlashCommand(body);
    default:
      return formatGeneric(eventType, body);
  }
}
