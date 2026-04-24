import { z } from 'zod';

import type { Agent } from '../api/agent.js';
import type { AgentDb } from '../db.js';

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
    async (args, ctx) => {
      const effectiveGroupJid = ctx.isMain ? args.group_jid : ctx.sourceGroup;
      const queryArgs = { ...args, group_jid: effectiveGroupJid };
      return db.getTokenUsageSummary(queryArgs);
    },
  );
}
