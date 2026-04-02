import { Command } from 'commander';
import { initCommand } from './commands/init';
import { runCommand } from './commands/run';
import { statusCommand } from './commands/status';
import { auditCommand } from './commands/audit';
import { listCommand } from './commands/list';
import { retryCommand } from './commands/retry';
import { configCommand } from './commands/config';
import { webCommand } from './commands/web';

const program = new Command();

program
  .name('myworkbuddy')
  .description('Autonomous coding agent for Azure DevOps work items')
  .version('0.1.0');

program.addCommand(initCommand());
program.addCommand(runCommand());
program.addCommand(statusCommand());
program.addCommand(auditCommand());
program.addCommand(listCommand());
program.addCommand(retryCommand());
program.addCommand(configCommand());
program.addCommand(webCommand());

program.parse(process.argv);
