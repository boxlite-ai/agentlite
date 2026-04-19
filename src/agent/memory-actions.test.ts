import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionContext } from '../api/action.js';
import { _initTestDatabase, AgentDb } from '../db.js';
import { createMemoryActionHandlers } from './memory-actions.js';

let db: AgentDb;

beforeEach(() => {
  db = _initTestDatabase();
});

describe('AgentDb memory store', () => {
  it('memoryGet returns null for a missing key', () => {
    expect(db.memoryGet('group-a@g.us', 'topic')).toBeNull();
  });

  it('memoryGet returns the stored value after memorySet', () => {
    db.memorySet('group-a@g.us', 'topic', 'roadmap');

    expect(db.memoryGet('group-a@g.us', 'topic')).toBe('roadmap');
  });

  it('memorySet with null deletes the key', () => {
    db.memorySet('group-a@g.us', 'topic', 'roadmap');
    db.memorySet('group-a@g.us', 'topic', null);

    expect(db.memoryGet('group-a@g.us', 'topic')).toBeNull();
  });

  it('memoryList returns all entries for a group and empty for an unknown group', () => {
    db.memorySet('group-a@g.us', 'beta', 'two');
    db.memorySet('group-a@g.us', 'alpha', 'one');
    db.memorySet('group-b@g.us', 'alpha', 'other');

    expect(db.memoryList('group-a@g.us')).toEqual([
      { key: 'alpha', value: 'one' },
      { key: 'beta', value: 'two' },
    ]);
    expect(db.memoryList('missing@g.us')).toEqual([]);
  });

  it('scopes keys per group_jid', () => {
    db.memorySet('group-a@g.us', 'shared', 'alpha');
    db.memorySet('group-b@g.us', 'shared', 'beta');

    expect(db.memoryGet('group-a@g.us', 'shared')).toBe('alpha');
    expect(db.memoryGet('group-b@g.us', 'shared')).toBe('beta');
  });
});

describe('memory actions', () => {
  const groups = {
    'alpha@g.us': {
      name: 'Alpha',
      folder: 'team-alpha',
      trigger: '@TestBot',
      added_at: '2024-01-01T00:00:00.000Z',
    },
    'beta@g.us': {
      name: 'Beta',
      folder: 'team-beta',
      trigger: '@TestBot',
      added_at: '2024-01-01T00:00:00.000Z',
    },
  };

  function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
    return {
      jid: undefined,
      sourceGroup: 'team-alpha',
      isMain: false,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      ...overrides,
    };
  }

  it('memory_get returns null for an unknown key', async () => {
    const mockDb = {
      memoryGet: vi.fn().mockReturnValue(null),
      memorySet: vi.fn(),
      memoryList: vi.fn(),
    };
    const handlers = createMemoryActionHandlers({
      db: mockDb,
      getRegisteredGroups: () => groups,
    });

    const result = await handlers.memoryGet(
      { key: 'topic' },
      makeCtx({ jid: 'alpha@g.us' }),
    );

    expect(mockDb.memoryGet).toHaveBeenCalledWith('alpha@g.us', 'topic');
    expect(result).toEqual({ value: null });
  });

  it('memory_get falls back to the unique sourceGroup match when ctx.jid is absent', async () => {
    const mockDb = {
      memoryGet: vi.fn().mockReturnValue('roadmap'),
      memorySet: vi.fn(),
      memoryList: vi.fn(),
    };
    const handlers = createMemoryActionHandlers({
      db: mockDb,
      getRegisteredGroups: () => groups,
    });

    const result = await handlers.memoryGet({ key: 'topic' }, makeCtx());

    expect(mockDb.memoryGet).toHaveBeenCalledWith('alpha@g.us', 'topic');
    expect(result).toEqual({ value: 'roadmap' });
  });

  it('memory_set with value=null deletes the key', async () => {
    const mockDb = {
      memoryGet: vi.fn(),
      memorySet: vi.fn(),
      memoryList: vi.fn(),
    };
    const handlers = createMemoryActionHandlers({
      db: mockDb,
      getRegisteredGroups: () => groups,
    });

    const result = await handlers.memorySet(
      { key: 'topic', value: null },
      makeCtx({ jid: 'alpha@g.us' }),
    );

    expect(mockDb.memorySet).toHaveBeenCalledWith('alpha@g.us', 'topic', null);
    expect(result).toEqual({});
  });

  it('memory_list returns an empty list for a group with no entries', async () => {
    const mockDb = {
      memoryGet: vi.fn(),
      memorySet: vi.fn(),
      memoryList: vi.fn().mockReturnValue([]),
    };
    const handlers = createMemoryActionHandlers({
      db: mockDb,
      getRegisteredGroups: () => groups,
    });

    const result = await handlers.memoryList(
      {},
      makeCtx({ jid: 'alpha@g.us' }),
    );

    expect(mockDb.memoryList).toHaveBeenCalledWith('alpha@g.us');
    expect(result).toEqual({ entries: [] });
  });

  it('ignores a mismatched ctx.jid and resolves the caller from sourceGroup', async () => {
    const mockDb = {
      memoryGet: vi.fn(),
      memorySet: vi.fn(),
      memoryList: vi.fn().mockReturnValue([]),
    };
    const handlers = createMemoryActionHandlers({
      db: mockDb,
      getRegisteredGroups: () => groups,
    });

    await handlers.memoryList({}, makeCtx({ jid: 'beta@g.us' }));

    expect(mockDb.memoryList).toHaveBeenCalledWith('alpha@g.us');
  });
});
