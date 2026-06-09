import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { loadApplyApprovedValidateInput } from './nvidia-nim-apply-approved-validate.mjs';
import { collectApplyApprovedPreflightFailures } from './nvidia-nim-apply-approved-preflight.mjs';

export const APPLY_APPROVED_PREVIEW_SCHEMA_VERSION = 'nvidia-nim-apply-approved-preview/1.0';

function usage() {
  return 'Usage: npm run review:apply-approved-preview -- [--write] [--out apply-approved-preview.json] [--allowlist PATH] [--expected-plan-hash HASH] [--expected-input-path PATH] [--expected-input-hash HASH] apply-approved-plan.json';
}

export function parseApplyApprovedPreviewArgs(args, cwd = process.cwd()) {
  let inputPath = null;
  let outputPath = null;
  let write = false;
  const allowlist = [];
  let expectedPlanHash = null;
  let expectedInputPath = null;
  let expectedInputHash = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--write') {
      write = true;
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

    if (arg === '--allowlist') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --allowlist');
      }
      allowlist.push(resolveCliPath(value, cwd, '--allowlist path'));
      index += 1;
      continue;
    }

    if (arg === '--expected-plan-hash') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --expected-plan-hash');
      }
      expectedPlanHash = value;
      index += 1;
      continue;
    }

    if (arg === '--expected-input-path') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --expected-input-path');
      }
      expectedInputPath = resolveCliPath(value, cwd, '--expected-input-path');
      index += 1;
      continue;
    }

    if (arg === '--expected-input-hash') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --expected-input-hash');
      }
      expectedInputHash = value;
      index += 1;
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

  if (write && !outputPath) {
    throw new Error('Missing value for --out');
  }

  if (write && allowlist.length === 0) {
    throw new Error('Missing required --allowlist for --write');
  }

  return {
    inputPath,
    outputPath,
    write,
    allowlist,
    expectedPlanHash,
    expectedInputPath,
    expectedInputHash,
  };
}

function renderApplyApprovedPreview(payload) {
  const lines = [
    'Apply-approved preview:',
    `Input: ${payload.inputPath}`,
    `Total: ${payload.summary.total}`,
    `Approved candidates: ${payload.items.length}`,
    `Warnings: ${payload.warnings.length}`,
  ];

  if (payload.summary.approved !== payload.items.length) {
    lines.push(`Warning: summary.approved=${payload.summary.approved} does not match actual approved candidates ${payload.items.length}.`);
  }

  if (payload.summary.warnings !== payload.warnings.length) {
    lines.push(`Warning: summary.warnings=${payload.summary.warnings} does not match actual warnings ${payload.warnings.length}.`);
  }

  lines.push('Apply candidates:');
  if (payload.items.length === 0) {
    lines.push('No apply candidates found.');
  } else {
    for (const item of payload.items) {
      const labels = item.labels.length > 0 ? item.labels.join(', ') : '(none)';
      lines.push(`- ${item.artifactId}`);
      lines.push(`  path: ${item.path}`);
      lines.push(`  suggestedTitle: ${item.suggestedTitle || '(none)'}`);
      lines.push(`  labels: ${labels}`);
      lines.push(`  reason: ${item.reason || '(none)'}`);
    }
  }

  if (payload.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of payload.warnings) {
      lines.push(`  - [${warning.type}] line ${warning.line}: ${warning.message}`);
      if (warning.raw != null) {
        lines.push(`    raw: ${warning.raw}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildPreviewWritePayload(payload, preflightFailures, outputPath) {
  return {
    schemaVersion: APPLY_APPROVED_PREVIEW_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    inputPath: payload.inputPath,
    outputPath,
    summary: {
      total: payload.summary.total,
      approved: payload.items.length,
      warnings: payload.warnings.length,
    },
    items: payload.items.map((item) => ({
      artifactId: item.artifactId,
      path: item.path,
      suggestedTitle: item.suggestedTitle,
      labels: item.labels,
      reason: item.reason,
    })),
    warnings: payload.warnings,
    preflight: {
      passed: preflightFailures.length === 0,
      failures: preflightFailures,
    },
  };
}

function printApplyPreview(payload) {
  process.stdout.write(renderApplyApprovedPreview(payload));
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

  if (parsedArgs.write) {
    const preflightArgs = {
      inputPath: parsedArgs.inputPath,
      allowlist: parsedArgs.allowlist,
      expectedPlanHash: parsedArgs.expectedPlanHash,
      expectedInputPath: parsedArgs.expectedInputPath,
      expectedInputHash: parsedArgs.expectedInputHash,
    };

    const failures = await collectApplyApprovedPreflightFailures(payload, preflightArgs);
    if (failures.length > 0) {
      console.error('Write preflight failed:');
      for (const failure of failures) {
        console.error(`[${failure.code}] ${failure.message}`);
      }
      process.exit(1);
    }

    if (parsedArgs.outputPath === null) {
      console.error('Missing value for --out');
      process.exit(1);
    }

    const outputPath = parsedArgs.outputPath;

    const writePayload = buildPreviewWritePayload(payload, failures, outputPath);
    await fs.writeFile(outputPath, `${JSON.stringify(writePayload, null, 2)}\n`, 'utf8');

    console.log(`Apply-approved preview plan written: ${outputPath}`);
    return;
  }

  printApplyPreview(payload);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
