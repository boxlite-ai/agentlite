import type { RegisteredAction } from '../api/action.js';
import {
  codeRun,
  codeRunInputSchema,
  prePullSandboxImages,
} from './code-run.js';

export function registerBuiltinActions(
  actions: Map<string, RegisteredAction>,
): void {
  actions.set('code_run', {
    description:
      'Execute JavaScript, TypeScript, Python, or shell code in an isolated Docker sandbox with no network access.',
    inputSchema: codeRunInputSchema,
    handler: async (args) =>
      codeRun(args as unknown as Parameters<typeof codeRun>[0]),
  });
}

export function prePullCodeRunImages(): void {
  void prePullSandboxImages().catch(console.error);
}

export {
  SANDBOX_IMAGES,
  codeRun,
  prePullSandboxImages,
  runCode,
} from './code-run.js';
export type { CodeRunInput, CodeRunOutput } from './code-run.js';
