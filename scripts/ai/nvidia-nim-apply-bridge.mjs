import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { parseReviewImportJsonl } from './nvidia-nim-review-import.mjs';
import { buildApplyPlanRecords } from './nvidia-nim-apply-plan.mjs';

function usage() {
  return 'Usage: npm run review:apply-bridge -- [--json] [--out apply-plan.json|apply-plan.md] reviews.jsonl';
}

export function parseApplyBridgeArgs(args, cwd = process.cwd()) {
  let inputPath = null;
  let outputPath = null;
  let outputJson = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--json') {
      outputJson = true;
      continue;
    }

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

  return { inputPath, outputPath, outputJson };
}

function buildApplyBridgePayload(records) {
  const plan = buildApplyPlanRecords(records);

  return {
    inputPath: '',
    summary: {
      total: records.length,
      approved: plan.approved.length,
      failed: plan.failed.length,
    },
    items: plan.approved,
    failed: plan.failed,
  };
}

function normalizePayload(payload, inputPath) {
  return {
    ...payload,
    inputPath,
  };
}

export function renderApplyBridgeMarkdown(payload) {
  const lines = [
    '# NVIDIA NIM Apply Bridge Payload',
    '',
    `Input: ${payload.inputPath ?? 'unknown'}`,
    '',
    '## Summary',
    `- Total: ${payload.summary.total}`,
    `- Approved: ${payload.summary.approved}`,
    `- Failed: ${payload.summary.failed}`,
    '',
  ];

  lines.push('## Apply Payload Items');
  lines.push('');
  if (payload.items.length === 0) {
    lines.push('No approved items.');
  } else {
    lines.push('| artifactId | path | suggestedTitle | labels | reason |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of payload.items) {
      const reason = item.reason?.replace(/\|/g, '\\|') ?? '';
      lines.push(`| ${item.artifactId} | ${item.path} | ${item.suggestedTitle} | ${item.labels.join(', ')} | ${reason} |`);
    }
  }

  lines.push('', '## Failed lines');
  if (payload.failed.length === 0) {
    lines.push('No failed lines.');
  } else {
    for (const fail of payload.failed) {
      lines.push(`- line ${fail.line}: ${fail.error}`);
      if (fail.raw) {
        lines.push(`  - raw: ${fail.raw}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function printPayload(payload) {
  console.log(`Input: ${payload.inputPath}`);
  console.log(`Total: ${payload.summary.total}`);
  console.log(`Approved: ${payload.summary.approved}`);
  console.log(`Failed: ${payload.summary.failed}`);
  for (const item of payload.items) {
    console.log(`- ${item.artifactId}`);
    console.log(`  path: ${item.path}`);
    console.log(`  suggestedTitle: ${item.suggestedTitle || '(none)'}`);
    console.log(`  labels: ${item.labels.length > 0 ? item.labels.join(', ') : '(none)'}`);
    console.log(`  reason: ${item.reason || '(none)'}`);
  }
}

async function main() {
  let parsedArgs;

  try {
    parsedArgs = parseApplyBridgeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  const text = await fs.readFile(parsedArgs.inputPath, 'utf8');
  const parseResult = parseReviewImportJsonl(text);
  const payload = normalizePayload(buildApplyBridgePayload(parseResult.records), parsedArgs.inputPath);

  if (parsedArgs.outputPath) {
    if (parsedArgs.outputJson) {
      await fs.writeFile(
        parsedArgs.outputPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
    } else {
      const report = renderApplyBridgeMarkdown(payload);
      await fs.writeFile(parsedArgs.outputPath, report, 'utf8');
    }
    console.log(`Apply bridge payload written: ${parsedArgs.outputPath}`);
  } else if (parsedArgs.outputJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    printPayload(payload);
  }

  if (payload.summary.failed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
