import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JsonAuditStore,
  createReviewDecision,
  runCli,
  type DerivedArtifact,
  type SourceNote,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

let root: string;
let recordsPath: string;
let store: JsonAuditStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-cli-"));
  recordsPath = join(root, "records");
  store = new JsonAuditStore(recordsPath);
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function note(version: number): SourceNote {
  return {
    noteId: "note_A",
    sourceVersion: version,
    sourceHash: `sha256:source-v${version}`,
    knowledgeType: "observation",
    createdAt: "2026-06-06T21:00:00+09:00",
    updatedAt: `2026-06-06T21:0${version}:00+09:00`,
    immutablePolicy: "ai_must_not_edit_body",
    body: `version ${version}`,
  };
}

function artifact(
  artifactId: string,
  status: "proposed" | "approved" = "proposed",
): DerivedArtifact {
  return {
    artifactId,
    artifactHash: `sha256:${artifactId}`,
    status,
    sourceHashes: { note_A: "sha256:source-v1" },
    referencedArtifactHashes: {},
    relationships: [],
    model: { provider: "ollama", name: "qwen3", version: "model-v1" },
    ruleVersion: "rule-v1",
    reviewCriteriaVersion: "review-v1",
  };
}

async function seedCandidates(): Promise<void> {
  await store.saveSourceNote(note(1));
  await store.saveSourceNote(note(2));
  await store.saveArtifact(artifact("artifact_proposed"));
  await store.saveArtifact(artifact("artifact_approved"));
  const reviewed = createReviewDecision(
    artifact("artifact_approved"),
    "approved",
    {
      decisionId: "decision_approved",
      decidedBy: "user_A",
      decidedAt: "2026-06-06T21:30:00+09:00",
      reason: "Evidence reviewed",
    },
  );
  await store.applyReviewDecision(reviewed.decision);
}

describe("freshness dry-run CLI", () => {
  it("lists stale and obsolete candidates with exit code zero", async () => {
    await seedCandidates();
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli(
      ["freshness", "--dry-run", "--records", recordsPath],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("artifact_approved: approved -> stale");
    expect(stdout).toContain("artifact_proposed: proposed -> obsolete");
    expect(stdout).toContain("source_hash_changed");
    expect(stdout).toContain("No files were modified.");
  });

  it("runs through the npm command without modifying records", async () => {
    await seedCandidates();
    const before = await snapshotDirectory(recordsPath);

    const result = await execFileAsync(
      "npm",
      [
        "run",
        "cli",
        "--",
        "freshness",
        "--dry-run",
        "--records",
        recordsPath,
      ],
      {
        cwd: process.cwd(),
      },
    );

    const after = await snapshotDirectory(recordsPath);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Candidates: 2");
    expect(after).toEqual(before);
  });

  it("uses non-zero exit code only for invalid input or execution errors", async () => {
    let stderr = "";
    const exitCode = await runCli(["freshness"], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  it("can evaluate model and policy changes supplied by CLI options", async () => {
    await store.saveSourceNote(note(1));
    await store.saveArtifact(artifact("artifact_proposed"));
    let stdout = "";

    const exitCode = await runCli(
      [
        "freshness",
        "--dry-run",
        "--records",
        recordsPath,
        "--model-provider",
        "ollama",
        "--model-name",
        "qwen3",
        "--model-version",
        "model-v2",
        "--rule-version",
        "rule-v2",
        "--review-criteria-version",
        "review-v2",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("model_changed");
    expect(stdout).toContain("rule_version_changed");
    expect(stdout).toContain("review_criteria_changed");
  });
});

async function snapshotDirectory(
  directory: string,
): Promise<Record<string, { content: string; mtimeMs: number }>> {
  const snapshot: Record<string, { content: string; mtimeMs: number }> = {};
  await walk(directory, directory, snapshot);
  return snapshot;
}

async function walk(
  rootDirectory: string,
  currentDirectory: string,
  snapshot: Record<string, { content: string; mtimeMs: number }>,
): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      await walk(rootDirectory, absolute, snapshot);
      continue;
    }
    const relative = absolute.slice(rootDirectory.length + 1);
    snapshot[relative] = {
      content: await readFile(absolute, "utf8"),
      mtimeMs: (await stat(absolute)).mtimeMs,
    };
  }
}
