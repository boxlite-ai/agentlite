import { z } from 'zod';

import type { Agent } from '../api/agent.js';
import type { ActionContext } from '../api/action.js';
import type { AgentDb } from '../db.js';
import type { RegisteredGroup } from '../types.js';

type MemoryDb = Pick<AgentDb, 'memoryGet' | 'memorySet' | 'memoryList'>;

export interface MemoryActionDeps {
  db: MemoryDb;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
}

function resolveSourceGroupJid(
  ctx: ActionContext,
  registeredGroups: Record<string, RegisteredGroup>,
): string {
  if (ctx.jid) {
    const group = registeredGroups[ctx.jid];
    if (group?.folder === ctx.sourceGroup) {
      return ctx.jid;
    }
  }

  const matches = Object.entries(registeredGroups)
    .filter(([, group]) => group.folder === ctx.sourceGroup)
    .map(([jid]) => jid);

  if (matches.length === 1) {
    return matches[0]!;
  }

  throw new Error(
    `cannot resolve agent memory target for group folder "${ctx.sourceGroup}"`,
  );
}

export function createMemoryActionHandlers(deps: MemoryActionDeps) {
  return {
    memoryGet: async (
      args: { key: string },
      ctx: ActionContext,
    ): Promise<{ value: string | null }> => {
      const jid = resolveSourceGroupJid(ctx, deps.getRegisteredGroups());
      return { value: deps.db.memoryGet(jid, args.key) };
    },

    memorySet: async (
      args: { key: string; value?: string | null },
      ctx: ActionContext,
    ): Promise<Record<string, never>> => {
      const jid = resolveSourceGroupJid(ctx, deps.getRegisteredGroups());
      deps.db.memorySet(jid, args.key, args.value ?? null);
      return {};
    },

    memoryList: async (
      _args: Record<string, never>,
      ctx: ActionContext,
    ): Promise<{ entries: Array<{ key: string; value: string | null }> }> => {
      const jid = resolveSourceGroupJid(ctx, deps.getRegisteredGroups());
      return { entries: deps.db.memoryList(jid) };
    },
  };
}

export function registerMemoryActions(
  agent: Agent,
  deps: MemoryActionDeps,
): void {
  const handlers = createMemoryActionHandlers(deps);

  agent.action(
    'memory_get',
    'Get a persisted memory value for the caller group.',
    { key: z.string() },
    handlers.memoryGet,
  );

  agent.action(
    'memory_set',
    'Set or delete a persisted memory value for the caller group.',
    {
      key: z.string(),
      value: z.string().nullable().optional(),
    },
    handlers.memorySet,
  );

  agent.action(
    'memory_list',
    'List persisted memory entries for the caller group.',
    {},
    handlers.memoryList,
  );
}
