import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JsonAuditStore,
  createReviewDecision,
  createStalenessEvent,
  evaluateArtifactFreshness,
  type CurrentDependencies,
  type DerivedArtifact,
  type SourceNote,
} from "../src/index.js";

let root: string;
let store: JsonAuditStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-store-"));
  store = new JsonAuditStore(join(root, "records"));
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sourceNote(version = 1): SourceNote {
  return {
    noteId: "note_A",
    sourceVersion: version,
    sourceHash: `sha256:source-v${version}`,
    knowledgeType: "observation",
    createdAt: "2026-06-06T21:00:00+09:00",
    updatedAt: `2026-06-06T21:0${version}:00+09:00`,
    immutablePolicy: "ai_must_not_edit_body",
    body: `Observed text version ${version}`,
  };
}

function artifact(): DerivedArtifact {
  return {
    artifactId: "artifact_A",
    artifactHash: "sha256:artifact-v1",
    status: "proposed",
    sourceHashes: { note_A: "sha256:source-v1" },
    referencedArtifactHashes: {},
    relationships: [],
    model: { provider: "ollama", name: "qwen3", version: "model-v1" },
    ruleVersion: "rule-v1",
    reviewCriteriaVersion: "review-v1",
  };
}

function changedDependencies(): CurrentDependencies {
  return {
    sourceHashes: { note_A: "sha256:source-v2" },
    referencedArtifacts: {},
    model: { provider: "ollama", name: "qwen3", version: "model-v1" },
    ruleVersion: "rule-v1",
    reviewCriteriaVersion: "review-v1",
  };
}

describe("JSON audit storage", () => {
  it("saves and reads SourceNote versions by ID", async () => {
    await store.saveSourceNote(sourceNote(1));
    await store.saveSourceNote(sourceNote(2));

    expect(await store.readSourceNote("note_A", 1)).toEqual(sourceNote(1));
    expect(await store.readSourceNote("note_A")).toEqual(sourceNote(2));
  });

  it("saves and reads a DerivedArtifact by ID", async () => {
    await store.saveArtifact(artifact());
    expect(await store.readArtifact("artifact_A")).toEqual(artifact());
  });

  it("saves and reads ReviewDecision and lifecycle events by ID", async () => {
    const reviewed = createReviewDecision(artifact(), "approved", {
      decisionId: "decision_A",
      decidedBy: "user_A",
      decidedAt: "2026-06-06T21:30:00+09:00",
      reason: "Evidence reviewed",
    });
    const evaluation = evaluateArtifactFreshness(
      reviewed.artifact,
      changedDependencies(),
    );
    const event = createStalenessEvent(reviewed.artifact, evaluation, {
      eventId: "event_A",
      occurredAt: "2026-06-06T22:00:00+09:00",
      detectedBy: "staleness-evaluator-v1",
    });

    await store.appendReviewDecision(reviewed.decision);
    await store.appendLifecycleEvent(event);

    expect(await store.readReviewDecision("decision_A")).toEqual(
      reviewed.decision,
    );
    expect(await store.readLifecycleEvent("event_A")).toEqual(event);
  });

  it("rejects overwrite of every append-only record", async () => {
    const note = sourceNote();
    await store.saveSourceNote(note);
    await expect(store.saveSourceNote(note)).rejects.toThrow("Append-only");

    const reviewed = createReviewDecision(artifact(), "approved", {
      decisionId: "decision_A",
      decidedBy: "user_A",
      decidedAt: "2026-06-06T21:30:00+09:00",
      reason: "Evidence reviewed",
    });
    await store.appendReviewDecision(reviewed.decision);
    await expect(
      store.appendReviewDecision(reviewed.decision),
    ).rejects.toThrow("Append-only");
  });

  it("updates artifact status only through a review transition API", async () => {
    await store.saveArtifact(artifact());
    const reviewed = createReviewDecision(artifact(), "approved", {
      decisionId: "decision_A",
      decidedBy: "user_A",
      decidedAt: "2026-06-06T21:30:00+09:00",
      reason: "Evidence reviewed",
    });

    const updated = await store.applyReviewDecision(reviewed.decision);

    expect(updated.status).toBe("approved");
    expect((await store.readArtifact("artifact_A"))?.status).toBe("approved");
    expect(await store.readReviewDecision("decision_A")).toEqual(
      reviewed.decision,
    );
  });

  it("updates approved status only through a lifecycle event API", async () => {
    await store.saveArtifact(artifact());
    const reviewed = createReviewDecision(artifact(), "approved", {
      decisionId: "decision_A",
      decidedBy: "user_A",
      decidedAt: "2026-06-06T21:30:00+09:00",
      reason: "Evidence reviewed",
    });
    const approved = await store.applyReviewDecision(reviewed.decision);
    const evaluation = evaluateArtifactFreshness(
      approved,
      changedDependencies(),
    );
    const event = createStalenessEvent(approved, evaluation, {
      eventId: "event_A",
      occurredAt: "2026-06-06T22:00:00+09:00",
      detectedBy: "staleness-evaluator-v1",
    });

    const updated = await store.applyLifecycleEvent(event);

    expect(updated.status).toBe("stale");
    expect((await store.readArtifact("artifact_A"))?.status).toBe("stale");
  });

  it("reconstructs current state from audit records without trusting projection", async () => {
    await store.saveSourceNote(sourceNote(1));
    await store.saveSourceNote(sourceNote(2));
    await store.saveArtifact(artifact());
    const reviewed = createReviewDecision(artifact(), "approved", {
      decisionId: "decision_A",
      decidedBy: "user_A",
      decidedAt: "2026-06-06T21:30:00+09:00",
      reason: "Evidence reviewed",
    });
    await store.applyReviewDecision(reviewed.decision);

    const artifactPath = join(
      root,
      "records",
      "artifacts",
      "artifact_A.json",
    );
    const stored = JSON.parse(await readFile(artifactPath, "utf8")) as DerivedArtifact;
    await writeFile(
      artifactPath,
      `${JSON.stringify({ ...stored, status: "proposed" }, null, 2)}\n`,
      "utf8",
    );

    const state = await store.reconstructState();

    expect(state.sourceNotes.get("note_A")?.sourceVersion).toBe(2);
    expect(state.artifacts.get("artifact_A")?.status).toBe("approved");
    expect(state.reviews).toHaveLength(1);
  });

  it("reconstructs approved then stale transitions in audit order", async () => {
    await store.saveArtifact(artifact());
    const reviewed = createReviewDecision(artifact(), "approved", {
      decisionId: "decision_A",
      decidedBy: "user_A",
      decidedAt: "2026-06-06T21:30:00+09:00",
      reason: "Evidence reviewed",
    });
    const approved = await store.applyReviewDecision(reviewed.decision);
    const event = createStalenessEvent(
      approved,
      evaluateArtifactFreshness(approved, changedDependencies()),
      {
        eventId: "event_A",
        occurredAt: "2026-06-06T22:00:00+09:00",
        detectedBy: "staleness-evaluator-v1",
      },
    );
    await store.applyLifecycleEvent(event);

    const state = await store.reconstructState();

    expect(state.artifacts.get("artifact_A")?.status).toBe("stale");
    expect(state.reviews).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it("rejects unsafe IDs and non-proposed initial artifacts", async () => {
    await expect(
      store.saveSourceNote({ ...sourceNote(), noteId: "../escape" }),
    ).rejects.toThrow("Invalid record ID");
    await expect(
      store.saveArtifact({ ...artifact(), status: "approved" }),
    ).rejects.toThrow("proposed status");
  });
});
