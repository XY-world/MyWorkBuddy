import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../../config/manager';
import { runMigrations } from '../../db/migrate';
import { Orchestrator, SseEvent } from '../../agents/orchestrator';
import { banner, phaseBanner, statusBadge, agentLabel, printReviewResult } from '../../ui/formatters';
import { getTasksForSession } from '../../memory/tasks';

export function runCommand(): Command {
  return new Command('run')
    .description('Run the agent pipeline for a work item')
    .argument('<workItemId>', 'Azure DevOps work item ID')
    .option('--org <url>', 'ADO organization URL')
    .option('--project <name>', 'ADO project name')
    .option('--repo <name>', 'ADO repository name')
    .option('--dry-run', 'Plan only — no code changes or PR creation')
    .option('--repo-path <path>', 'Local path to repository clone')
    .action(async (workItemIdStr: string, opts) => {
      runMigrations();

      const workItemId = parseInt(workItemIdStr, 10);
      if (isNaN(workItemId)) {
        console.error(chalk.red('Error: workItemId must be a number'));
        process.exit(1);
      }

      const cfg = getConfig();
      if (!cfg.isConfigured()) {
        console.error(chalk.red('myworkbuddy is not configured. Run: myworkbuddy init'));
        process.exit(1);
      }

      banner(`Work Item #${workItemId}`, opts.dryRun ? 'DRY RUN — plan only' : 'via GitHub Copilot CLI');

      const orch = new Orchestrator();
      let sessionId: number | undefined;
      const startTime = Date.now();

      orch.on('event', (e: SseEvent) => {
        switch (e.type) {
          case 'phase_change':
            phaseBanner(`PHASE: ${e.phase.toUpperCase()}`);
            break;

          case 'task_update':
            if (e.status === 'running') {
              process.stdout.write(`  ${chalk.yellow('↻')}  ${e.message}\n`);
            } else if (e.status === 'done') {
              process.stdout.write(`  ${chalk.green('✔')}  ${chalk.gray(e.message)}\n`);
            } else if (e.status === 'failed') {
              process.stdout.write(`  ${chalk.red('✖')}  ${chalk.red(e.message)}\n`);
            }
            break;

          case 'agent_complete':
            console.log(chalk.gray(`\n  Agent complete: ${e.agent} — ${e.summary}`));
            break;

          case 'review_result':
            break; // printed separately

          case 'pr_created':
            console.log(`\n  ${chalk.green('✔')} PR created: ${chalk.cyan(e.prUrl)}`);
            break;

          case 'error':
            console.log(`\n  ${chalk.red('✖')} Error in ${e.phase}: ${e.message}`);
            break;

          case 'session_complete':
            // summary printed below
            break;
        }
      });

      try {
        await orch.run({
          workItemId,
          project: opts.project,
          repo: opts.repo,
          orgUrl: opts.org,
          repoLocalPath: opts.repoPath,
          dryRun: opts.dryRun,
        });
      } catch (err: any) {
        console.error(`\n${chalk.red('✖')} Pipeline failed: ${err.message}`);
        process.exit(1);
      }

      // Print completion summary
      const elapsed = Date.now() - startTime;
      const mm = Math.floor(elapsed / 60000).toString().padStart(2, '0');
      const ss = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');

      console.log(chalk.gray('\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(`  ${chalk.green('✔')}  ${chalk.bold('myworkbuddy COMPLETE')}  ·  Total time: ${mm}:${ss}`);
      console.log(chalk.gray('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
      console.log(chalk.gray(`  Run ${chalk.cyan(`myworkbuddy audit ${workItemId}`)} to see the full audit trail.`));
      console.log(chalk.gray(`  Run ${chalk.cyan('myworkbuddy web')} for the visual pipeline dashboard.\n`));
    });
}
