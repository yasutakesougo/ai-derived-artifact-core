import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { fileURLToPath } from 'node:url';
import {
  parseReviewImportJsonl,
  summarizeReviewImport,
} from './nvidia-nim-review-import.mjs';

function usage() {
  return 'Usage: npm run review:aggregate -- reviews.jsonl';
}

export function parseAggregateArgs(args, cwd = process.cwd()) {
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
      inputPath = resolveCliPath(arg, cwd, 'Input JSONL path');
    }
  }

  if (!inputPath) {
    throw new Error(usage());
  }

  return { inputPath };
}

export function aggregateReviewRecords(text) {
  const parseResult = parseReviewImportJsonl(String(text));
  const records = parseResult.records;
  const summary = summarizeReviewImport(records);

  const aggregate = {
    summary: {
      total: summary.total,
      approve: summary.approved,
      needsReview: summary.needsReview,
      reject: summary.rejected,
      failed: summary.failed,
    },
    failed: [],
    needsReview: [],
    reject: [],
  };

  for (const record of records) {
    if (record?.success !== true) {
      aggregate.failed.push({
        line: record.line,
        error: record.error ?? 'Unknown parse failure',
        raw: record.raw ?? null,
      });
      continue;
    }

    if (record.decision === 'needs_review') {
      aggregate.needsReview.push(formatAggregateRecord(record));
      continue;
    }

    if (record.decision === 'reject') {
      aggregate.reject.push(formatAggregateRecord(record));
    }
  }

  return aggregate;
}

function formatAggregateRecord(record) {
  const file = typeof record.file === 'string' ? record.file : '';
  const artifactId =
    typeof record.artifactId === 'string' && record.artifactId.trim() !== ''
      ? record.artifactId
      : file
        ? path.basename(file)
        : 'unknown';

  return {
    artifactId,
    path: file,
    classification: record.decision,
    reason: typeof record.reason === 'string' ? record.reason : '',
  };
}

function printSection(title, items) {
  if (items.length === 0) {
    return;
  }

  console.log(`\n${title}`);
  for (const item of items) {
    console.log(`- ${item.artifactId}`);
    console.log(`  path: ${item.path}`);
    console.log(`  classification: ${item.classification}`);
    console.log(`  reason: ${item.reason}`);
  }
}

async function main() {
  let parsedArgs;

  try {
    parsedArgs = parseAggregateArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }

  const fileText = await fs.readFile(parsedArgs.inputPath, 'utf8');
  const aggregate = aggregateReviewRecords(fileText);

  console.log('\n--- NVIDIA NIM review aggregate ---\n');
  console.log(`Input: ${parsedArgs.inputPath}`);
  console.log(`Total: ${aggregate.summary.total}`);
  console.log(`  Approve: ${aggregate.summary.approve}`);
  console.log(`  Needs Review: ${aggregate.summary.needsReview}`);
  console.log(`  Reject: ${aggregate.summary.reject}`);
  console.log(`  Failed: ${aggregate.summary.failed}`);

  if (aggregate.failed.length > 0) {
    console.log('\nFailed lines:');
    for (const fail of aggregate.failed) {
      const prefix = `  - line ${fail.line}`;
      if (fail.error) {
        console.log(`${prefix}: ${fail.error}`);
      }
      if (fail.raw) {
        console.log(`    raw: ${fail.raw}`);
      }
    }
  }

  printSection('\nNeeds Review:', aggregate.needsReview);
  printSection('\nReject:', aggregate.reject);

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
