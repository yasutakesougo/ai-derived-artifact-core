import { resolveCliPath } from './nvidia-nim-paths.mjs';

export function parseBatchReviewArgs(args, cwd = process.cwd()) {
  const files = [];
  let outPath = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--out') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --out');
      }
      outPath = resolveCliPath(value, cwd, '--out path');
      index += 1;
      continue;
    }

    if (arg?.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) {
        throw new Error('Missing value for --out');
      }
      outPath = resolveCliPath(value, cwd, '--out path');
      continue;
    }

    if (arg?.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (arg) {
      files.push(arg);
    }
  }

  return { files, outPath };
}

export function formatBatchReviewJsonl(results) {
  if (results.length === 0) {
    return '';
  }

  return `${results.map((result) => JSON.stringify(result)).join('\n')}\n`;
}
