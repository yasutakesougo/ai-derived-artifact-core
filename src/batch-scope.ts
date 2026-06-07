export interface BatchScope {
  includePrefix?: string;
  minFiles?: number;
  maxFiles?: number;
}

export function filterBatchNames(
  names: readonly string[],
  scope: BatchScope,
): string[] {
  const selected = scope.includePrefix
    ? names.filter((name) => name.startsWith(scope.includePrefix!))
    : [...names];
  assertBatchCount(selected.length, scope);
  return selected;
}

export function assertBatchCount(count: number, scope: BatchScope): void {
  if (scope.minFiles !== undefined && count < scope.minFiles) {
    throw new Error(
      `Selected batch contains ${count} files; minimum is ${scope.minFiles}.`,
    );
  }
  if (scope.maxFiles !== undefined && count > scope.maxFiles) {
    throw new Error(
      `Selected batch contains ${count} files; maximum is ${scope.maxFiles}.`,
    );
  }
}

export function validateBatchScope(scope: BatchScope): void {
  for (const [name, value] of [
    ["minFiles", scope.minFiles],
    ["maxFiles", scope.maxFiles],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative integer.`);
    }
  }
  if (
    scope.minFiles !== undefined &&
    scope.maxFiles !== undefined &&
    scope.minFiles > scope.maxFiles
  ) {
    throw new Error("minFiles must not exceed maxFiles.");
  }
  if (scope.includePrefix !== undefined && !scope.includePrefix.trim()) {
    throw new Error("includePrefix must not be empty.");
  }
}

export function parseOptionalCount(
  value: string | undefined,
  optionName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }
  return parsed;
}
