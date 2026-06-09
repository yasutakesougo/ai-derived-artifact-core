import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { loadApplyValidateInput } from './nvidia-nim-apply-validate.mjs';

export const APPLY_APPROVED_DRY_RUN_SCHEMA_VERSION = 'nvidia-nim-apply-approved-dry-run/1.0';

function usage() {
  return 'Usage: npm run review:apply-approved-dry-run -- [--json] [--out apply-approved-plan.json] apply-dry-run.json';
}

export function parseApplyApprovedDryRunArgs(args, cwd = process.cwd()) {
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

function selectApprovedItems(items) {
  const approvedItems = [];

  for (const item of items) {
    if (typeof item.decision === 'string' && item.decision !== 'approve') {
      continue;
    }
    approvedItems.push(item);
  }

  return approvedItems;
}

function buildWarnings(payload, approvedItems) {
  const warnings = [];

  for (const failure of payload.failed) {
    warnings.push({
      type: 'failed-row',
      line: failure.line,
      message: failure.error,
      ...(failure.raw === null ? {} : { raw: failure.raw }),
    });
  }

  if (payload.summary.approved !== approvedItems.length) {
    warnings.push({
      type: 'summary-mismatch',
      message: `summary.approved=${payload.summary.approved} but planned approved items=${approvedItems.length}`,
    });
  }

  return warnings;
}

function buildApprovedPlanPayload(payload) {
  const approvedItems = selectApprovedItems(payload.items);
  const warnings = buildWarnings(payload, approvedItems);

  return {
    schemaVersion: APPLY_APPROVED_DRY_RUN_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    inputPath: payload.inputPath,
    summary: {
      total: payload.summary.total,
      approved: approvedItems.length,
      warnings: warnings.length,
    },
    items: approvedItems.map((item) => ({
      artifactId: item.artifactId,
      path: item.path,
      suggestedTitle: item.suggestedTitle,
      labels: item.labels,
      reason: item.reason,
    })),
    warnings,
  };
}

function printApprovedPlan(payload) {
  const approvedItems = selectApprovedItems(payload.items);

  console.log('Apply approved-review dry-run plan:');
  console.log(`Input: ${payload.inputPath}`);
  console.log(`Approved payload entries: ${approvedItems.length}`);
  console.log(`Failed rows: ${payload.failed.length}`);

  if (approvedItems.length === 0) {
    console.log('No approved items found in payload.');
    return;
  }

  for (const item of approvedItems) {
    const labels = item.labels.length > 0 ? item.labels.join(', ') : '(none)';
    console.log(`- ${item.artifactId}`);
    console.log(`  path: ${item.path}`);
    console.log(`  suggestedTitle: ${item.suggestedTitle || '(none)'}`);
    console.log(`  labels: ${labels}`);
    console.log(`  reason: ${item.reason || '(none)'}`);
  }

  if (payload.failed.length > 0) {
    console.warn(`Warning: ${payload.failed.length} failed row(s) exist in dry-run payload.`);
  }

  if (approvedItems.length !== payload.summary.approved) {
    console.warn(`Warning: payload summary.approved=${payload.summary.approved} does not match planned approved items ${approvedItems.length}.`);
  }
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseApplyApprovedDryRunArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  let payload;
  try {
    payload = await loadApplyValidateInput(parsedArgs.inputPath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const planPayload = buildApprovedPlanPayload(payload);

  if (parsedArgs.outputPath) {
    if (parsedArgs.outputJson) {
      await fs.writeFile(
        parsedArgs.outputPath,
        `${JSON.stringify(planPayload, null, 2)}\n`,
        'utf8',
      );
      console.log(`Approved dry-run plan written: ${parsedArgs.outputPath}`);
      return;
    }

    console.warn('Only --json output is supported for --out. Use --json --out.');
    process.exit(1);
  }

  if (parsedArgs.outputJson) {
    process.stdout.write(`${JSON.stringify(planPayload, null, 2)}\n`);
    return;
  }

  printApprovedPlan(payload);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
