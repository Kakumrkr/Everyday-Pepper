import type { CaseResult } from './runner.js';
import { summarize } from './runner.js';

export interface ReportContext {
  provider: string;
  trials: number;
  /** Actual cost when prices are known; `null` for free runs (fakes, cassettes). */
  costUsd: number | null;
  startedAt: string;
}

const percent = (rate: number) => `${(rate * 100).toFixed(0)}%`;

/** The eval report as Markdown: sets against their gates, then every failing case. */
export function markdownReport(results: readonly CaseResult[], context: ReportContext): string {
  const summary = summarize(results);
  const lines = [
    '# Pepper eval report',
    '',
    `- Provider: ${context.provider} · trials per case (pass^k): ${String(context.trials)} · started ${context.startedAt}`,
    `- Tokens: ${String(summary.usage.inputTokens)} in (${String(summary.usage.cachedInputTokens)} cached), ${String(summary.usage.outputTokens)} out · cost: ${context.costUsd === null ? '$0 (no real calls)' : `$${context.costUsd.toFixed(4)}`}`,
    `- Result: **${summary.meetsGates ? 'all gates met' : 'gates NOT met'}**`,
    '',
    '| Set | Passed | Rate | Gate |',
    '|---|---|---|---|',
    ...summary.sets.map(
      (set) =>
        `| ${set.set} | ${String(set.passed)}/${String(set.cases)} | ${percent(set.rate)} | ${percent(set.gate)} ${set.meetsGate ? '✅' : '❌'} |`,
    ),
  ];
  const failing = results.filter((result) => !result.passed);
  if (failing.length > 0) {
    lines.push('', '## Failing cases', '');
    for (const result of failing) {
      lines.push(`- **${result.id}** (${result.set}${result.holdout ? ', holdout' : ''})`);
      result.trials.forEach((trial, index) => {
        if (!trial.passed) {
          lines.push(`  - trial ${String(index + 1)}: ${trial.reasons.join('; ')}`);
        }
      });
    }
  }
  return `${lines.join('\n')}\n`;
}
