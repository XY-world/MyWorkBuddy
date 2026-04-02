import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig } from '../../config/manager';

export function configCommand(): Command {
  const cmd = new Command('config').description('Manage myworkbuddy configuration');

  cmd.command('list')
    .description('Show all configuration values')
    .action(() => {
      const cfg = getConfig().getAll();
      console.log(chalk.bold('\n  myworkbuddy · Configuration\n'));
      const print = (key: string, val: string) =>
        console.log(`  ${chalk.gray(key.padEnd(30))} ${val}`);
      print('ado.orgUrl', cfg.ado.orgUrl || chalk.gray('(not set)'));
      print('ado.wiProject', cfg.ado.wiProject || chalk.gray('(not set)'));
      print('ado.codeProject', cfg.ado.codeProject || chalk.gray('(not set)'));
      print('ado.defaultRepo', cfg.ado.defaultRepo || chalk.gray('(not set)'));
      print('ado.auth', chalk.green('DefaultAzureCredential (az login)'));
      print('copilot.auth', chalk.green('VSCode Copilot / gh auth login'));
      print('agent.maxReviewRetries', String(cfg.agent.maxReviewRetries));
      print('agent.workDir', cfg.agent.workDir);
      print('keyVault.vaultUrl', cfg.keyVault.vaultUrl || chalk.gray('(disabled)'));
      console.log();
    });

  cmd.command('get <key>')
    .description('Get a config value')
    .action((key: string) => {
      const cfg = getConfig().getAll();
      const parts = key.split('.');
      let val: any = cfg;
      for (const p of parts) val = val?.[p];
      console.log(val ?? chalk.red('(not found)'));
    });

  cmd.command('set <key> <value>')
    .description('Set a config value')
    .action((key: string, value: string) => {
      const cfg = getConfig();
      const all = cfg.getAll() as any;
      const parts = key.split('.');
      let obj = all;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in obj)) { console.error(chalk.red(`Key not found: ${key}`)); process.exit(1); }
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      cfg.update(all);
      cfg.save();
      console.log(chalk.green(`✔ Set ${key} = ${value}`));
    });

  return cmd;
}
