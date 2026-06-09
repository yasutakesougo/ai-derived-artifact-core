import fs from 'node:fs/promises';
import { resolveCliPath } from './nvidia-nim-paths.mjs';

const VALID_DECISIONS = ['approve', 'needs_review', 'reject'];

function usage() {
  return 'Usage: npm run review:import -- [--only needs_review|approve|reject] reviews.jsonl';
}

export function parseReviewImportArgs(args, cwd = process.cwd()) {
  let inputPath = null;
  let only = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--only') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --only');
      }
      if (!VALID_DECISIONS.includes(value)) {
        throw new Error(`Invalid decision for --only: ${value}`);
      }
      only = value;
      index += 1;
      continue;
    }

    if (arg?.startsWith('--only=')) {
      const value = arg.slice('--only='.length);
      if (!value) {
        throw new Error('Missing value for --only');
      }
      if (!VALID_DECISIONS.includes(value)) {
        throw new Error(`Invalid decision for --only: ${value}`);
      }
      only = value;
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

  return { inputPath, only };
}

function buildFailureResult(lineNumber, lineText, error) {
  return {
    line: lineNumber,
    success: false,
    error,
    raw: lineText,
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseReviewImportJsonl(text) {
  const lines = String(text).split(/\r?\n/);
  const records = [];
  let failures = 0;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const trimmed = lines[lineNumber].trim();

    if (trimmed === '') {
      continue;
    }

    let parsed;

    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      failures += 1;
      records.push(buildFailureResult(lineNumber + 1, trimmed, error.message));
      continue;
    }

    if (!isObject(parsed)) {
      failures += 1;
      records.push(buildFailureResult(lineNumber + 1, trimmed, 'Parsed JSON is not an object'));
      continue;
    }

    if (parsed.success === false) {
      records.push({
        ...parsed,
        line: lineNumber + 1,
      });
      failures += 1;
      continue;
    }

    const decision = parsed.decision;
    if (!VALID_DECISIONS.includes(decision)) {
      failures += 1;
      records.push({
        ...parsed,
        success: false,
        line: lineNumber + 1,
        error: `Invalid or missing decision: ${String(decision)}`,
      });
      continue;
    }

    records.push({
      ...parsed,
      success: true,
      decision,
      line: lineNumber + 1,
    });
  }

  return { records, failures };
}

export function summarizeReviewImport(records) {
  const summary = {
    total: records.length,
    approved: 0,
    needsReview: 0,
    rejected: 0,
    failed: 0,
  };

  for (const record of records) {
    if (record?.success !== true) {
      summary.failed += 1;
      continue;
    }

    if (record.decision === 'approve') {
      summary.approved += 1;
      continue;
    }

    if (record.decision === 'needs_review') {
      summary.needsReview += 1;
      continue;
    }

    summary.rejected += 1;
  }

  return summary;
}

async function main() {
  let parsedArgs;

  try {
    parsedArgs = parseReviewImportArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  const { inputPath, only } = parsedArgs;
  const fileText = await fs.readFile(inputPath, 'utf8');
  const parseResult = parseReviewImportJsonl(fileText);
  const records = parseResult.records;
  const summary = summarizeReviewImport(records);

  if (only) {
    const filtered = records.filter((record) => record.success === true && record.decision === only);
    console.log(`\n--- Filtered (${only}) ---\n`);
    for (const record of filtered) {
      console.log(JSON.stringify(record));
    }
    if (filtered.length === 0) {
      console.log(`No records matched: ${only}`);
    }
  }

  console.log('\n--- NVIDIA NIM review import ---\n');
  console.log(`Input: ${inputPath}`);
  console.log(`Total: ${summary.total}`);
  console.log(`  Approved: ${summary.approved}`);
  console.log(`  Needs Review: ${summary.needsReview}`);
  console.log(`  Rejected: ${summary.rejected}`);
  console.log(`  Failed: ${summary.failed}`);

  if (parseResult.failures > 0 || summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
