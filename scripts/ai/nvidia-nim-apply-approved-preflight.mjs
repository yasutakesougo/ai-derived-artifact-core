import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliPath } from './nvidia-nim-paths.mjs';
import { loadApplyApprovedValidateInput } from './nvidia-nim-apply-approved-validate.mjs';

function usage() {
  return 'Usage: npm run review:apply-approved-preflight -- [--allowlist PATH] [--expected-plan-hash HASH] [--expected-input-path PATH] [--expected-input-hash HASH] apply-approved-plan.json';
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',');
    return `{${entries}}`;
  }

  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function containsTraversalSegment(candidatePath) {
  return candidatePath
    .split(/[\\/]+/)
    .some((segment) => segment === '..');
}

function isUnderAllowedRoot(candidatePath, allowRoot) {
  const relativePath = relative(allowRoot, candidatePath);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function validateResolvedPath(candidateRawPath, baseDir, allowlistedRoots, index) {
  if (!candidateRawPath) {
    return `Item at index ${index} has empty path.`;
  }

  if (containsTraversalSegment(candidateRawPath)) {
    return `Item ${index} path contains directory traversal segment: ${candidateRawPath}`;
  }

  const resolvedPath = resolve(baseDir, candidateRawPath);

  for (const allowRoot of allowlistedRoots) {
    if (isUnderAllowedRoot(resolvedPath, allowRoot)) {
      return null;
    }
  }

  return `Item ${index} path ${candidateRawPath} is outside allowlist: ${allowlistedRoots.join(', ')}`;
}

export function parseApplyApprovedPreflightArgs(args, cwd = process.cwd()) {
  let inputPath = null;
  const allowlist = [];
  let expectedPlanHash = null;
  let expectedInputPath = null;
  let expectedInputHash = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

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

  return {
    inputPath,
    allowlist,
    expectedPlanHash,
    expectedInputPath,
    expectedInputHash,
  };
}

function deriveAllowlistRoots(inputPath, explicitRoots) {
  if (explicitRoots.length > 0) {
    return [...new Set(explicitRoots.map((root) => resolve(root)))];
  }

  return [resolve(dirname(inputPath))];
}

async function hashFile(path) {
  const text = await fs.readFile(path, 'utf8');
  return sha256(text);
}

function computePlanHash(payload) {
  return sha256(stableStringify(payload));
}

async function validateLineage(payload, parsedArgs, inputPath) {
  const errors = [];
  if (parsedArgs.expectedPlanHash) {
    const actualPlanHash = computePlanHash(payload);
    if (actualPlanHash !== parsedArgs.expectedPlanHash) {
      errors.push(`Plan checksum mismatch (expected ${parsedArgs.expectedPlanHash}, got ${actualPlanHash}).`);
    }
  }

  const effectiveInputPath = parsedArgs.expectedInputPath ?? resolve(dirname(inputPath), payload.inputPath);

  if (parsedArgs.expectedInputPath) {
    if (resolve(dirname(inputPath), payload.inputPath) !== parsedArgs.expectedInputPath) {
      errors.push(`Input path mismatch: expected ${parsedArgs.expectedInputPath}, actual ${resolve(dirname(inputPath), payload.inputPath)}.`);
    }
  }

  if (parsedArgs.expectedInputPath || parsedArgs.expectedInputHash) {
    let actualInputHash;
    try {
      actualInputHash = await hashFile(effectiveInputPath);
    } catch (error) {
      errors.push(`Input hash check failed: cannot read input path ${effectiveInputPath}.`);
      return errors;
    }

    if (parsedArgs.expectedInputHash && actualInputHash !== parsedArgs.expectedInputHash) {
      errors.push(`Input checksum mismatch (expected ${parsedArgs.expectedInputHash}, got ${actualInputHash}).`);
    }
  }

  return errors;
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseApplyApprovedPreflightArgs(process.argv.slice(2));
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

  const errors = [];
  const allowlistedRoots = deriveAllowlistRoots(parsedArgs.inputPath, parsedArgs.allowlist);

  if (payload.summary.approved !== payload.items.length) {
    errors.push(`Summary mismatch: summary.approved=${payload.summary.approved} but rendered candidates=${payload.items.length}.`);
  }

  if (payload.summary.warnings !== payload.warnings.length) {
    errors.push(`Summary warning mismatch: summary.warnings=${payload.summary.warnings}, actual warnings=${payload.warnings.length}.`);
  }

  if (payload.warnings.length > 0) {
    errors.push(`Preflight blocked because warning count is ${payload.warnings.length}.`);
  }

  for (let index = 0; index < payload.items.length; index += 1) {
    const item = payload.items[index];
    const error = validateResolvedPath(
      item.path,
      dirname(parsedArgs.inputPath),
      allowlistedRoots,
      index,
    );
    if (error) {
      errors.push(error);
    }
  }

  errors.push(...(await validateLineage(payload, parsedArgs, parsedArgs.inputPath)));

  if (errors.length > 0) {
    console.error('Write preflight failed:');
    for (const issue of errors) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  }

  const planHash = computePlanHash(payload);
  console.log('Write preflight passed: apply-approved plan is write-ready candidate.');
  console.log(`Input path: ${payload.inputPath}`);
  console.log(`Approved candidates: ${payload.items.length}`);
  console.log(`Warnings: ${payload.warnings.length}`);
  console.log(`Plan checksum: ${planHash}`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
