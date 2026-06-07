import { randomUUID } from "node:crypto";
import type {
  CurrentDependencies,
  FreshnessEvaluation,
  ModelIdentity,
} from "./types.js";
import {
  evaluateArtifactFreshness,
  applyFreshnessEvaluation,
} from "./lifecycle.js";
import {
  JsonAuditStore,
  type ReconstructedState,
} from "./json-storage.js";

export interface FreshnessDryRunOptions {
  model?: ModelIdentity;
  ruleVersion?: string;
  reviewCriteriaVersion?: string;
  promptVersion?: string;
  promptHash?: string;
  modelDigest?: string | null;
  inputHash?: string;
}

export interface FreshnessCandidate {
  artifactId: string;
  currentStatus: "approved" | "proposed";
  candidateStatus: "stale" | "obsolete";
  evaluation: FreshnessEvaluation;
}

export interface FreshnessDryRunReport {
  evaluatedArtifacts: number;
  candidates: readonly FreshnessCandidate[];
}

export async function runFreshnessDryRun(
  store: JsonAuditStore,
  options: FreshnessDryRunOptions = {},
): Promise<FreshnessDryRunReport> {
  return evaluateReconstructedState(await store.reconstructState(), options);
}

export function evaluateReconstructedState(
  state: ReconstructedState,
  options: FreshnessDryRunOptions = {},
): FreshnessDryRunReport {
  const candidates: FreshnessCandidate[] = [];
  let evaluatedArtifacts = 0;

  for (const artifact of state.artifacts.values()) {
    if (artifact.status !== "approved" && artifact.status !== "proposed") {
      continue;
    }
    evaluatedArtifacts += 1;

    const current: CurrentDependencies = {
      sourceHashes: Object.fromEntries(
        Object.keys(artifact.sourceHashes).map((noteId) => [
          noteId,
          state.sourceNotes.get(noteId)?.sourceHash,
        ]),
      ),
      referencedArtifacts: Object.fromEntries(
        Object.keys(artifact.referencedArtifactHashes).map((artifactId) => {
          const referenced = state.artifacts.get(artifactId);
          return [
            artifactId,
            referenced
              ? {
                  artifactId,
                  artifactHash: referenced.artifactHash,
                  status: referenced.status,
                }
              : undefined,
          ];
        }),
      ),
      model: options.model ?? artifact.model,
      ruleVersion: options.ruleVersion ?? artifact.ruleVersion,
      reviewCriteriaVersion:
        options.reviewCriteriaVersion ?? artifact.reviewCriteriaVersion,
      promptVersion: options.promptVersion,
      promptHash: options.promptHash,
      modelDigest: options.modelDigest !== undefined ? options.modelDigest : undefined,
      inputHash: options.inputHash,
    };

    const evaluation = evaluateArtifactFreshness(artifact, current);
    if (evaluation.action === "none") {
      continue;
    }
    candidates.push({
      artifactId: artifact.artifactId,
      currentStatus: artifact.status,
      candidateStatus:
        evaluation.action === "mark_stale" ? "stale" : "obsolete",
      evaluation,
    });
  }

  return {
    evaluatedArtifacts,
    candidates: candidates.sort((a, b) =>
      a.artifactId.localeCompare(b.artifactId),
    ),
  };
}

export interface FreshnessOptions extends FreshnessDryRunOptions {
  dryRun: boolean;
  detectedBy?: string;
  occurredAt?: string;
}

export interface FreshnessReport {
  evaluatedArtifacts: number;
  candidates: readonly FreshnessCandidate[];
  writtenEventIds: readonly string[];
  dryRun: boolean;
}

export async function runFreshness(
  store: JsonAuditStore,
  options: FreshnessOptions,
): Promise<FreshnessReport> {
  const state = await store.reconstructState();
  const dryRunReport = evaluateReconstructedState(state, options);

  const writtenEventIds: string[] = [];

  if (!options.dryRun) {
    const detectedBy = options.detectedBy ?? "dependency-evaluator-v1";
    const occurredAt = options.occurredAt ?? new Date().toISOString();

    for (const candidate of dryRunReport.candidates) {
      const artifact = state.artifacts.get(candidate.artifactId);
      if (!artifact) {
        continue;
      }

      const eventId = `event_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const { event } = applyFreshnessEvaluation(
        artifact,
        candidate.evaluation,
        { eventId, occurredAt, detectedBy },
      );

      if (event) {
        await store.applyLifecycleEvent(event);
        writtenEventIds.push(event.eventId);
      }
    }
  }

  return {
    evaluatedArtifacts: dryRunReport.evaluatedArtifacts,
    candidates: dryRunReport.candidates,
    writtenEventIds,
    dryRun: options.dryRun,
  };
}

