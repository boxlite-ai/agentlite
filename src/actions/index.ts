import type { RegisteredAction } from '../api/action.js';
import { codeRun, codeRunInputSchema } from './code-run.js';

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

export {
  SANDBOX_IMAGES,
  codeRun,
  prePullCodeRunImages,
  prePullSandboxImages,
  runCode,
} from './code-run.js';
export type { CodeRunInput, CodeRunOutput } from './code-run.js';
