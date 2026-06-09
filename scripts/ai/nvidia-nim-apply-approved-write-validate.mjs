import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { APPLY_APPROVED_PREVIEW_SCHEMA_VERSION } from './nvidia-nim-apply-approved-preview.mjs';

function usage() {
  return 'Usage: npm run review:apply-approved-write-validate -- apply-approved-preview.json';
}

export function parseApplyApprovedWriteValidateArgs(args, cwd = process.cwd()) {
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

export async function loadApplyApprovedWriteValidateInput(inputPath) {
  const text = await fs.readFile(inputPath, 'utf8');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return validateApplyApprovedWritePayload(payload);
}

function validateFailure(value, index, name) {
  if (!isObject(value)) {
    throw new Error(`Invalid ${name} at index ${index}: expected object`);
  }

  if (typeof value.code !== 'string') {
    throw new Error(`Invalid ${name} at index ${index}: code must be string`);
  }

  if (typeof value.message !== 'string') {
    throw new Error(`Invalid ${name} at index ${index}: message must be string`);
  }
}

export function validateApplyApprovedWritePayload(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid payload: expected object');
  }

  if (value.schemaVersion !== APPLY_APPROVED_PREVIEW_SCHEMA_VERSION) {
    throw new Error(`Invalid schemaVersion: expected ${APPLY_APPROVED_PREVIEW_SCHEMA_VERSION}`);
  }

  if (!isObject(value.preflight)) {
    throw new Error('Invalid payload: preflight must be an object');
  }

  if (typeof value.preflight.passed !== 'boolean') {
    throw new Error('Invalid payload: preflight.passed must be boolean');
  }

  if (!Array.isArray(value.preflight.failures)) {
    throw new Error('Invalid payload: preflight.failures must be an array');
  }

  for (let index = 0; index < value.preflight.failures.length; index += 1) {
    validateFailure(value.preflight.failures[index], index, 'preflight.failure');
  }

  if (!isObject(value.summary)) {
    throw new Error('Invalid payload: summary must be an object');
  }

  const summaryTotal = toNonNegativeInteger(value.summary.total);
  const summaryApproved = toNonNegativeInteger(value.summary.approved);
  const summaryWarnings = toNonNegativeInteger(value.summary.warnings);
  if (
    summaryTotal === null
    || summaryApproved === null
    || summaryWarnings === null
  ) {
    throw new Error('Invalid payload: summary.total/approved/warnings must be non-negative integers');
  }

  if (typeof value.generatedAt !== 'string') {
    throw new Error('Invalid payload: generatedAt must be a string');
  }

  if (typeof value.inputPath !== 'string') {
    throw new Error('Invalid payload: inputPath must be a string');
  }

  if (typeof value.outputPath !== 'string') {
    throw new Error('Invalid payload: outputPath must be a string');
  }

  if (!Array.isArray(value.items)) {
    throw new Error('Invalid payload: items must be an array');
  }

  if (!Array.isArray(value.warnings)) {
    throw new Error('Invalid payload: warnings must be an array');
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

  for (let index = 0; index < value.warnings.length; index += 1) {
    const warning = value.warnings[index];
    if (!isObject(warning)) {
      throw new Error(`Invalid warning record at index ${index}: expected object`);
    }

    if (typeof warning.type !== 'string') {
      throw new Error(`Invalid warning record at index ${index}: type must be string`);
    }

    const line = toNonNegativeInteger(warning.line);
    if (line === null) {
      throw new Error(`Invalid warning record at index ${index}: line must be non-negative integer`);
    }

    if (typeof warning.message !== 'string') {
      throw new Error(`Invalid warning record at index ${index}: message must be string`);
    }

    if ('raw' in warning && !(warning.raw === null || typeof warning.raw === 'string')) {
      throw new Error(`Invalid warning record at index ${index}: raw must be null or string`);
    }
  }

  return {
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    inputPath: value.inputPath,
    outputPath: value.outputPath,
    summary: {
      total: summaryTotal,
      approved: summaryApproved,
      warnings: summaryWarnings,
    },
    preflight: {
      passed: value.preflight.passed,
      failures: value.preflight.failures,
    },
    items: value.items,
    warnings: value.warnings,
  };
}

function toNonNegativeInteger(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function printValidationSummary(payload) {
  console.log('Validation passed: NVIDIA NIM apply-approved preview write payload is valid for write connector.');
  console.log(`schemaVersion: ${payload.schemaVersion}`);
  console.log(`generatedAt: ${payload.generatedAt}`);
  console.log(`inputPath: ${payload.inputPath}`);
  console.log(`outputPath: ${payload.outputPath}`);
  console.log(`summary.total: ${payload.summary.total}`);
  console.log(`summary.approved: ${payload.summary.approved}`);
  console.log(`summary.warnings: ${payload.summary.warnings}`);
  console.log(`items: ${payload.items.length}`);
  console.log(`warnings: ${payload.warnings.length}`);
  console.log(`preflight.passed: ${payload.preflight.passed}`);
  console.log(`preflight.failures: ${payload.preflight.failures.length}`);
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseApplyApprovedWriteValidateArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  let payload;
  try {
    payload = await loadApplyApprovedWriteValidateInput(parsedArgs.inputPath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  printValidationSummary(payload);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
