import path from 'node:path';

export function resolveReviewFilePath(filePath, cwd = process.cwd()) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Review file path must be a non-empty string');
  }

  return path.resolve(cwd, filePath);
}
