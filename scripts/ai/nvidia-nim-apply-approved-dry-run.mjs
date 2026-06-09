import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { loadApplyValidateInput } from './nvidia-nim-apply-validate.mjs';

function usage() {
  return 'Usage: npm run review:apply-approved-dry-run -- apply-dry-run.json';
}

export function parseApplyApprovedDryRunArgs(args, cwd = process.cwd()) {
  let inputPath = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

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

  return { inputPath };
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

  printApprovedPlan(payload);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
