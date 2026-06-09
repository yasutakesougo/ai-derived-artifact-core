import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { loadApplyApprovedValidateInput } from './nvidia-nim-apply-approved-validate.mjs';

function usage() {
  return 'Usage: npm run review:apply-approved-preview -- apply-approved-plan.json';
}

export function parseApplyApprovedPreviewArgs(args, cwd = process.cwd()) {
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

function printApplyPreview(payload) {
  console.log('Apply-approved preview:');
  console.log(`Input: ${payload.inputPath}`);
  console.log(`Total: ${payload.summary.total}`);
  console.log(`Approved candidates: ${payload.items.length}`);
  console.log(`Warnings: ${payload.warnings.length}`);

  if (payload.items.length === 0) {
    console.log('No apply candidates found.');
    return;
  }

  for (const item of payload.items) {
    const labels = item.labels.length > 0 ? item.labels.join(', ') : '(none)';
    console.log(`- ${item.artifactId}`);
    console.log(`  path: ${item.path}`);
    console.log(`  suggestedTitle: ${item.suggestedTitle || '(none)'}`);
    console.log(`  labels: ${labels}`);
    console.log(`  reason: ${item.reason || '(none)'}`);
  }

  if (payload.summary.warnings !== payload.warnings.length) {
    console.warn(`Warning: summary.warnings=${payload.summary.warnings} does not match actual warnings ${payload.warnings.length}.`);
  }

  if (payload.warnings.length > 0) {
    console.warn('Warnings:');
    for (const warning of payload.warnings) {
      console.warn(`  - [${warning.type}] line ${warning.line}: ${warning.message}`);
      if (warning.raw != null) {
        console.warn(`    raw: ${warning.raw}`);
      }
    }
  }
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseApplyApprovedPreviewArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  let payload;
  try {
    payload = await loadApplyApprovedValidateInput(parsedArgs.inputPath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  printApplyPreview(payload);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
