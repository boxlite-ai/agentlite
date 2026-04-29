import {
  AGENT_BACKEND_TYPES,
  type AgentBackendOptions,
  type AgentBackendType,
} from '../api/options.js';

export const DEFAULT_AGENT_BACKEND_OPTIONS: AgentBackendOptions = {
  type: 'claudeCode',
};

export { AGENT_BACKEND_TYPES };
export type { AgentBackendOptions, AgentBackendType };

export function isAgentBackendType(value: unknown): value is AgentBackendType {
  return AGENT_BACKEND_TYPES.some((backendType) => backendType === value);
}

export function normalizeAgentBackendOptions(
  value: unknown,
): AgentBackendOptions {
  if (value === undefined || value === null) {
    return { ...DEFAULT_AGENT_BACKEND_OPTIONS };
  }

  if (
    value &&
    typeof value === 'object' &&
    'type' in value &&
    isAgentBackendType(value.type)
  ) {
    const backend = value as { type: AgentBackendType; model?: unknown };
    const model =
      typeof backend.model === 'string' && backend.model.trim()
        ? backend.model.trim()
        : undefined;
    return model ? { type: backend.type, model } : { type: backend.type };
  }

  throw new Error(
    `Invalid agent backend "${String(value)}"; expected { type: ${AGENT_BACKEND_TYPES.join(' | ')} }`,
  );
}
