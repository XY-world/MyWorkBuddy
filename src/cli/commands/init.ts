import { Command } from 'commander';
import * as readline from 'readline';
import chalk from 'chalk';
import { getConfig, CONFIG_PATH } from '../../config/manager';
import { initDb } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { banner } from '../../ui/formatters';

function prompt(rl: readline.Interface, question: string, defaultVal = ''): Promise<string> {
  return new Promise((resolve) => {
    const q = defaultVal ? `${question} ${chalk.gray(`[${defaultVal}]`)}: ` : `${question}: `;
    rl.question(q, (answer) => resolve(answer.trim() || defaultVal));
  });
}

export function initCommand(): Command {
  return new Command('init')
    .description('Interactive setup wizard — configure ADO, GitHub token, and initialize database')
    .action(async () => {
      banner('Setup Wizard');
      console.log(chalk.gray('\nThis wizard will configure myworkbuddy for your Azure DevOps environment.\n'));
      console.log(chalk.yellow('Auth: Uses your Azure identity (DefaultAzureCredential).'));
      console.log(chalk.gray('  → az login   (if not already authenticated)\n'));

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const cfg = getConfig();
      const existing = cfg.getAll();

      const orgUrl = await prompt(rl, 'ADO Organization URL (e.g. https://dev.azure.com/myorg)', existing.ado.orgUrl);
      const wiProject = await prompt(rl, 'Work-item ADO Project (where your work items live)', existing.ado.wiProject);
      const codeProject = await prompt(rl, 'Code ADO Project (where your repo lives)', existing.ado.codeProject || wiProject);
      const repo = await prompt(rl, 'Default ADO Repository', existing.ado.defaultRepo);
      const team = await prompt(rl, 'Team name (for sprint queries)', existing.ado.team ?? '');
      const workDir = await prompt(rl, 'Local workspace directory', existing.agent.workDir);

      rl.close();

      cfg.update({
        ado: { orgUrl, wiProject, codeProject, defaultRepo: repo, team: team || undefined },
        agent: { ...existing.agent, workDir },
        keyVault: existing.keyVault,
      });
      cfg.save();

      console.log(chalk.gray(`\nConfig saved to: ${CONFIG_PATH}`));

      // Initialize database
      process.stdout.write(chalk.gray('Initializing database... '));
      await initDb();
      runMigrations();
      console.log(chalk.green('✔'));

      console.log(`\n${chalk.green('✔')} myworkbuddy is ready!\n`);
      console.log(chalk.cyan('  myworkbuddy run <workItemId>   — start the agent pipeline'));
      console.log(chalk.cyan('  myworkbuddy web                — open the web dashboard'));
      console.log(chalk.cyan('  myworkbuddy --help             — see all commands\n'));
    });
}
