import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { parseReviewImportJsonl } from './nvidia-nim-review-import.mjs';

function usage() {
  return 'Usage: npm run review:apply-plan -- [--out apply-plan.md] reviews.jsonl';
}

export function parseApplyPlanArgs(args, cwd = process.cwd()) {
  let inputPath = null;
  let outputPath = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--out') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --out');
      }
      outputPath = resolveCliPath(value, cwd, '--out path');
      index += 1;
      continue;
    }

    if (arg?.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) {
        throw new Error('Missing value for --out');
      }
      outputPath = resolveCliPath(value, cwd, '--out path');
      continue;
    }

    if (arg?.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (arg) {
      if (inputPath) {
        throw new Error('Too many positional arguments');
      }
      inputPath = resolveCliPath(arg, cwd, 'Input JSONL path');
    }
  }

  if (!inputPath) {
    throw new Error(usage());
  }

  return { inputPath, outputPath };
}

export function buildApplyPlanRecords(records) {
  const approved = [];
  const failed = [];

  for (const record of records) {
    if (record?.success !== true) {
      failed.push({
        line: record?.line ?? 0,
        error: record?.error ?? 'Unknown parse failure',
        raw: record?.raw ?? null,
      });
      continue;
    }

    if (record.decision !== 'approve') {
      continue;
    }

    approved.push({
      artifactId: toArtifactId(record.file, record.artifactId),
      path: typeof record.file === 'string' ? record.file : '',
      suggestedTitle: typeof record.suggestedTitle === 'string' ? record.suggestedTitle : '',
      labels: Array.isArray(record.labels) ? record.labels : [],
      reason: typeof record.reason === 'string' ? record.reason : '',
    });
  }

  return { approved, failed };
}

function toArtifactId(filePath, artifactId) {
  if (typeof artifactId === 'string' && artifactId.trim() !== '') {
    return artifactId;
  }
  if (typeof filePath === 'string' && filePath.trim() !== '') {
    return path.basename(filePath);
  }
  return 'unknown';
}

function formatPlanSummary(total, approvedCount, failedCount) {
  return [
    '--- NVIDIA NIM review apply plan ---',
    '',
    `Total: ${total}`,
    `Approved: ${approvedCount}`,
    `Failed: ${failedCount}`,
    '',
  ].join('\n');
}

export function renderApplyPlanMarkdown(plan) {
  const lines = [
    '# NVIDIA NIM Review Apply Plan',
    '',
    `Input: ${plan.inputPath ?? 'unknown'}`,
    '',
    '## Summary',
    `- Total: ${plan.summary.total}`,
    `- Approved: ${plan.summary.approved}`,
    `- Failed: ${plan.summary.failed}`,
    '',
    '## Approved Items',
    '',
  ];

  if (plan.approved.length === 0) {
    lines.push('No approved items.');
  } else {
    lines.push('| artifactId | path | suggestedTitle | labels | reason |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of plan.approved) {
      const labels = item.labels.join(', ');
      const reason = item.reason?.replace(/\|/g, '\\|') ?? '';
      lines.push(`| ${item.artifactId} | ${item.path} | ${item.suggestedTitle} | ${labels} | ${reason} |`);
    }
  }

  lines.push('', '## Failed lines');
  if (plan.failed.length === 0) {
    lines.push('No failed lines.');
  } else {
    for (const failure of plan.failed) {
      lines.push(`- line ${failure.line}: ${failure.error}`);
      if (failure.raw) {
        lines.push(`  - raw: ${failure.raw}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function printFailureRows(failed) {
  if (failed.length === 0) {
    return;
  }
  console.log('\nFailed lines:');
  for (const fail of failed) {
    console.log(`- line ${fail.line}: ${fail.error}`);
    if (fail.raw) {
      console.log(`  raw: ${fail.raw}`);
    }
  }
}

function printApprovedItems(approved) {
  console.log('\nApproved items (apply plan):');
  if (approved.length === 0) {
    console.log('No approved items.');
    return;
  }

  for (const item of approved) {
    const labels = item.labels.length > 0 ? item.labels.join(', ') : '(none)';
    console.log(`- ${item.artifactId}`);
    console.log(`  path: ${item.path}`);
    console.log(`  suggestedTitle: ${item.suggestedTitle || '(none)'}`);
    console.log(`  labels: ${labels}`);
    console.log(`  reason: ${item.reason}`);
  }
}

async function main() {
  let parsedArgs;

  try {
    parsedArgs = parseApplyPlanArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  const text = await fs.readFile(parsedArgs.inputPath, 'utf8');
  const parseResult = parseReviewImportJsonl(text);
  const plan = buildApplyPlanRecords(parseResult.records);
  const summary = {
    total: parseResult.records.length,
    approved: plan.approved.length,
    failed: parseResult.failures,
  };

  console.log(formatPlanSummary(summary.total, summary.approved, summary.failed));
  printApprovedItems(plan.approved);
  printFailureRows(plan.failed);

  if (parsedArgs.outputPath) {
    const report = renderApplyPlanMarkdown({
      summary,
      approved: plan.approved,
      failed: plan.failed,
      inputPath: parsedArgs.inputPath,
    });
    await fs.writeFile(parsedArgs.outputPath, report, 'utf8');
    console.log(`Apply plan written: ${parsedArgs.outputPath}`);
  }

  if (summary.failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
