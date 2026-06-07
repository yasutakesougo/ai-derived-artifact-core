export const ARTIFACT_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "deferred",
  "obsolete",
  "stale",
] as const;

export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export type ReviewOutcome = "approved" | "rejected" | "deferred";

export type RelationshipType =
  | "derived_from"
  | "supersedes"
  | "contradicts"
  | "supports";

export type FreshnessReason =
  | "source_hash_changed"
  | "model_changed"
  | "rule_version_changed"
  | "review_criteria_changed"
  | "referenced_note_deleted"
  | "referenced_artifact_deleted"
  | "referenced_artifact_changed"
  | "referenced_artifact_stale"
  | "prompt_changed"
  | "input_changed";

export interface ModelIdentity {
  provider: string;
  name: string;
  version: string;
}

export interface ArtifactRelationship {
  artifactId: string;
  type: RelationshipType;
}

export interface SourceNote {
  noteId: string;
  sourceVersion: number;
  sourceHash: string;
  knowledgeType: "observation" | "interpretation";
  createdAt: string;
  updatedAt: string;
  immutablePolicy: "ai_must_not_edit_body";
  body: string;
}

export interface GenerationContext {
  provider: "stub" | "ollama";
  task: "classification";
  promptVersion: string;
  promptHash: string;
  inputHash: string;
  model: {
    name: string;
    digest: string | null;
  };
  parameters: {
    temperature: number;
    top_p: number;
  };
  generatedAt: string;
}

export interface DerivedArtifact {
  artifactId: string;
  artifactHash: string;
  status: ArtifactStatus;
  sourceHashes: Readonly<Record<string, string>>;
  referencedArtifactHashes: Readonly<Record<string, string>>;
  relationships: readonly ArtifactRelationship[];
  model: ModelIdentity;
  ruleVersion: string;
  reviewCriteriaVersion: string;
  generationContext?: GenerationContext;
}

export type ProposalKind = "classification" | "related_candidate";

export interface ProposalEvidence {
  noteId: string;
  sourceHash: string;
  quote: string;
}

export interface ProposalConfidence {
  retrieval: number | null;
  reasoning: number | null;
  overall: number;
}

export interface ProposalArtifact extends DerivedArtifact {
  kind: ProposalKind;
  knowledgeType: "interpretation";
  content: Readonly<Record<string, unknown>>;
  confidence: ProposalConfidence;
  evidence: readonly ProposalEvidence[];
  generatedAt: string;
}

export interface ReferencedArtifactState {
  artifactId: string;
  artifactHash: string;
  status: ArtifactStatus;
}

export interface CurrentDependencies {
  sourceHashes: Readonly<Record<string, string | undefined>>;
  referencedArtifacts: Readonly<
    Record<string, ReferencedArtifactState | undefined>
  >;
  model: ModelIdentity;
  ruleVersion: string;
  reviewCriteriaVersion: string;
  promptVersion?: string | undefined;
  promptHash?: string | undefined;
  inputHash?: string | undefined;
  modelDigest?: string | null | undefined;
}

export interface DependencyValueDiff {
  recorded: unknown;
  current: unknown;
}

export type DependencyDiff = Readonly<Record<string, DependencyValueDiff>>;

export interface FreshnessEvaluation {
  action: "none" | "mark_stale" | "mark_obsolete";
  reasons: readonly FreshnessReason[];
  dependencyDiff: DependencyDiff;
}

interface LifecycleEventBase {
  eventId: string;
  artifactId: string;
  reason: readonly FreshnessReason[];
  occurredAt: string;
  detectedBy: string;
  dependencyDiff: DependencyDiff;
}

export interface StalenessEvent extends LifecycleEventBase {
  fromStatus: "approved";
  toStatus: "stale";
  requiresReview: true;
}

export interface ObsolescenceEvent extends LifecycleEventBase {
  fromStatus: "proposed";
  toStatus: "obsolete";
  requiresRegeneration: true;
}

export type LifecycleEvent = StalenessEvent | ObsolescenceEvent;

export interface ReviewDecision {
  decisionId: string;
  artifactId: string;
  fromStatus: "proposed";
  decision: ReviewOutcome;
  decidedBy: string;
  decidedAt: string;
  reason: string;
}

export interface TransitionResult {
  artifact: DerivedArtifact;
  event?: LifecycleEvent;
}

export interface RegenerationInput {
  artifactId: string;
  artifactHash: string;
  sourceHashes: Readonly<Record<string, string>>;
  referencedArtifactHashes: Readonly<Record<string, string>>;
  model: ModelIdentity;
  ruleVersion: string;
  reviewCriteriaVersion: string;
}
