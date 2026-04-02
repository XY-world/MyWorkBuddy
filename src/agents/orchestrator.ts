/**
 * @deprecated Use PipelineRunner from './pipeline-runner' instead.
 * This file is kept for backwards compatibility during transition.
 */

export { PipelineRunner as Orchestrator } from './pipeline-runner';
export type { PipelineRunnerOptions as OrchestratorOptions, SseEvent, PhaseCompleteSummary } from './pipeline-runner';
