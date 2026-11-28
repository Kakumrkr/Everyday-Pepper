import { READING_LABELS } from './case.js';
import type { CaseResult, SetSummary } from './runner.js';
import { summarize } from './runner.js';

export interface ReportContext {
  provider: string;
  trials: number;
  /** Actual cost when prices are known; `null` for free runs (fakes, cassettes). */
  costUsd: number | null;
  startedAt: string;
}

const percent = (rate: number) => `${(rate * 100).toFixed(0)}%`;
const maybePercent = (rate: number | null) => (rate === null ? '–' : percent(rate));

/**
 * A classifier set's labels against their gates, its false confirms, and its confusion table:
 * expected labels down, read labels across (S81a, AC-X-239).
 */
function classifierLines(set: SetSummary): string[] {
  const classifier = set.classifier;
  if (classifier === undefined) return [];
  const rows = READING_LABELS.filter((label) => classifier.confusion[label] !== undefined);
  const columns = READING_LABELS.filter((label) =>
    rows.some((row) => (classifier.confusion[row]?.[label] ?? 0) > 0),
  );
  return [
    '',
    `## ${set.set}: labels`,
    '',
    `- False confirms (read as confirm where none was expected): ${String(classifier.falseConfirms)} ${classifier.falseConfirms === 0 ? '✅' : '❌'}`,
    '',
    '| Label | Expected | Read | Precision | Recall | Gate (P / R) |',
    '|---|---|---|---|---|---|',
    ...classifier.labels.map(
      (label) =>
        `| ${label.label} | ${String(label.expected)} | ${String(label.read)} | ${maybePercent(label.precision)} | ${maybePercent(label.recall)} | ${percent(label.gate.precision)} / ${percent(label.gate.recall)} ${label.meetsGate ? '✅' : '❌'} |`,
    ),
    // No reading at all (every trial failed before one): no confusion to show.
    ...(rows.length === 0
      ? []
      : [
          '',
          `| Expected ↓ / read → | ${columns.join(' | ')} |`,
          `|---|${columns.map(() => '---|').join('')}`,
          ...rows.map(
            (row) =>
              `| ${row} | ${columns.map((column) => String(classifier.confusion[row]?.[column] ?? 0)).join(' | ')} |`,
          ),
        ]),
  ];
}

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
  for (const set of summary.sets) lines.push(...classifierLines(set));
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
