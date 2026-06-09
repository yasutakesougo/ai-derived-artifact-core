import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseReviewImportJsonl } from './nvidia-nim-review-import.mjs';
import { buildApplyPlanRecords } from './nvidia-nim-apply-plan.mjs';
import { resolveCliPath } from './nvidia-nim-paths.mjs';

function usage() {
  return 'Usage: npm run review:apply-dry-run -- [--json] [--out apply-dry-run.md|.json] apply-bridge.json|reviews.jsonl';
}

export function parseApplyDryRunArgs(args, cwd = process.cwd()) {
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
      inputPath = resolveCliPath(arg, cwd, 'Input path');
    }
  }

  if (!inputPath) {
    throw new Error(usage());
  }

  return { inputPath, outputPath, outputJson };
}

export async function loadApplyDryRunInput(inputPath) {
  const text = await fs.readFile(inputPath, 'utf8');

  const jsonValue = safelyParseJsonObject(text);
  if (jsonValue !== null) {
    return parseBridgePayload(jsonValue);
  }

  const parseResult = parseReviewImportJsonl(text);
  const plan = buildApplyPlanRecords(parseResult.records);

  return {
    inputPath,
    total: parseResult.records.length,
    items: plan.approved.map(normalizeDryRunItem),
    failures: plan.failed,
  };
}

function parseBridgePayload(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray(value.items)
  ) {
    throw new Error('Invalid apply-bridge payload format');
  }

  const planItems = [];
  const failures = [];

  for (let index = 0; index < value.items.length; index += 1) {
    const rawItem = value.items[index];
    const item = normalizeDryRunItem(rawItem);
    if (item === null) {
      failures.push({
        line: index + 1,
        error: 'Invalid payload item',
        raw: stringifySafe(rawItem),
      });
      continue;
    }
    if (item.__decision && item.__decision !== 'approve') {
      continue;
    }
    planItems.push(item);
  }

  const payloadFailed = Array.isArray(value.failed) ? value.failed : [];
  const summaryTotal = toPositiveInteger(value.summary?.total) ?? value.items.length;

  return {
    inputPath: value.inputPath ?? '',
    total: summaryTotal,
    items: planItems,
    failures: [
      ...payloadFailed.map((item) => ({
        line: toPositiveInteger(item.line) ?? 0,
        error: String(item.error ?? 'Unknown payload failure'),
        raw: item.raw ?? null,
      })),
      ...failures,
    ],
  };
}

export function normalizeDryRunItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') {
    return null;
  }

  const artifactId = typeof rawItem.artifactId === 'string' && rawItem.artifactId.trim() !== ''
    ? rawItem.artifactId
    : typeof rawItem.path === 'string' && rawItem.path.trim() !== ''
      ? rawItem.path
      : 'unknown';

  const suggestion = typeof rawItem.suggestedTitle === 'string' ? rawItem.suggestedTitle : '';
  const reason = typeof rawItem.reason === 'string' ? rawItem.reason : '';

  return {
    artifactId,
    path: typeof rawItem.path === 'string' ? rawItem.path : '',
    suggestedTitle: suggestion,
    labels: Array.isArray(rawItem.labels) ? rawItem.labels : [],
    reason,
    ...(typeof rawItem.decision === 'string' ? { __decision: rawItem.decision } : {}),
  };
}

function safelyParseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toPositiveInteger(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function stringifySafe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function renderApplyDryRunMarkdown(plan) {
  const lines = [
    '# NVIDIA NIM Apply Dry-Run Plan',
    '',
    `Input: ${plan.inputPath ?? 'unknown'}`,
    '',
    '## Summary',
    `- Total: ${plan.total}`,
    `- Approved: ${plan.items.length}`,
    `- Failed: ${plan.failures.length}`,
    '',
    '## Approved payload for apply-preview',
    '',
  ];

  if (plan.items.length === 0) {
    lines.push('No approved items.');
  } else {
    lines.push('| artifactId | path | suggestedTitle | labels | reason |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of plan.items) {
      const reason = item.reason.replace(/\|/g, '\\|');
      const labels = item.labels.join(', ');
      lines.push(`| ${item.artifactId} | ${item.path} | ${item.suggestedTitle} | ${labels} | ${reason} |`);
    }
  }

  lines.push('', '## Failed rows');
  if (plan.failures.length === 0) {
    lines.push('No failed rows.');
  } else {
    for (const fail of plan.failures) {
      lines.push(`- line ${fail.line}: ${fail.error}`);
      if (fail.raw != null) {
        lines.push(`  - raw: ${fail.raw}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function printApplyDryRun(plan) {
  console.log(`Input: ${plan.inputPath}`);
  console.log(`Total: ${plan.total}`);
  console.log(`Approved: ${plan.items.length}`);
  console.log(`Failed: ${plan.failures.length}`);
  for (const item of plan.items) {
    const labels = item.labels.length > 0 ? item.labels.join(', ') : '(none)';
    console.log(`- ${item.artifactId}`);
    console.log(`  path: ${item.path}`);
    console.log(`  suggestedTitle: ${item.suggestedTitle || '(none)'}`);
    console.log(`  labels: ${labels}`);
    console.log(`  reason: ${item.reason || '(none)'}`);
  }

  if (plan.failures.length > 0) {
    console.log('Failed rows:');
    for (const fail of plan.failures) {
      console.log(`- line ${fail.line}: ${fail.error}`);
      if (fail.raw != null) {
        console.log(`  raw: ${fail.raw}`);
      }
    }
  }
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseApplyDryRunArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  let payload;
  try {
    payload = await loadApplyDryRunInput(parsedArgs.inputPath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const isJsonOutput = parsedArgs.outputJson
    || (typeof parsedArgs.outputPath === 'string' && parsedArgs.outputPath.endsWith('.json'));

  if (parsedArgs.outputPath) {
    if (isJsonOutput) {
      await fs.writeFile(parsedArgs.outputPath, `${JSON.stringify({
        inputPath: payload.inputPath,
        summary: {
          total: payload.total,
          approved: payload.items.length,
          failed: payload.failures.length,
        },
        items: payload.items,
        failed: payload.failures,
      }, null, 2)}\n`, 'utf8');
    } else {
      const text = renderApplyDryRunMarkdown({
        inputPath: payload.inputPath,
        total: payload.total,
        items: payload.items,
        failures: payload.failures,
      });
      await fs.writeFile(parsedArgs.outputPath, text, 'utf8');
    }
    console.log(`Dry-run plan written: ${parsedArgs.outputPath}`);
  } else {
    printApplyDryRun({
      inputPath: payload.inputPath,
      total: payload.total,
      items: payload.items,
      failures: payload.failures,
    });
  }

  if (payload.failures.length > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
