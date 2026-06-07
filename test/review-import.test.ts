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
  importManualReviewDecisions,
  parseReviewMarkdown,
  renderReviewMarkdown,
  runCli,
  type ProposalArtifact,
} from "../src/index.js";

let root: string;
let vault: string;
let records: string;
let store: JsonAuditStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "review-import-"));
  vault = join(root, "Vault");
  records = join(root, "records");
  await mkdir(join(vault, "source"), { recursive: true });
  await mkdir(join(vault, "ai-review"), { recursive: true });
  await writeFile(join(vault, "source", "note.md"), "Original\n", "utf8");
  store = new JsonAuditStore(records);
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("manual review import", () => {
  it.each([
    ["Approve", "approved"],
    ["Reject", "rejected"],
    ["Defer", "deferred"],
  ] as const)("parses one checked %s decision", (label, outcome) => {
    const markdown = check(renderReviewMarkdown(proposal("artifact_A")), label);
    expect(parseReviewMarkdown(markdown).outcome).toBe(outcome);
  });

  it("rejects multiple checked decisions", () => {
    const markdown = check(
      check(renderReviewMarkdown(proposal("artifact_A")), "Approve"),
      "Reject",
    );
    expect(() => parseReviewMarkdown(markdown)).toThrow("Multiple");
  });

  it("skips a review note when no decision is checked", async () => {
    await seedReview(proposal("artifact_A"));

    const report = await importManualReviewDecisions(store, importOptions(true));

    expect(report.items).toHaveLength(0);
    expect(report.skipped).toEqual([
      {
        relativePath: "ai-review/artifact_A.md",
        reason: "no_decision_checked",
      },
    ]);
  });

  it("creates an append-only ReviewDecision and updates status through the store API", async () => {
    await seedReview(proposal("artifact_A"), "Approve");
    const sourceBefore = await snapshot(join(vault, "source"));

    const report = await importManualReviewDecisions(
      store,
      importOptions(false),
    );

    expect(report.writtenDecisionIds).toHaveLength(1);
    expect((await store.readArtifact("artifact_A"))?.status).toBe("approved");
    const decision = await store.readReviewDecision(
      report.writtenDecisionIds[0]!,
    );
    expect(decision).toMatchObject({
      artifactId: "artifact_A",
      decision: "approved",
      decidedBy: "reviewer_A",
      reason: "Evidence checked",
    });
    expect(await snapshot(join(vault, "source"))).toEqual(sourceBefore);
    await expect(
      importManualReviewDecisions(store, importOptions(false)),
    ).rejects.toThrow();
  });

  it("does not modify records or source during dry-run", async () => {
    await seedReview(proposal("artifact_A"), "Reject");
    const beforeRecords = await snapshot(records);
    const beforeSource = await snapshot(join(vault, "source"));

    const report = await importManualReviewDecisions(store, importOptions(true));

    expect(report.items[0]?.outcome).toBe("rejected");
    expect(report.writtenDecisionIds).toHaveLength(0);
    expect(await snapshot(records)).toEqual(beforeRecords);
    expect(await snapshot(join(vault, "source"))).toEqual(beforeSource);
  });

  it("requires decidedBy, reason, and decidedAt", async () => {
    await seedReview(proposal("artifact_A"), "Approve");
    for (const override of [
      { decidedBy: "" },
      { reason: "" },
      { decidedAt: "" },
    ]) {
      await expect(
        importManualReviewDecisions(store, {
          ...importOptions(true),
          ...override,
        }),
      ).rejects.toThrow("required");
    }
  });

  it("rejects an artifactHash mismatch", async () => {
    await seedReview(proposal("artifact_A"), "Approve");
    const path = join(vault, "ai-review", "artifact_A.md");
    const markdown = await readFile(path, "utf8");
    await writeFile(
      path,
      markdown.replace(`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`),
      "utf8",
    );

    await expect(
      importManualReviewDecisions(store, importOptions(false)),
    ).rejects.toThrow("hash mismatch");
    expect((await store.readArtifact("artifact_A"))?.status).toBe("proposed");
  });

  it("validates every file before writing any decision", async () => {
    await seedReview(proposal("artifact_A"), "Approve");
    await seedReview(proposal("artifact_B"), "Approve");
    const invalidPath = join(vault, "ai-review", "artifact_B.md");
    const invalid = await readFile(invalidPath, "utf8");
    await writeFile(
      invalidPath,
      check(invalid, "Reject"),
      "utf8",
    );

    await expect(
      importManualReviewDecisions(store, importOptions(false)),
    ).rejects.toThrow("Multiple");
    expect((await store.readArtifact("artifact_A"))?.status).toBe("proposed");
    expect(await readdir(join(records, "reviews"))).toHaveLength(0);
  });

  it("rejects traversal, source overlap, and symlink review paths", async () => {
    await expect(
      importManualReviewDecisions(store, {
        ...importOptions(true),
        reviewFolder: "../escape",
      }),
    ).rejects.toThrow();
    await expect(
      importManualReviewDecisions(store, {
        ...importOptions(true),
        reviewFolder: "source",
      }),
    ).rejects.toThrow("overlap");

    await rm(join(vault, "ai-review"), { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(vault, "ai-review"));
    await expect(
      importManualReviewDecisions(store, importOptions(true)),
    ).rejects.toThrow("symlink");
  });

  it("supports CLI dry-run and reports the planned decision", async () => {
    await seedReview(proposal("artifact_A"), "Defer");
    let stdout = "";

    const exitCode = await runCli(
      [
        "review-import",
        "--dry-run",
        "--vault",
        vault,
        "--records",
        records,
        "--decided-by",
        "reviewer_A",
        "--reason",
        "Evidence checked",
        "--decided-at",
        "2026-06-06T23:00:00+09:00",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Review import dry-run");
    expect(stdout).toContain("artifact_A: deferred");
    expect(stdout).toContain("No records were modified.");
    expect((await store.readArtifact("artifact_A"))?.status).toBe("proposed");
  });
});

async function seedReview(
  artifact: ProposalArtifact,
  checked?: "Approve" | "Reject" | "Defer",
): Promise<void> {
  await store.saveArtifact(artifact);
  const markdown = renderReviewMarkdown(artifact);
  await writeFile(
    join(vault, "ai-review", `${artifact.artifactId}.md`),
    checked ? check(markdown, checked) : markdown,
    "utf8",
  );
}

function check(markdown: string, label: string): string {
  return markdown.replace(`- [ ] ${label}`, `- [x] ${label}`);
}

function importOptions(dryRun: boolean) {
  return {
    vaultPath: vault,
    dryRun,
    decidedBy: "reviewer_A",
    reason: "Evidence checked",
    decidedAt: "2026-06-06T23:00:00+09:00",
  };
}

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
    content: { classification: "observation" },
    confidence: { retrieval: null, reasoning: 0.5, overall: 0.5 },
    evidence: [
      {
        noteId: "note_A",
        sourceHash: "sha256:source-v1",
        quote: "Evidence",
      },
    ],
    generatedAt: "2026-06-06T22:00:00+09:00",
  };
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
