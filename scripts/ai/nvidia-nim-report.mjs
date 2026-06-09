import fs from 'node:fs/promises';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { fileURLToPath } from 'node:url';
import { aggregateReviewRecords } from './nvidia-nim-aggregate.mjs';

function usage() {
  return 'Usage: npm run review:report -- --out review-report.md reviews.jsonl';
}

export function parseReportArgs(args, cwd = process.cwd()) {
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

  if (!outputPath) {
    throw new Error('Missing value for --out');
  }

  if (!inputPath) {
    throw new Error(usage());
  }

  return { inputPath, outputPath };
}

export function renderNvidiaNimReviewReport(aggregate) {
  const header = [
    '# NVIDIA NIM Review Report',
    '',
    `Input: ${aggregate.inputPath ?? 'unknown'}`,
    '',
    '## Summary',
    `- Total: ${aggregate.summary.total}`,
    `- Approve: ${aggregate.summary.approve}`,
    `- Needs Review: ${aggregate.summary.needsReview}`,
    `- Reject: ${aggregate.summary.reject}`,
    `- Failed: ${aggregate.summary.failed}`,
    '',
  ];

  const failed = buildFailedSection(aggregate.failed);
  const needsReview = buildListSection('Needs Review', aggregate.needsReview);
  const reject = buildListSection('Reject', aggregate.reject);

  return [...header, failed, needsReview, reject, ''].filter((line) => line !== '').join('\n');
}

function buildFailedSection(failed) {
  const lines = [
    '## Failed lines',
    '',
  ];

  if (failed.length === 0) {
    lines.push('No failed lines.');
    return lines.join('\n');
  }

  for (const fail of failed) {
    lines.push(`- line ${fail.line}: ${fail.error}`);
    if (fail.raw) {
      lines.push(`  - raw: ${fail.raw}`);
    }
  }

  return lines.join('\n');
}

function buildListSection(title, items) {
  const lines = [
    `## ${title}`,
    '',
  ];

  if (items.length === 0) {
    lines.push(`No ${title.toLowerCase()} items.`);
    return lines.join('\n');
  }

  lines.push('| artifactId | path | classification | reason |');
  lines.push('| --- | --- | --- | --- |');
  for (const item of items) {
    const reason = item.reason?.replace(/\|/g, '\\|') ?? '';
    lines.push(`| ${item.artifactId} | ${item.path} | ${item.classification} | ${reason} |`);
  }

  return lines.join('\n');
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseReportArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  const text = await fs.readFile(parsedArgs.inputPath, 'utf8');
  const aggregate = aggregateReviewRecords(text);
  const report = renderNvidiaNimReviewReport({
    ...aggregate,
    inputPath: parsedArgs.inputPath,
  });

  await fs.writeFile(parsedArgs.outputPath, report, 'utf8');
  console.log(`Markdown report written: ${parsedArgs.outputPath}`);
  console.log(`Total: ${aggregate.summary.total}`);
  console.log(`Failed: ${aggregate.summary.failed}`);

  if (aggregate.summary.failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
