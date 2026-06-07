import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JsonAuditStore,
  generateProposalDrafts,
  hashSourceBody,
  runCli,
  validateProposalArtifact,
  type ProposalArtifact,
  type SourceNote,
} from "../src/index.js";

let root: string;
let vault: string;
let records: string;
let store: JsonAuditStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "proposal-pipeline-"));
  vault = join(root, "Vault");
  records = join(root, "records");
  await mkdir(join(vault, "source"), { recursive: true });
  store = new JsonAuditStore(records);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("stub proposal generation pipeline", () => {
  it("generates classification and related drafts for hash-matched notes", async () => {
    await seedNote(
      "note_A",
      "Observation about classroom anxiety and stopping.\n",
      "observation",
    );
    await seedNote(
      "note_B",
      "Another classroom observation about stopping and anxiety.\n",
      "research",
    );

    const report = await generateProposalDrafts(store, options(true));

    expect(report.eligibleNotes).toBe(2);
    expect(report.drafts).toHaveLength(3);
    expect(report.drafts.filter((draft) => draft.kind === "classification"))
      .toHaveLength(2);
    expect(report.drafts.filter((draft) => draft.kind === "related_candidate"))
      .toHaveLength(1);
    for (const draft of report.drafts) {
      expect(draft.status).toBe("proposed");
      expect(draft.evidence.length).toBeGreaterThan(0);
      expect(draft.confidence).toHaveProperty("retrieval");
      expect(draft.confidence).toHaveProperty("reasoning");
      expect(draft.confidence).toHaveProperty("overall");
      expect(draft.confidence.overall).toEqual(expect.any(Number));
      expect(draft.artifactHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
  });

  it("skips missing noteId, missing SourceNote, and source hash mismatches", async () => {
    await writeFile(
      join(vault, "source", "missing-id.md"),
      "---\ntype: observation\n---\nNo ID\n",
      "utf8",
    );
    await writeVaultNote("not-recorded", "No stored SourceNote\n", "research");
    await writeVaultNote("mismatch", "Current body\n", "observation");
    await store.saveSourceNote(
      sourceRecord("mismatch", "Different stored body\n"),
    );

    const report = await generateProposalDrafts(store, options(true));

    expect(report.drafts).toHaveLength(0);
    expect(report.skipped.map((item) => item.reason)).toEqual(
      expect.arrayContaining([
        "missing_note_id",
        "source_note_missing",
        "source_hash_mismatch",
      ]),
    );
  });

  it("does not modify Vault or records during dry-run", async () => {
    await seedNote("note_A", "Read-only observation\n", "observation");
    const before = await snapshot(root);

    const report = await generateProposalDrafts(store, options(true));

    expect(report.writtenArtifactIds).toHaveLength(0);
    expect(await snapshot(root)).toEqual(before);
  });

  it("writes only proposed artifacts in records/artifacts", async () => {
    await seedNote("note_A", "Stored observation\n", "observation");
    const vaultBefore = await snapshot(vault);
    const sourceBefore = await snapshot(join(records, "source-notes"));
    const reviewsBefore = await snapshot(join(records, "reviews"));
    const eventsBefore = await snapshot(join(records, "events"));

    const report = await generateProposalDrafts(store, options(false));

    expect(report.writtenArtifactIds).toHaveLength(1);
    const artifact = await store.readArtifact(report.writtenArtifactIds[0]!);
    expect(artifact?.status).toBe("proposed");
    expect(await snapshot(vault)).toEqual(vaultBefore);
    expect(await snapshot(join(records, "source-notes"))).toEqual(sourceBefore);
    expect(await snapshot(join(records, "reviews"))).toEqual(reviewsBefore);
    expect(await snapshot(join(records, "events"))).toEqual(eventsBefore);
    expect((await readdir(join(records, "artifacts")))).toHaveLength(1);
  });

  it("rejects drafts without evidence, separated confidence, or proposed status", () => {
    const valid = sampleProposal();
    expect(() => validateProposalArtifact(valid)).not.toThrow();
    expect(() =>
      validateProposalArtifact({ ...valid, evidence: [] }),
    ).toThrow("evidence");
    expect(() =>
      validateProposalArtifact({ ...valid, status: "approved" }),
    ).toThrow("proposed");
    expect(() =>
      validateProposalArtifact({
        ...valid,
        confidence: { retrieval: 1.2, reasoning: 0.5, overall: 0.8 },
      }),
    ).toThrow("confidence.retrieval");
  });

  it("produces deterministic IDs and hashes for identical inputs", async () => {
    await seedNote("note_A", "Deterministic body\n", "observation");

    const first = await generateProposalDrafts(store, options(true));
    const second = await generateProposalDrafts(store, options(true));

    expect(second.drafts).toEqual(first.drafts);
  });

  it("supports CLI dry-run without writing artifacts", async () => {
    await seedNote("note_A", "CLI body\n", "observation");
    let stdout = "";

    const exitCode = await runCli(
      [
        "proposals",
        "--dry-run",
        "--vault",
        vault,
        "--records",
        records,
        "--generated-at",
        "2026-06-06T22:00:00+09:00",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Proposal generation dry-run");
    expect(stdout).toContain("classification [proposed]");
    expect(stdout).toContain("No files were modified.");
    expect(await readdir(join(records, "artifacts"))).toHaveLength(0);
  });
  it("includes metrics in the generation report", async () => {
    await seedNote(
      "note_A",
      "Observation about classroom anxiety and stopping.\n",
      "observation",
    );
    await seedNote(
      "note_B",
      "Another classroom observation about stopping and anxiety.\n",
      "research",
    );

    const report = await generateProposalDrafts(store, options(true));

    expect(report.metrics).toBeDefined();
    const m = report.metrics!;
    expect(m.scannedNotes).toBe(2);
    expect(m.notesWithNoteId).toBe(2);
    expect(m.notesMissingNoteId).toBe(0);
    expect(m.proposalsGenerated).toBeGreaterThanOrEqual(m.proposalsExported);
    expect(m.proposalsExported).toBe(report.drafts.length);
    expect(m.averageLabelsPerProposal).toBeGreaterThanOrEqual(0);
    expect(m.maxLabelsPerProposal).toBeGreaterThanOrEqual(0);
    expect(m.evidenceAverageLength).toBeGreaterThan(0);
    expect(m.evidenceMaxLength).toBeGreaterThan(0);
  });

  it("suppresses proposals below the confidence threshold", async () => {
    await seedNote(
      "note_A",
      "Observation about classroom anxiety and stopping.\n",
      "observation",
    );
    await seedNote(
      "note_B",
      "Another classroom observation about stopping and anxiety.\n",
      "research",
    );

    const report = await generateProposalDrafts(store, {
      ...options(true),
      confidenceThreshold: 0.99,
    });

    // Stub classification confidence is 0.5, related is even lower
    expect(report.drafts).toHaveLength(0);
    expect(report.metrics!.proposalsSuppressedByConfidence).toBeGreaterThan(0);
  });

  it("enforces maxProposalsPerNote=1 (keeps highest confidence per note)", async () => {
    await seedNote(
      "note_A",
      "Observation about classroom anxiety and stopping.\n",
      "observation",
    );
    await seedNote(
      "note_B",
      "Another classroom observation about stopping and anxiety.\n",
      "research",
    );

    const report = await generateProposalDrafts(store, {
      ...options(true),
      maxProposalsPerNote: 1,
    });

    // Each note can only appear in 1 proposal
    // The related_candidate references both notes, so at most 2 individual
    // classification drafts OR 1 related_candidate.
    // Since classifications have higher confidence (0.5) than related (~0.25),
    // both classifications should be kept and the related suppressed.
    expect(report.drafts.length).toBeLessThanOrEqual(2);
    const noteIds = new Set<string>();
    for (const draft of report.drafts) {
      for (const noteId of Object.keys(draft.sourceHashes)) {
        noteIds.add(noteId);
      }
    }
    // Each note appears at most once
    for (const draft of report.drafts) {
      const sourceNotes = Object.keys(draft.sourceHashes);
      for (const noteId of sourceNotes) {
        const count = report.drafts.filter(d =>
          Object.keys(d.sourceHashes).includes(noteId),
        ).length;
        expect(count).toBeLessThanOrEqual(1);
      }
    }
  });

  it("formats metrics in CLI output", async () => {
    await seedNote("note_A", "CLI metrics body\n", "observation");
    let stdout = "";

    const exitCode = await runCli(
      [
        "proposals",
        "--dry-run",
        "--vault",
        vault,
        "--records",
        records,
        "--generated-at",
        "2026-06-06T22:00:00+09:00",
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("--- metrics ---");
    expect(stdout).toContain("scannedNotes:");
    expect(stdout).toContain("proposalsExported:");
    expect(stdout).toContain("evidenceMaxLength:");
  });
});

function options(dryRun: boolean) {
  return {
    vaultPath: vault,
    dryRun,
    generatedAt: "2026-06-06T22:00:00+09:00",
  };
}

async function seedNote(
  noteId: string,
  body: string,
  type: string,
): Promise<void> {
  await writeVaultNote(noteId, body, type);
  await store.saveSourceNote(sourceRecord(noteId, body));
}

async function writeVaultNote(
  noteId: string,
  body: string,
  type: string,
): Promise<void> {
  await writeFile(
    join(vault, "source", `${noteId}.md`),
    `---\nnoteId: ${noteId}\ntype: ${type}\n---\n${body}`,
    "utf8",
  );
}

function sourceRecord(noteId: string, body: string): SourceNote {
  return {
    noteId,
    sourceVersion: 1,
    sourceHash: hashSourceBody(body),
    knowledgeType: "observation",
    createdAt: "2026-06-06T21:00:00+09:00",
    updatedAt: "2026-06-06T21:00:00+09:00",
    immutablePolicy: "ai_must_not_edit_body",
    body,
  };
}

function sampleProposal(): ProposalArtifact {
  return {
    artifactId: "draft_classification_sample",
    artifactHash: `sha256:${"a".repeat(64)}`,
    status: "proposed",
    sourceHashes: { note_A: "sha256:source" },
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
        sourceHash: "sha256:source",
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
