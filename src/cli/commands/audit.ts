import { Command } from 'commander';
import chalk from 'chalk';
import { runMigrations } from '../../db/migrate';
import { getAllSessions } from '../../memory/session';
import { getAuditLog } from '../../memory/audit';

export function auditCommand(): Command {
  return new Command('audit')
    .description('Show the full audit trail for a work item session')
    .argument('<workItemId>', 'Work item ID')
    .option('--json', 'Output as JSON')
    .action((workItemIdStr: string, opts) => {
      runMigrations();

      const workItemId = parseInt(workItemIdStr, 10);
      const sessions = getAllSessions().filter((s) => s.workItemId === workItemId);

      if (sessions.length === 0) {
        console.log(chalk.yellow(`No sessions found for WI #${workItemId}`));
        return;
      }

      const session = sessions[sessions.length - 1];
      const events = getAuditLog(session.id);

      if (opts.json) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }

      console.log(chalk.bold(`\n  myworkbuddy · Audit Trail · WI #${workItemId}`));
      console.log('  ' + '─'.repeat(85));
      console.log(chalk.gray(`  ${'Time'.padEnd(8)} ${'Phase'.padEnd(14)} ${'Agent'.padEnd(18)} ${'Event'.padEnd(14)} Message`));
      console.log('  ' + '─'.repeat(85));

      const start = events[0]?.timestamp ?? Date.now();
      for (const e of events) {
        const elapsed = Math.floor((e.timestamp - start) / 1000);
        const mm = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const ss = (elapsed % 60).toString().padStart(2, '0');
        const time = `${mm}:${ss}`;

        const eventColor = e.eventType === 'error' ? chalk.red
          : e.eventType === 'decision' ? chalk.cyan
          : e.eventType === 'state_change' ? chalk.yellow
          : e.eventType === 'tool_call' ? chalk.gray
          : chalk.white;

        console.log(
          `  ${chalk.gray(time.padEnd(8))} ${e.phase.padEnd(14)} ${e.agent.slice(0, 17).padEnd(18)} ${eventColor(e.eventType.padEnd(14))} ${e.message.slice(0, 55)}`,
        );
      }

      console.log('  ' + '─'.repeat(85));
      console.log(chalk.gray(`  ${events.length} events  ·  Use --json for machine-readable output\n`));
    });
}
