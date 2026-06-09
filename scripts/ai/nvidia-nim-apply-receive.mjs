import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { loadApplyValidateInput, printValidationSummary } from './nvidia-nim-apply-validate.mjs';

function usage() {
  return 'Usage: npm run review:apply-receive -- apply-dry-run.json';
}

export function parseApplyReceiveArgs(args, cwd = process.cwd()) {
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

function printReceiveSummary(payload) {
  console.log('Apply receive candidates:');

  for (const item of payload.items) {
    const labels = item.labels.length > 0 ? item.labels.join(', ') : '(none)';
    console.log(`- ${item.artifactId}`);
    console.log(`  path: ${item.path}`);
    console.log(`  suggestedTitle: ${item.suggestedTitle || '(none)'}`);
    console.log(`  labels: ${labels}`);
    console.log(`  reason: ${item.reason || '(none)'}`);
  }

  if (payload.failed.length > 0) {
    console.warn(`Warning: ${payload.failed.length} failed row(s) were present in payload.`);
  }

  console.log(`Candidate summary: ${payload.items.length} item(s), ${payload.failed.length} failed row(s).`);
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseApplyReceiveArgs(process.argv.slice(2));
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

  printValidationSummary(payload);
  printReceiveSummary(payload);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
