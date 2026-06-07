import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JsonAuditStore,
  createObsolescenceEvent,
  createReviewDecision,
  createStalenessEvent,
  evaluateArtifactFreshness,
  exportReviewMarkdown,
  renderReviewMarkdown,
  runCli,
  type CurrentDependencies,
  type ProposalArtifact,
} from "../src/index.js";

let root: string;
let vault: string;
let records: string;
let store: JsonAuditStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "review-export-"));
  vault = join(root, "Vault");
  records = join(root, "records");
  await mkdir(join(vault, "source"), { recursive: true });
  await writeFile(
    join(vault, "source", "note_A.md"),
    "---\nnoteId: note_A\n---\nOriginal source\n",
    "utf8",
  );
  store = new JsonAuditStore(records);
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("review Markdown export", () => {
  it("renders required metadata, evidence, confidence, and manual checkboxes", () => {
    const markdown = renderReviewMarkdown(proposal("artifact_A"));

    expect(markdown).toContain("artifactId: artifact_A");
    expect(markdown).toContain("artifactHash:");
    expect(markdown).toContain("sourceNoteIds:");
    expect(markdown).toContain("## Evidence");
    expect(markdown).toContain("Evidence excerpt");
    expect(markdown).toContain("Retrieval: 0.700");
    expect(markdown).toContain("stub/generator@v1");
    expect(markdown).toContain("Rule version: `stub-v1`");
    expect(markdown).toContain("- [ ] Approve");
    expect(markdown).toContain("- [ ] Reject");
    expect(markdown).toContain("- [ ] Defer");
    expect(markdown).toContain("explicit review-import command");
  });

  it("exports proposed artifacts from audit records", async () => {
    await store.saveArtifact(proposal("artifact_A"));

    const report = await exportReviewMarkdown(store, {
      vaultPath: vault,
      dryRun: false,
    });

    expect(report.writtenPaths).toEqual(["ai-review/artifact_A.md"]);
    const markdown = await readFile(
      join(vault, "ai-review", "artifact_A.md"),
      "utf8",
    );
    expect(markdown).toContain("Status: **PROPOSED**");
  });

  it("marks stale and obsolete artifacts explicitly", async () => {
    await saveAsStale(proposal("artifact_stale"));
    await saveAsObsolete(proposal("artifact_obsolete"));

    const report = await exportReviewMarkdown(store, {
      vaultPath: vault,
      dryRun: true,
    });

    const stale = report.items.find(
      (item) => item.artifactId === "artifact_stale",
    );
    const obsolete = report.items.find(
      (item) => item.artifactId === "artifact_obsolete",
    );
    expect(stale?.markdown).toContain("Status: **STALE**");
    expect(stale?.markdown).toContain("Re-review is required");
    expect(obsolete?.markdown).toContain("Status: **OBSOLETE**");
    expect(obsolete?.markdown).toContain("must not be approved");
  });

  it("does not create or modify files during dry-run", async () => {
    await store.saveArtifact(proposal("artifact_A"));
    const before = await snapshot(vault);

    const report = await exportReviewMarkdown(store, {
      vaultPath: vault,
      dryRun: true,
    });

    expect(report.items).toHaveLength(1);
    expect(report.writtenPaths).toHaveLength(0);
    expect(await snapshot(vault)).toEqual(before);
    await expect(readdir(join(vault, "ai-review"))).rejects.toThrow();
  });

  it("writes only to the dedicated review folder and preserves source", async () => {
    await store.saveArtifact(proposal("artifact_A"));
    const sourceBefore = await snapshot(join(vault, "source"));

    await exportReviewMarkdown(store, {
      vaultPath: vault,
      reviewFolder: "review-output",
      sourceFolder: "source",
      dryRun: false,
    });

    expect(await snapshot(join(vault, "source"))).toEqual(sourceBefore);
    expect(await readdir(join(vault, "review-output"))).toEqual([
      "artifact_A.md",
    ]);
  });

  it("rejects traversal, absolute paths, and overlap with source", async () => {
    for (const reviewFolder of [
      "../escape",
      join(root, "absolute"),
      "source",
      "source/ai-review",
    ]) {
      await expect(
        exportReviewMarkdown(store, {
          vaultPath: vault,
          reviewFolder,
          sourceFolder: "source",
          dryRun: false,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects symlinks in the review output path", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(vault, "ai-review"));

    await expect(
      exportReviewMarkdown(store, {
        vaultPath: vault,
        dryRun: false,
      }),
    ).rejects.toThrow("symlink");
    expect(await readdir(outside)).toHaveLength(0);
  });

  it("supports CLI dry-run without creating the review folder", async () => {
    await store.saveArtifact(proposal("artifact_A"));
    let stdout = "";

    const exitCode = await runCli(
      [
        "review-export",
        "--dry-run",
        "--vault",
        vault,
        "--records",
        records,
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Review export dry-run");
    expect(stdout).toContain("artifact_A: proposed -> ai-review/artifact_A.md");
    expect(stdout).toContain("No files were modified.");
    await expect(readdir(join(vault, "ai-review"))).rejects.toThrow();
  });
});

function proposal(artifactId: string): ProposalArtifact {
  return {
    artifactId,
    artifactHash: `sha256:${"a".repeat(64)}`,
    status: "proposed",
    sourceHashes: { note_A: "sha256:source-v1" },
    referencedArtifactHashes: {},
    relationships: [],
    model: { provider: "stub", name: "generator", version: "v1" },
    ruleVersion: "stub-v1",
    reviewCriteriaVersion: "review-v1",
    kind: "classification",
    knowledgeType: "interpretation",
    content: {
      classification: "observation",
      statement: "Classification candidate",
    },
    confidence: { retrieval: 0.7, reasoning: 0.5, overall: 0.6 },
    evidence: [
      {
        noteId: "note_A",
        sourceHash: "sha256:source-v1",
        quote: "Evidence excerpt",
      },
    ],
    generatedAt: "2026-06-06T22:00:00+09:00",
  };
}

function changedDependencies(): CurrentDependencies {
  return {
    sourceHashes: { note_A: "sha256:source-v2" },
    referencedArtifacts: {},
    model: { provider: "stub", name: "generator", version: "v1" },
    ruleVersion: "stub-v1",
    reviewCriteriaVersion: "review-v1",
  };
}

async function saveAsStale(artifact: ProposalArtifact): Promise<void> {
  await store.saveArtifact(artifact);
  const reviewed = createReviewDecision(artifact, "approved", {
    decisionId: `decision_${artifact.artifactId}`,
    decidedBy: "user_A",
    decidedAt: "2026-06-06T22:10:00+09:00",
    reason: "Reviewed",
  });
  const approved = await store.applyReviewDecision(reviewed.decision);
  const event = createStalenessEvent(
    approved,
    evaluateArtifactFreshness(approved, changedDependencies()),
    {
      eventId: `event_${artifact.artifactId}`,
      occurredAt: "2026-06-06T22:20:00+09:00",
      detectedBy: "staleness-evaluator-v1",
    },
  );
  await store.applyLifecycleEvent(event);
}

async function saveAsObsolete(artifact: ProposalArtifact): Promise<void> {
  await store.saveArtifact(artifact);
  const event = createObsolescenceEvent(
    artifact,
    evaluateArtifactFreshness(artifact, changedDependencies()),
    {
      eventId: `event_${artifact.artifactId}`,
      occurredAt: "2026-06-06T22:20:00+09:00",
      detectedBy: "dependency-evaluator-v1",
    },
  );
  await store.applyLifecycleEvent(event);
}

async function snapshot(
  directory: string,
): Promise<Record<string, { content: string; mtimeMs: number }>> {
  const result: Record<string, { content: string; mtimeMs: number }> = {};
  await walk(directory, directory, result);
  return result;
}

async function walk(
  rootDirectory: string,
  currentDirectory: string,
  result: Record<string, { content: string; mtimeMs: number }>,
): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      await walk(rootDirectory, absolute, result);
      continue;
    }
    const relative = absolute.slice(rootDirectory.length + 1);
    result[relative] = {
      content: await readFile(absolute, "utf8"),
      mtimeMs: (await stat(absolute)).mtimeMs,
    };
  }
}
