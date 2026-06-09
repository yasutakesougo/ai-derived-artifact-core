import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { APPLY_DRY_RUN_SCHEMA_VERSION } from './nvidia-nim-apply-dry-run.mjs';

function usage() {
  return 'Usage: npm run review:apply-validate -- apply-dry-run.json';
}

export function parseApplyValidateArgs(args, cwd = process.cwd()) {
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

export async function loadApplyValidateInput(inputPath) {
  const text = await fs.readFile(inputPath, 'utf8');

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return validateApplyDryRunPayload(payload);
}

function toNonNegativeInteger(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function validateApplyDryRunPayload(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid payload: expected object');
  }

  if (value.schemaVersion !== APPLY_DRY_RUN_SCHEMA_VERSION) {
    throw new Error(`Invalid schemaVersion: expected ${APPLY_DRY_RUN_SCHEMA_VERSION}`);
  }

  if (!isObject(value.summary)) {
    throw new Error('Invalid payload: summary must be an object');
  }

  const summaryTotal = toNonNegativeInteger(value.summary.total);
  const summaryApproved = toNonNegativeInteger(value.summary.approved);
  const summaryFailed = toNonNegativeInteger(value.summary.failed);
  if (
    summaryTotal === null
    || summaryApproved === null
    || summaryFailed === null
  ) {
    throw new Error('Invalid payload: summary.total/approved/failed must be non-negative integers');
  }

  if (!Array.isArray(value.items)) {
    throw new Error('Invalid payload: items must be an array');
  }

  if (!Array.isArray(value.failed)) {
    throw new Error('Invalid payload: failed must be an array');
  }

  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    if (!isObject(item)) {
      throw new Error(`Invalid payload item at index ${index}: expected object`);
    }

    if (typeof item.artifactId !== 'string') {
      throw new Error(`Invalid payload item at index ${index}: artifactId must be string`);
    }

    if (typeof item.path !== 'string') {
      throw new Error(`Invalid payload item at index ${index}: path must be string`);
    }

    if (typeof item.suggestedTitle !== 'string') {
      throw new Error(`Invalid payload item at index ${index}: suggestedTitle must be string`);
    }

    if (!Array.isArray(item.labels) || !item.labels.every((label) => typeof label === 'string')) {
      throw new Error(`Invalid payload item at index ${index}: labels must be array of strings`);
    }

    if (typeof item.reason !== 'string') {
      throw new Error(`Invalid payload item at index ${index}: reason must be string`);
    }
  }

  for (let index = 0; index < value.failed.length; index += 1) {
    const failure = value.failed[index];
    if (!isObject(failure)) {
      throw new Error(`Invalid failure record at index ${index}: expected object`);
    }

    const line = toNonNegativeInteger(failure.line);
    if (line === null) {
      throw new Error(`Invalid failure record at index ${index}: line must be non-negative integer`);
    }

    if (typeof failure.error !== 'string') {
      throw new Error(`Invalid failure record at index ${index}: error must be string`);
    }

    if ('raw' in failure && !(failure.raw === null || typeof failure.raw === 'string')) {
      throw new Error(`Invalid failure record at index ${index}: raw must be null or string`);
    }
  }

  return {
    schemaVersion: value.schemaVersion,
    inputPath: typeof value.inputPath === 'string' ? value.inputPath : '',
    summary: {
      total: summaryTotal,
      approved: summaryApproved,
      failed: summaryFailed,
    },
    items: value.items,
    failed: value.failed,
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printValidationSummary(payload) {
  console.log('Validation passed: NVIDIA NIM apply-dry-run payload is valid for apply-approved-review receiver.');
  console.log(`schemaVersion: ${payload.schemaVersion}`);
  console.log(`inputPath: ${payload.inputPath}`);
  console.log(`summary.total: ${payload.summary.total}`);
  console.log(`summary.approved: ${payload.summary.approved}`);
  console.log(`summary.failed: ${payload.summary.failed}`);
  console.log(`items: ${payload.items.length}`);
  console.log(`failed rows: ${payload.failed.length}`);
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseApplyValidateArgs(process.argv.slice(2));
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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
