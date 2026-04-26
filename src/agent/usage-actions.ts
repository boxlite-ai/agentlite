import { z } from 'zod';

import type { ActionContext } from '../api/action.js';
import type { Agent } from '../api/agent.js';
import type { AgentDb, TokenUsageSummaryFilters } from '../db.js';

export function registerUsageActions(agent: Agent, db: AgentDb): void {
  agent.action(
    'usage_get_summary',
    'Return aggregated token usage, cost, and per-model/session breakdowns from the local runtime store.',
    {
      group_jid: z
        .string()
        .optional()
        .describe('Filter to a specific group or channel JID'),
      model: z
        .string()
        .optional()
        .describe('Filter to a specific model identifier'),
      since: z
        .number()
        .int()
        .optional()
        .describe(
          'Only include rows with a timestamp strictly greater than this Unix timestamp in milliseconds',
        ),
    },
    async (args, ctx) =>
      db.getTokenUsageSummary(scopeUsageSummaryFilters(args, ctx, db)),
  );
}

function scopeUsageSummaryFilters(
  args: TokenUsageSummaryFilters,
  ctx: ActionContext,
  db: AgentDb,
): TokenUsageSummaryFilters {
  if (ctx.isMain) {
    return args;
  }

  const allowedJids = Object.entries(db.getAllRegisteredGroups())
    .filter(([, group]) => group.folder === ctx.sourceGroup)
    .map(([jid]) => jid);

  if (args.group_jid) {
    return {
      ...args,
      group_jids: allowedJids.includes(args.group_jid) ? [args.group_jid] : [],
      group_jid: undefined,
    };
  }

  return {
    ...args,
    group_jids: allowedJids,
  };
}
