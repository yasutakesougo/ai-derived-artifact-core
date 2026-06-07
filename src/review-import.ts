import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { createReviewDecision } from "./lifecycle.js";
import { JsonAuditStore } from "./json-storage.js";
import type {
  ReviewDecision,
  ReviewOutcome,
} from "./types.js";

export interface ReviewImportOptions {
  vaultPath: string;
  reviewFolder?: string;
  sourceFolder?: string;
  dryRun: boolean;
  decidedBy: string;
  reason: string;
  decidedAt: string;
}

export interface ReviewImportItem {
  relativePath: string;
  artifactId: string;
  outcome: ReviewOutcome;
  decision: ReviewDecision;
}

export interface ReviewImportSkip {
  relativePath: string;
  reason: "no_decision_checked";
}

export interface ReviewImportReport {
  items: readonly ReviewImportItem[];
  skipped: readonly ReviewImportSkip[];
  writtenDecisionIds: readonly string[];
  dryRun: boolean;
}

export async function importManualReviewDecisions(
  store: JsonAuditStore,
  options: ReviewImportOptions,
): Promise<ReviewImportReport> {
  validateRequiredText(options.decidedBy, "decidedBy");
  validateRequiredText(options.reason, "reason");
  validateRequiredText(options.decidedAt, "decidedAt");

  const vaultRoot = await realpath(resolve(options.vaultPath));
  const reviewFolder = validateRelativeFolder(
    options.reviewFolder ?? "ai-review",
    "Review folder",
  );
  const sourceFolder = validateRelativeFolder(
    options.sourceFolder ?? "source",
    "Source folder",
  );
  assertSeparateFolders(sourceFolder, reviewFolder);

  const reviewRoot = resolve(vaultRoot, reviewFolder);
  assertContained(vaultRoot, reviewRoot);
  await rejectSymlinkPath(vaultRoot, reviewRoot);

  const markdownFiles = await listMarkdownFiles(reviewRoot);
  const state = await store.reconstructState();
  const items: ReviewImportItem[] = [];
  const skipped: ReviewImportSkip[] = [];

  for (const path of markdownFiles) {
    const relativePath = toPortablePath(relative(vaultRoot, path));
    const parsed = parseReviewMarkdown(await readFile(path, "utf8"));
    if (!parsed.outcome) {
      skipped.push({ relativePath, reason: "no_decision_checked" });
      continue;
    }
    const artifact = state.artifacts.get(parsed.artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${parsed.artifactId}`);
    }
    if (basename(path, ".md") !== parsed.artifactId) {
      throw new Error(`Review filename does not match artifactId: ${relativePath}`);
    }
    if (artifact.artifactHash !== parsed.artifactHash) {
      throw new Error(`Artifact hash mismatch: ${parsed.artifactId}`);
    }
    if (artifact.status !== "proposed") {
      throw new Error(
        `Artifact is not reviewable: ${parsed.artifactId} [${artifact.status}]`,
      );
    }

    const decisionId = deterministicDecisionId(
      parsed.artifactId,
      parsed.outcome,
      options.decidedBy,
      options.decidedAt,
    );
    const decision = createReviewDecision(artifact, parsed.outcome, {
      decisionId,
      decidedBy: options.decidedBy,
      decidedAt: options.decidedAt,
      reason: options.reason,
    }).decision;
    if (await store.readReviewDecision(decisionId)) {
      throw new Error(`ReviewDecision already exists: ${decisionId}`);
    }
    items.push({
      relativePath,
      artifactId: artifact.artifactId,
      outcome: parsed.outcome,
      decision,
    });
  }

  const writtenDecisionIds: string[] = [];
  if (!options.dryRun) {
    for (const item of items) {
      await store.applyReviewDecision(item.decision);
      writtenDecisionIds.push(item.decision.decisionId);
    }
  }

  return {
    items,
    skipped,
    writtenDecisionIds,
    dryRun: options.dryRun,
  };
}

export function parseReviewMarkdown(markdown: string): {
  artifactId: string;
  artifactHash: string;
  outcome?: ReviewOutcome;
} {
  const normalized = markdown.replace(/\r\n?/gu, "\n").replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    throw new Error("Review Markdown requires YAML frontmatter");
  }
  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    throw new Error("Unclosed review frontmatter");
  }
  const parsed = parseYaml(normalized.slice(4, closingIndex));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Review frontmatter must be a YAML mapping");
  }
  const frontmatter = parsed as Record<string, unknown>;
  const artifactId = requireSafeId(frontmatter.artifactId, "artifactId");
  const artifactHash = requireString(frontmatter.artifactHash, "artifactHash");
  const manualReview = extractManualReviewSection(
    normalized.slice(closingIndex + 5),
  );
  const checked = [
    ["approved", isChecked(manualReview, "Approve")],
    ["rejected", isChecked(manualReview, "Reject")],
    ["deferred", isChecked(manualReview, "Defer")],
  ].filter((entry) => entry[1]) as [ReviewOutcome, boolean][];

  if (checked.length > 1) {
    throw new Error(`Multiple review decisions checked: ${artifactId}`);
  }
  return {
    artifactId,
    artifactHash,
    ...(checked[0] ? { outcome: checked[0][0] } : {}),
  };
}

function extractManualReviewSection(body: string): string {
  const heading = /^## Manual Review\s*$/mu.exec(body);
  if (!heading) {
    throw new Error("Manual Review section is missing");
  }
  const sectionStart = heading.index + heading[0].length;
  const remaining = body.slice(sectionStart);
  const nextHeading = /^##\s+/mu.exec(remaining);
  return nextHeading
    ? remaining.slice(0, nextHeading.index)
    : remaining;
}

function isChecked(section: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = section.match(
    new RegExp(`^- \\[([ xX])\\] ${escaped}\\s*$`, "gmu"),
  );
  if (!matches || matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} checkbox`);
  }
  return /\[[xX]\]/u.test(matches[0]);
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("Review folder must not contain symlinks");
    }
    if (entry.isDirectory()) {
      throw new Error("Nested review directories are not supported");
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
}

function deterministicDecisionId(
  artifactId: string,
  outcome: ReviewOutcome,
  decidedBy: string,
  decidedAt: string,
): string {
  const digest = createHash("sha256")
    .update(`${artifactId}:${outcome}:${decidedBy}:${decidedAt}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `review_${digest}`;
}

function validateRequiredText(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`${field} is required`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireSafeId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid ${field}: ${id}`);
  }
  return id;
}

function validateRelativeFolder(folder: string, label: string): string {
  if (
    !folder ||
    isAbsolute(folder) ||
    folder.split(/[\\/]/u).some((part) => part === ".." || part === "")
  ) {
    throw new Error(`${label} must be a safe Vault-relative path`);
  }
  return folder.split(/[\\/]/u).join("/");
}

function assertSeparateFolders(sourceFolder: string, reviewFolder: string): void {
  const source = sourceFolder.split("/");
  const review = reviewFolder.split("/");
  if (isPrefix(source, review) || isPrefix(review, source)) {
    throw new Error("Review folder must not overlap the source folder");
  }
}

function isPrefix(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length <= right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function assertContained(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Review import path escapes the Vault");
  }
}

async function rejectSymlinkPath(root: string, target: string): Promise<void> {
  const segments = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error("Review import path must not contain a symlink");
    }
  }
}

function toPortablePath(value: string): string {
  return value.split(sep).join("/");
}
