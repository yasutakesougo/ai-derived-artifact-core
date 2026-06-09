import path from 'node:path';

export function resolveCliPath(filePath, cwd = process.cwd(), label = 'Path') {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }

  return path.resolve(cwd, filePath);
}

export function resolveReviewFilePath(filePath, cwd = process.cwd()) {
  return resolveCliPath(filePath, cwd, 'Review file path');
}
