import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../../config/manager';
import { runMigrations } from '../../db/migrate';
import { getAllSessions, updateSessionPhase, updateSessionStatus } from '../../memory/session';
import { Orchestrator, SseEvent } from '../../agents/orchestrator';
import { Phase } from '../../memory/session';
import { banner, phaseBanner } from '../../ui/formatters';

const VALID_STAGES: Phase[] = ['planning', 'development', 'review', 'pr_creation'];

export function retryCommand(): Command {
  return new Command('retry')
    .description('Resume a session from a specific stage')
    .argument('<workItemId>', 'Work item ID')
    .option('--from-stage <stage>', 'Stage to resume from: planning|development|review|pr_creation', 'development')
    .action(async (workItemIdStr: string, opts) => {
      runMigrations();

      const workItemId = parseInt(workItemIdStr, 10);
      const stage = opts.fromStage as Phase;

      if (!VALID_STAGES.includes(stage)) {
        console.error(chalk.red(`Invalid stage "${stage}". Valid: ${VALID_STAGES.join(', ')}`));
        process.exit(1);
      }

      const sessions = getAllSessions().filter((s) => s.workItemId === workItemId);
      if (sessions.length === 0) {
        console.error(chalk.red(`No sessions found for WI #${workItemId}`));
        process.exit(1);
      }

      const session = sessions[sessions.length - 1];
      updateSessionPhase(session.id, stage);
      updateSessionStatus(session.id, 'active');

      console.log(chalk.gray(`\nResuming session ${session.id} for WI #${workItemId} from phase: ${stage}\n`));

      banner(`Work Item #${workItemId}`, `Resuming from: ${stage}`);

      const orch = new Orchestrator();
      orch.on('event', (e: SseEvent) => {
        if (e.type === 'phase_change') phaseBanner(`PHASE: ${e.phase.toUpperCase()}`);
        if (e.type === 'task_update' && e.status === 'done') console.log(`  ${chalk.green('✔')}  ${e.message}`);
        if (e.type === 'task_update' && e.status === 'failed') console.log(`  ${chalk.red('✖')}  ${e.message}`);
        if (e.type === 'pr_created') console.log(`\n  ${chalk.green('✔')} PR: ${chalk.cyan(e.prUrl)}`);
        if (e.type === 'error') console.log(`\n  ${chalk.red('✖')} ${e.message}`);
      });

      try {
        await orch.run({ workItemId, sessionId: session.id });
      } catch (err: any) {
        console.error(chalk.red(`\nRetry failed: ${err.message}`));
        process.exit(1);
      }
    });
}
