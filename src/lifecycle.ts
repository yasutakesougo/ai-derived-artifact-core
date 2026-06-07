import type {
  ArtifactStatus,
  CurrentDependencies,
  DependencyDiff,
  DerivedArtifact,
  FreshnessEvaluation,
  FreshnessReason,
  LifecycleEvent,
  ModelIdentity,
  ObsolescenceEvent,
  RegenerationInput,
  ReviewDecision,
  ReviewOutcome,
  StalenessEvent,
  TransitionResult,
} from "./types.js";

const humanTransitions: Readonly<Record<string, readonly ArtifactStatus[]>> = {
  proposed: ["approved", "rejected", "deferred"],
};

const systemTransitions: Readonly<Record<string, readonly ArtifactStatus[]>> = {
  proposed: ["obsolete"],
  approved: ["stale"],
};

function modelKey(model: ModelIdentity): string {
  return `${model.provider}/${model.name}@${model.version}`;
}

function pushDiff(
  reasons: FreshnessReason[],
  dependencyDiff: Record<string, { recorded: unknown; current: unknown }>,
  reason: FreshnessReason,
  key: string,
  recorded: unknown,
  current: unknown,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
  dependencyDiff[key] = { recorded, current };
}

export function evaluateArtifactFreshness(
  artifact: DerivedArtifact,
  current: CurrentDependencies,
): FreshnessEvaluation {
  if (artifact.status !== "approved" && artifact.status !== "proposed") {
    return { action: "none", reasons: [], dependencyDiff: {} };
  }

  const reasons: FreshnessReason[] = [];
  const dependencyDiff: Record<
    string,
    { recorded: unknown; current: unknown }
  > = {};

  for (const [noteId, recordedHash] of Object.entries(artifact.sourceHashes)) {
    const currentHash = current.sourceHashes[noteId];
    if (currentHash === undefined) {
      pushDiff(
        reasons,
        dependencyDiff,
        "referenced_note_deleted",
        `source:${noteId}`,
        recordedHash,
        undefined,
      );
    } else if (currentHash !== recordedHash) {
      pushDiff(
        reasons,
        dependencyDiff,
        "source_hash_changed",
        `source:${noteId}`,
        recordedHash,
        currentHash,
      );
    }
  }

  for (const [artifactId, recordedHash] of Object.entries(
    artifact.referencedArtifactHashes,
  )) {
    const referenced = current.referencedArtifacts[artifactId];
    if (referenced === undefined) {
      pushDiff(
        reasons,
        dependencyDiff,
        "referenced_artifact_deleted",
        `artifact:${artifactId}`,
        recordedHash,
        undefined,
      );
      continue;
    }
    if (referenced.status === "stale") {
      pushDiff(
        reasons,
        dependencyDiff,
        "referenced_artifact_stale",
        `artifact-status:${artifactId}`,
        "approved",
        "stale",
      );
    }
    if (referenced.artifactHash !== recordedHash) {
      pushDiff(
        reasons,
        dependencyDiff,
        "referenced_artifact_changed",
        `artifact-hash:${artifactId}`,
        recordedHash,
        referenced.artifactHash,
      );
    }
  }

  if (artifact.generationContext) {
    // 1. model_changed check using generationContext
    const currentModelDigest = current.modelDigest !== undefined ? current.modelDigest : null;
    const nameChanged = artifact.generationContext.model.name !== current.model.name;
    const digestChanged = current.modelDigest !== undefined && artifact.generationContext.model.digest !== currentModelDigest;
    if (nameChanged || digestChanged) {
      pushDiff(
        reasons,
        dependencyDiff,
        "model_changed",
        "model",
        `${artifact.generationContext.model.name}@${artifact.generationContext.model.digest ?? "no-digest"}`,
        `${current.model.name}@${currentModelDigest ?? "no-digest"}`,
      );
    }

    // 2. prompt_changed check
    if (current.promptHash !== undefined) {
      if (
        artifact.generationContext.promptVersion !== current.promptVersion ||
        artifact.generationContext.promptHash !== current.promptHash
      ) {
        pushDiff(
          reasons,
          dependencyDiff,
          "prompt_changed",
          "promptHash",
          artifact.generationContext.promptHash,
          current.promptHash,
        );
      }
    }

    // 3. input_changed check
    const noteIds = Object.keys(artifact.sourceHashes);
    const noteId = noteIds[0];
    const currentInputHash = current.inputHash ?? (noteId ? current.sourceHashes[noteId] : undefined);
    if (artifact.generationContext.inputHash && currentInputHash && artifact.generationContext.inputHash !== currentInputHash) {
      pushDiff(
        reasons,
        dependencyDiff,
        "input_changed",
        "inputHash",
        artifact.generationContext.inputHash,
        currentInputHash,
      );
    }
  } else {
    // Original fallback checks
    if (modelKey(artifact.model) !== modelKey(current.model)) {
      pushDiff(
        reasons,
        dependencyDiff,
        "model_changed",
        "model",
        modelKey(artifact.model),
        modelKey(current.model),
      );
    }
  }

  if (artifact.ruleVersion !== current.ruleVersion) {
    pushDiff(
      reasons,
      dependencyDiff,
      "rule_version_changed",
      "ruleVersion",
      artifact.ruleVersion,
      current.ruleVersion,
    );
  }
  if (artifact.reviewCriteriaVersion !== current.reviewCriteriaVersion) {
    pushDiff(
      reasons,
      dependencyDiff,
      "review_criteria_changed",
      "reviewCriteriaVersion",
      artifact.reviewCriteriaVersion,
      current.reviewCriteriaVersion,
    );
  }

  if (reasons.length === 0) {
    return { action: "none", reasons, dependencyDiff };
  }

  return {
    action: artifact.status === "approved" ? "mark_stale" : "mark_obsolete",
    reasons,
    dependencyDiff,
  };
}

export function transitionArtifactStatus(
  artifact: DerivedArtifact,
  toStatus: ArtifactStatus,
  actor: "human" | "system",
): DerivedArtifact {
  const allowed =
    actor === "human" ? humanTransitions[artifact.status] : systemTransitions[artifact.status];

  if (!allowed?.includes(toStatus)) {
    throw new Error(
      `Invalid ${actor} transition: ${artifact.status} -> ${toStatus}`,
    );
  }

  return { ...artifact, status: toStatus };
}

export function createReviewDecision(
  artifact: DerivedArtifact,
  decision: ReviewOutcome,
  input: {
    decisionId: string;
    decidedBy: string;
    decidedAt: string;
    reason: string;
  },
): { artifact: DerivedArtifact; decision: ReviewDecision } {
  if (!input.decidedBy.trim() || !input.reason.trim()) {
    throw new Error("Reviewer identity and reason are required");
  }

  const transitioned = transitionArtifactStatus(artifact, decision, "human");
  return {
    artifact: transitioned,
    decision: {
      decisionId: input.decisionId,
      artifactId: artifact.artifactId,
      fromStatus: "proposed",
      decision,
      decidedBy: input.decidedBy,
      decidedAt: input.decidedAt,
      reason: input.reason,
    },
  };
}

export function createStalenessEvent(
  artifact: DerivedArtifact,
  evaluation: FreshnessEvaluation,
  input: { eventId: string; occurredAt: string; detectedBy: string },
): StalenessEvent {
  if (artifact.status !== "approved" || evaluation.action !== "mark_stale") {
    throw new Error("StalenessEvent requires an approved stale evaluation");
  }
  return deepFreeze({
    eventId: input.eventId,
    artifactId: artifact.artifactId,
    fromStatus: "approved",
    toStatus: "stale",
    reason: [...evaluation.reasons],
    occurredAt: input.occurredAt,
    detectedBy: input.detectedBy,
    dependencyDiff: { ...evaluation.dependencyDiff },
    requiresReview: true,
  });
}

export function createObsolescenceEvent(
  artifact: DerivedArtifact,
  evaluation: FreshnessEvaluation,
  input: { eventId: string; occurredAt: string; detectedBy: string },
): ObsolescenceEvent {
  if (artifact.status !== "proposed" || evaluation.action !== "mark_obsolete") {
    throw new Error(
      "ObsolescenceEvent requires a proposed obsolete evaluation",
    );
  }
  return deepFreeze({
    eventId: input.eventId,
    artifactId: artifact.artifactId,
    fromStatus: "proposed",
    toStatus: "obsolete",
    reason: [...evaluation.reasons],
    occurredAt: input.occurredAt,
    detectedBy: input.detectedBy,
    dependencyDiff: { ...evaluation.dependencyDiff },
    requiresRegeneration: true,
  });
}

export function applyFreshnessEvaluation(
  artifact: DerivedArtifact,
  evaluation: FreshnessEvaluation,
  input: { eventId: string; occurredAt: string; detectedBy: string },
): TransitionResult {
  if (evaluation.action === "none") {
    return { artifact };
  }
  if (evaluation.action === "mark_stale") {
    const event = createStalenessEvent(artifact, evaluation, input);
    return {
      artifact: transitionArtifactStatus(artifact, "stale", "system"),
      event,
    };
  }
  const event = createObsolescenceEvent(artifact, evaluation, input);
  return {
    artifact: transitionArtifactStatus(artifact, "obsolete", "system"),
    event,
  };
}

export function regenerateArtifact(
  previous: DerivedArtifact,
  input: RegenerationInput,
): DerivedArtifact {
  if (
    previous.status !== "stale" &&
    previous.status !== "obsolete" &&
    previous.status !== "deferred"
  ) {
    throw new Error(`Cannot regenerate artifact in ${previous.status} status`);
  }

  return {
    ...input,
    status: "proposed",
    relationships: [
      { artifactId: previous.artifactId, type: "supersedes" },
    ],
  };
}

export function evaluateAndApply(
  artifact: DerivedArtifact,
  current: CurrentDependencies,
  input: { eventId: string; occurredAt: string; detectedBy: string },
): TransitionResult {
  return applyFreshnessEvaluation(
    artifact,
    evaluateArtifactFreshness(artifact, current),
    input,
  );
}

export function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Partial<LifecycleEvent>;
  return event.toStatus === "stale" || event.toStatus === "obsolete";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
