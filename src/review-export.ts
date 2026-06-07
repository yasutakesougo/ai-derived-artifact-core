import { mkdir, lstat, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { JsonAuditStore } from "./json-storage.js";
import type {
  ArtifactStatus,
  DerivedArtifact,
  ProposalArtifact,
} from "./types.js";

const EXPORTABLE_STATUSES = new Set<ArtifactStatus>([
  "proposed",
  "stale",
  "obsolete",
]);

export interface ReviewExportOptions {
  vaultPath: string;
  reviewFolder?: string;
  sourceFolder?: string;
  dryRun: boolean;
}

export interface ReviewExportItem {
  artifactId: string;
  status: "proposed" | "stale" | "obsolete";
  relativePath: string;
  markdown: string;
}

export interface ReviewExportReport {
  outputPath: string;
  items: readonly ReviewExportItem[];
  writtenPaths: readonly string[];
  dryRun: boolean;
}

export async function exportReviewMarkdown(
  store: JsonAuditStore,
  options: ReviewExportOptions,
): Promise<ReviewExportReport> {
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

  const outputPath = resolve(vaultRoot, reviewFolder);
  assertContained(vaultRoot, outputPath);
  await rejectSymlinkPath(vaultRoot, outputPath);

  const state = await store.reconstructState();
  const items = [...state.artifacts.values()]
    .filter(
      (artifact): artifact is ProposalArtifact =>
        EXPORTABLE_STATUSES.has(artifact.status) && isProposalArtifact(artifact),
    )
    .map((artifact) => ({
      artifactId: artifact.artifactId,
      status: artifact.status as "proposed" | "stale" | "obsolete",
      relativePath: `${reviewFolder}/${artifact.artifactId}.md`,
      markdown: renderReviewMarkdown(artifact),
    }))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));

  const writtenPaths: string[] = [];
  if (!options.dryRun) {
    await mkdir(outputPath, { recursive: true });
    await rejectSymlinkPath(vaultRoot, outputPath);
    for (const item of items) {
      const destination = resolve(vaultRoot, item.relativePath);
      assertContained(outputPath, destination);
      await writeAtomically(destination, item.markdown);
      writtenPaths.push(item.relativePath);
    }
  }

  return {
    outputPath,
    items,
    writtenPaths,
    dryRun: options.dryRun,
  };
}

export function renderReviewMarkdown(artifact: ProposalArtifact): string {
  const sourceNoteIds = Object.keys(artifact.sourceHashes).sort();
  const frontmatter = stringifyYaml({
    artifactId: artifact.artifactId,
    artifactHash: artifact.artifactHash,
    status: artifact.status,
    kind: artifact.kind,
    sourceNoteIds,
    generatedAt: artifact.generatedAt,
    model: artifact.model,
    ruleVersion: artifact.ruleVersion,
    reviewCriteriaVersion: artifact.reviewCriteriaVersion,
  }).trimEnd();

  const lines = [
    "---",
    frontmatter,
    "---",
    "",
    `# AI Proposal Review: ${artifact.artifactId}`,
    "",
    `> Status: **${artifact.status.toUpperCase()}**`,
  ];

  if (artifact.status === "stale") {
    lines.push(
      "> This artifact was previously approved but its dependencies changed. Re-review is required.",
    );
  } else if (artifact.status === "obsolete") {
    lines.push(
      "> This proposal changed before review and must not be approved. Regenerate it instead.",
    );
  }

  lines.push(
    "",
    "## Proposal",
    "",
    "```json",
    JSON.stringify(artifact.content, null, 2),
    "```",
    "",
    "## Source Notes",
    "",
    ...sourceNoteIds.map(
      (noteId) => `- \`${noteId}\` (\`${artifact.sourceHashes[noteId]}\`)`,
    ),
    "",
    "## Evidence",
    "",
  );

  for (const evidence of artifact.evidence) {
    lines.push(
      `### ${evidence.noteId}`,
      "",
      `Source hash: \`${evidence.sourceHash}\``,
      "",
      `> ${escapeBlockquote(evidence.quote)}`,
      "",
    );
  }

  lines.push(
    "## Confidence",
    "",
    `- Retrieval: ${formatConfidence(artifact.confidence.retrieval)}`,
    `- Reasoning: ${formatConfidence(artifact.confidence.reasoning)}`,
    `- Overall: ${formatConfidence(artifact.confidence.overall)}`,
    "",
    "> Confidence is not proof and does not approve this artifact.",
    "",
    "## Generation",
    "",
    `- Model: \`${artifact.model.provider}/${artifact.model.name}@${artifact.model.version}\``,
    `- Rule version: \`${artifact.ruleVersion}\``,
    `- Review criteria: \`${artifact.reviewCriteriaVersion}\``,
    `- Generated at: \`${artifact.generatedAt}\``,
    "",
    "## Manual Review",
    "",
    "- [ ] Approve",
    "- [ ] Reject",
    "- [ ] Defer",
    "",
    "> Checking a box does not change audit records until the explicit review-import command runs.",
    "",
  );

  return lines.join("\n");
}

function isProposalArtifact(
  artifact: DerivedArtifact,
): artifact is ProposalArtifact {
  const candidate = artifact as Partial<ProposalArtifact>;
  return (
    (candidate.kind === "classification" ||
      candidate.kind === "related_candidate") &&
    Array.isArray(candidate.evidence) &&
    typeof candidate.confidence === "object" &&
    candidate.confidence !== null &&
    typeof candidate.content === "object" &&
    candidate.content !== null &&
    typeof candidate.generatedAt === "string"
  );
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
    throw new Error("Export path escapes the allowed root");
  }
}

async function rejectSymlinkPath(root: string, target: string): Promise<void> {
  const segments = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Review output path must not contain a symlink");
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

function formatConfidence(value: number | null): string {
  return value === null ? "not applicable" : value.toFixed(3);
}

function escapeBlockquote(value: string): string {
  return value.replace(/\n/gu, "\n> ");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
