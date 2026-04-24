import { z } from 'zod';

import type { RegisteredAction } from '../api/action.js';
import type { CodeRunInput } from './code-run.js';

const MAX_TIMEOUT_MS = 30_000;

export const codeRunInputSchema = {
  language: z
    .enum(['javascript', 'typescript', 'python', 'bash'])
    .describe('Programming language for the provided code'),
  code: z.string().describe('Source code to execute'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe('Execution timeout in milliseconds, capped at 30000'),
};

export function registerBuiltinActions(
  actions: Map<string, RegisteredAction>,
): void {
  actions.set('code_run', {
    description:
      'Execute JavaScript, TypeScript, Python, or shell code in an isolated Docker sandbox with no network access.',
    inputSchema: codeRunInputSchema,
    handler: async (args) => {
      const { runCode } = await import('./code-run.js');
      return runCode(args as unknown as CodeRunInput);
    },
  });
}

export {
  prePullSandboxImages,
  pullImage,
  SANDBOX_IMAGES,
  startSandboxImagePrepull as prePullCodeRunImages,
} from './sandbox-images.js';
export type { CodeRunInput, CodeRunOutput } from './code-run.js';
