import { describe, expect, it } from "vitest";
import {
  applyFreshnessEvaluation,
  createReviewDecision,
  evaluateAndApply,
  evaluateArtifactFreshness,
  regenerateArtifact,
  transitionArtifactStatus,
  type ArtifactStatus,
  type CurrentDependencies,
  type DerivedArtifact,
  type LifecycleEvent,
} from "../src/index.js";

const eventInput = {
  eventId: "event_1",
  occurredAt: "2026-06-06T22:00:00+09:00",
  detectedBy: "dependency-evaluator-v1",
};

function artifact(status: ArtifactStatus = "proposed"): DerivedArtifact {
  return {
    artifactId: "artifact_A",
    artifactHash: "sha256:artifact-a-v1",
    status,
    sourceHashes: { note_A: "sha256:source-v1" },
    referencedArtifactHashes: {
      artifact_parent: "sha256:parent-v1",
    },
    relationships: [
      { artifactId: "artifact_parent", type: "derived_from" },
    ],
    model: { provider: "ollama", name: "qwen3", version: "model-v1" },
    ruleVersion: "rule-v1",
    reviewCriteriaVersion: "review-v1",
  };
}

function dependencies(
  overrides: Partial<CurrentDependencies> = {},
): CurrentDependencies {
  return {
    sourceHashes: { note_A: "sha256:source-v1" },
    referencedArtifacts: {
      artifact_parent: {
        artifactId: "artifact_parent",
        artifactHash: "sha256:parent-v1",
        status: "approved",
      },
    },
    model: { provider: "ollama", name: "qwen3", version: "model-v1" },
    ruleVersion: "rule-v1",
    reviewCriteriaVersion: "review-v1",
    ...overrides,
  };
}

function regenerationInput(id: string) {
  return {
    artifactId: id,
    artifactHash: `sha256:${id}`,
    sourceHashes: { note_A: "sha256:source-v2" },
    referencedArtifactHashes: {
      artifact_parent: "sha256:parent-v1",
    },
    model: { provider: "ollama", name: "qwen3", version: "model-v2" },
    ruleVersion: "rule-v2",
    reviewCriteriaVersion: "review-v1",
  };
}

describe("approved artifact transitions", () => {
  it("ST-01 marks an approved artifact stale when its source hash changes", () => {
    const result = evaluateAndApply(
      artifact("approved"),
      dependencies({
        sourceHashes: { note_A: "sha256:source-v2" },
      }),
      eventInput,
    );

    expect(result.artifact.status).toBe("stale");
    expect(result.event?.toStatus).toBe("stale");
    expect(result.event?.reason).toContain("source_hash_changed");
    expect(result.event?.dependencyDiff["source:note_A"]).toEqual({
      recorded: "sha256:source-v1",
      current: "sha256:source-v2",
    });
    expect(
      result.event?.toStatus === "stale" && result.event.requiresReview,
    ).toBe(true);
  });

  it("ST-02 marks an approved artifact stale when the model changes", () => {
    const evaluation = evaluateArtifactFreshness(
      artifact("approved"),
      dependencies({
        model: { provider: "ollama", name: "qwen3", version: "model-v2" },
      }),
    );

    expect(evaluation.action).toBe("mark_stale");
    expect(evaluation.reasons).toContain("model_changed");
  });

  it("ST-03 marks an approved artifact stale when the rule changes", () => {
    const evaluation = evaluateArtifactFreshness(
      artifact("approved"),
      dependencies({ ruleVersion: "rule-v2" }),
    );
    expect(evaluation.reasons).toContain("rule_version_changed");
  });

  it("ST-04 marks an approved artifact stale when review criteria change", () => {
    const evaluation = evaluateArtifactFreshness(
      artifact("approved"),
      dependencies({ reviewCriteriaVersion: "review-v2" }),
    );
    expect(evaluation.reasons).toContain("review_criteria_changed");
  });

  it("ST-05 propagates stale status from a referenced artifact", () => {
    const result = evaluateAndApply(
      artifact("approved"),
      dependencies({
        referencedArtifacts: {
          artifact_parent: {
            artifactId: "artifact_parent",
            artifactHash: "sha256:parent-v1",
            status: "stale",
          },
        },
      }),
      eventInput,
    );
    expect(result.artifact.status).toBe("stale");
    expect(result.event?.reason).toContain("referenced_artifact_stale");
    expect(
      result.event?.dependencyDiff["artifact-status:artifact_parent"],
    ).toBeDefined();
  });

  it("ST-06 marks a dependency stale when a referenced artifact is deleted", () => {
    const result = evaluateAndApply(
      artifact("approved"),
      dependencies({ referencedArtifacts: {} }),
      eventInput,
    );
    expect(result.artifact.status).toBe("stale");
    expect(result.event?.reason).toContain("referenced_artifact_deleted");
  });

  it("ST-07 emits one event containing all dependency changes", () => {
    const result = evaluateAndApply(
      artifact("approved"),
      dependencies({
        sourceHashes: { note_A: "sha256:source-v2" },
        model: { provider: "ollama", name: "qwen3", version: "model-v2" },
        ruleVersion: "rule-v2",
      }),
      eventInput,
    );
    expect(result.event).toBeDefined();
    expect(result.event?.reason).toEqual(
      expect.arrayContaining([
        "source_hash_changed",
        "model_changed",
        "rule_version_changed",
      ]),
    );
  });

  it("ST-08 preserves a stale artifact and creates a superseding proposal", () => {
    const previous = artifact("stale");
    const next = regenerateArtifact(previous, regenerationInput("artifact_B"));
    expect(previous.status).toBe("stale");
    expect(next.status).toBe("proposed");
    expect(next.relationships).toContainEqual({
      artifactId: "artifact_A",
      type: "supersedes",
    });
  });
});

describe("proposed artifact transitions", () => {
  it("ST-09 marks a changed proposal obsolete, not stale", () => {
    const result = evaluateAndApply(
      artifact(),
      dependencies({ sourceHashes: { note_A: "sha256:source-v2" } }),
      eventInput,
    );
    expect(result.artifact.status).toBe("obsolete");
    expect(result.event?.toStatus).toBe("obsolete");
    expect(result.event?.reason).toContain("source_hash_changed");
    expect(
      result.event?.toStatus === "obsolete" &&
        result.event.requiresRegeneration,
    ).toBe(true);
  });

  it("ST-10 records every changed model and rule dependency", () => {
    const evaluation = evaluateArtifactFreshness(
      artifact(),
      dependencies({
        model: { provider: "ollama", name: "qwen3", version: "model-v2" },
        ruleVersion: "rule-v2",
      }),
    );
    expect(evaluation.action).toBe("mark_obsolete");
    expect(evaluation.reasons).toEqual(
      expect.arrayContaining(["model_changed", "rule_version_changed"]),
    );
  });

  it.each([
    [
      "stale",
      {
        artifact_parent: {
          artifactId: "artifact_parent",
          artifactHash: "sha256:parent-v1",
          status: "stale" as const,
        },
      },
      "referenced_artifact_stale",
    ],
    ["deleted", {}, "referenced_artifact_deleted"],
  ])(
    "ST-11 marks a proposal obsolete when its reference is %s",
    (_case, referencedArtifacts, reason) => {
      const evaluation = evaluateArtifactFreshness(
        artifact(),
        dependencies({ referencedArtifacts }),
      );
      expect(evaluation.action).toBe("mark_obsolete");
      expect(evaluation.reasons).toContain(reason);
    },
  );

  it("ST-12 rejects review of an obsolete artifact", () => {
    expect(() =>
      createReviewDecision(artifact("obsolete"), "approved", {
        decisionId: "decision_1",
        decidedBy: "user_A",
        decidedAt: "2026-06-06T22:10:00+09:00",
        reason: "reviewed",
      }),
    ).toThrow("Invalid human transition");
  });

  it("ST-13 regenerates an obsolete artifact as a new proposal", () => {
    const previous = artifact("obsolete");
    const next = regenerateArtifact(previous, regenerationInput("artifact_B"));
    expect(next.artifactId).toBe("artifact_B");
    expect(next.status).toBe("proposed");
    expect(next.sourceHashes.note_A).toBe("sha256:source-v2");
    expect(next.relationships[0]).toEqual({
      artifactId: previous.artifactId,
      type: "supersedes",
    });
  });
});

describe("rejected and deferred artifacts", () => {
  it("ST-14 excludes rejected artifacts from freshness evaluation", () => {
    const result = evaluateAndApply(
      artifact("rejected"),
      dependencies({
        sourceHashes: {},
        ruleVersion: "rule-v2",
        referencedArtifacts: {},
      }),
      eventInput,
    );
    expect(result).toEqual({ artifact: artifact("rejected") });
  });

  it("ST-15 excludes deferred artifacts from freshness evaluation", () => {
    const result = evaluateAndApply(
      artifact("deferred"),
      dependencies({
        sourceHashes: {},
        model: { provider: "ollama", name: "qwen3", version: "model-v2" },
      }),
      eventInput,
    );
    expect(result).toEqual({ artifact: artifact("deferred") });
  });

  it("ST-16 reproposes a deferred artifact without changing it", () => {
    const previous = artifact("deferred");
    const next = regenerateArtifact(previous, regenerationInput("artifact_B"));
    expect(previous.status).toBe("deferred");
    expect(next.status).toBe("proposed");
    expect(next.relationships[0]).toEqual({
      artifactId: previous.artifactId,
      type: "supersedes",
    });
  });
});

describe("invalid transitions", () => {
  it.each([
    ["approved", "obsolete", "system"],
    ["proposed", "stale", "system"],
    ["stale", "approved", "human"],
    ["obsolete", "approved", "human"],
    ["rejected", "proposed", "human"],
    ["deferred", "approved", "human"],
  ] as const)("rejects %s -> %s", (from, to, actor) => {
    expect(() =>
      transitionArtifactStatus(artifact(from), to, actor),
    ).toThrow("Invalid");
  });
});

describe("event integrity", () => {
  it("ST-17 creates deeply immutable lifecycle events", () => {
    const result = evaluateAndApply(
      artifact("approved"),
      dependencies({ sourceHashes: { note_A: "sha256:source-v2" } }),
      eventInput,
    );
    const event = result.event as LifecycleEvent;
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.reason)).toBe(true);
    expect(Object.isFrozen(event.dependencyDiff["source:note_A"])).toBe(true);
    expect(() => {
      (event.reason as string[]).push("model_changed");
    }).toThrow();
  });

  it("ST-18 keeps event transition and projected status consistent", () => {
    for (const status of ["approved", "proposed"] as const) {
      const result = evaluateAndApply(
        artifact(status),
        dependencies({ sourceHashes: { note_A: "sha256:source-v2" } }),
        { ...eventInput, eventId: `event_${status}` },
      );
      expect(result.event).toBeDefined();
      expect(result.event?.toStatus).toBe(result.artifact.status);
      expect(result.event?.fromStatus).toBe(status);
    }
  });

  it("ST-19 is idempotent after the first lifecycle transition", () => {
    const first = evaluateAndApply(
      artifact("approved"),
      dependencies({ sourceHashes: { note_A: "sha256:source-v2" } }),
      eventInput,
    );
    const second = evaluateAndApply(first.artifact, dependencies(), {
      ...eventInput,
      eventId: "event_2",
    });
    expect(first.event).toBeDefined();
    expect(second.event).toBeUndefined();
    expect(second.artifact.status).toBe("stale");
  });

  it("ST-20 propagates cascading staleness and terminates", () => {
    const artifactA = {
      ...artifact("stale"),
      artifactId: "artifact_A",
      artifactHash: "sha256:a",
      referencedArtifactHashes: {},
      relationships: [],
    };
    const artifactB = {
      ...artifact("approved"),
      artifactId: "artifact_B",
      artifactHash: "sha256:b",
      referencedArtifactHashes: { artifact_A: "sha256:a" },
      relationships: [
        { artifactId: "artifact_A", type: "derived_from" as const },
      ],
    };
    const artifactC = {
      ...artifact("approved"),
      artifactId: "artifact_C",
      artifactHash: "sha256:c",
      referencedArtifactHashes: { artifact_B: "sha256:b" },
      relationships: [
        { artifactId: "artifact_B", type: "derived_from" as const },
      ],
    };

    const resultB = evaluateAndApply(
      artifactB,
      dependencies({
        referencedArtifacts: {
          artifact_A: {
            artifactId: "artifact_A",
            artifactHash: artifactA.artifactHash,
            status: artifactA.status,
          },
        },
      }),
      { ...eventInput, eventId: "event_B" },
    );
    const resultC = evaluateAndApply(
      artifactC,
      dependencies({
        referencedArtifacts: {
          artifact_B: {
            artifactId: "artifact_B",
            artifactHash: artifactB.artifactHash,
            status: resultB.artifact.status,
          },
        },
      }),
      { ...eventInput, eventId: "event_C" },
    );

    expect(resultB.artifact.status).toBe("stale");
    expect(resultC.artifact.status).toBe("stale");
    expect([resultB.event?.eventId, resultC.event?.eventId]).toEqual([
      "event_B",
      "event_C",
    ]);
  });
});
