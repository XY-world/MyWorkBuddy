import { Command } from 'commander';
import chalk from 'chalk';
import { runMigrations } from '../../db/migrate';

export function webCommand(): Command {
  return new Command('web')
    .description('Start the local web dashboard')
    .option('--port <number>', 'Port to listen on', '3000')
    .option('--no-open', 'Do not auto-open browser')
    .action(async (opts) => {
      runMigrations();
      const port = parseInt(opts.port, 10);

      // Dynamically import to avoid loading web server unless needed
      const { startWebServer } = await import('../../web-server/server');
      await startWebServer(port, opts.open !== false);

      console.log(chalk.bold(`\n  myworkbuddy web dashboard`));
      console.log(chalk.cyan(`  → http://localhost:${port}\n`));
      console.log(chalk.gray('  Press Ctrl+C to stop\n'));
    });
}
