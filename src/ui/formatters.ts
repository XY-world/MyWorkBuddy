import chalk from 'chalk';

export function banner(title: string, subtitle?: string): void {
  const line = '═'.repeat(66);
  console.log(chalk.cyan(`╔${line}╗`));
  console.log(chalk.cyan('║') + chalk.bold.white(` myworkbuddy  ·  ${title}`.padEnd(66)) + chalk.cyan('║'));
  if (subtitle) {
    console.log(chalk.cyan('║') + chalk.gray(` ${subtitle}`.padEnd(66)) + chalk.cyan('║'));
  }
  console.log(chalk.cyan(`╚${line}╝`));
}

export function phaseBanner(label: string, detail?: string): void {
  console.log(chalk.gray('\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`  ${chalk.bold.blue('▶')}  ${chalk.bold(label)}`);
  if (detail) console.log(chalk.gray(`     ${detail}`));
  console.log(chalk.gray('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
}

export function statusBadge(status: string): string {
  switch (status) {
    case 'done':      return chalk.green('✔');
    case 'running':   return chalk.yellow('↻');
    case 'failed':    return chalk.red('✖');
    case 'skipped':   return chalk.gray('-');
    case 'complete':  return chalk.green('✔');
    case 'active':    return chalk.yellow('↻');
    case 'paused':    return chalk.yellow('⏸');
    default:          return chalk.gray('○');
  }
}

export function agentLabel(agent: string): string {
  switch (agent) {
    case 'pm':     return chalk.blue('[PM / Alex]   ');
    case 'dev':    return chalk.green('[Dev / Morgan]');
    case 'review': return chalk.magenta('[Rev / Jordan]');
    default:       return chalk.gray(`[${agent}]`);
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

export function printReviewResult(result: { approved: boolean; overallScore: number; comments: any[]; requestedChanges: string[] }): void {
  const line = '─'.repeat(62);
  const verdict = result.approved
    ? chalk.green(`APPROVED  (score: ${result.overallScore}/10)`)
    : chalk.yellow(`CHANGES REQUESTED  (score: ${result.overallScore}/10)`);

  console.log(`\n  ┌─ ${chalk.bold('REVIEW RESULT')} ${'─'.repeat(46)}┐`);
  console.log(`  │  ${verdict.padEnd(70)}│`);
  if (result.comments.length > 0) {
    console.log(`  │${''.padEnd(64)}│`);
    for (const c of result.comments.slice(0, 5)) {
      const loc = c.line ? `${c.file}:${c.line}` : c.file;
      console.log(`  │  ${chalk.yellow('⚠')}  ${chalk.gray(loc)}`.padEnd(65) + '│');
      console.log(`  │     ${c.comment.slice(0, 57)}`.padEnd(65) + '│');
    }
  }
  console.log(`  └${'─'.repeat(64)}┘\n`);
}
