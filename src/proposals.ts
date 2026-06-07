import { createHash } from "node:crypto";
import type {
  ModelIdentity,
  ProposalArtifact,
  ProposalEvidence,
} from "./types.js";
import { JsonAuditStore } from "./json-storage.js";
import {
  scanObsidianVault,
  type VaultSourceCandidate,
} from "./obsidian-vault.js";
import { generateClassification } from "./ollama.js";

export interface ProposalGenerationOptions {
  vaultPath: string;
  sourceFolder?: string;
  dryRun: boolean;
  generatedAt: string;
  model?: ModelIdentity;
  ruleVersion?: string;
  reviewCriteriaVersion?: string;
  provider?: "stub" | "ollama";
  ollamaUrl?: string;
  modelName?: string;
  promptVersion?: string;
  confidenceThreshold?: number;
  maxLabels?: number;
  maxProposalsPerNote?: number;
}

export interface ProposalSkip {
  relativePath: string;
  noteId?: string;
  reason: "missing_note_id" | "source_note_missing" | "source_hash_mismatch";
}

export interface ProposalMetrics {
  scannedNotes: number;
  notesWithNoteId: number;
  notesMissingNoteId: number;
  proposalsGenerated: number;
  proposalsExported: number;
  proposalsSuppressedByConfidence: number;
  proposalsSuppressedByPolicy: number;
  averageLabelsPerProposal: number;
  maxLabelsPerProposal: number;
  evidenceAverageLength: number;
  evidenceMaxLength: number;
}

export interface ProposalGenerationReport {
  eligibleNotes: number;
  drafts: readonly ProposalArtifact[];
  skipped: readonly ProposalSkip[];
  writtenArtifactIds: readonly string[];
  dryRun: boolean;
  metrics?: ProposalMetrics;
}

interface EligibleSource {
  candidate: VaultSourceCandidate & { noteId: string };
}

const STUB_MODEL: ModelIdentity = {
  provider: "stub",
  name: "deterministic-proposal-generator",
  version: "v1",
};

export async function generateProposalDrafts(
  store: JsonAuditStore,
  options: ProposalGenerationOptions,
): Promise<ProposalGenerationReport> {
  const scan = await scanObsidianVault(options.vaultPath, {
    ...(options.sourceFolder ? { sourceFolder: options.sourceFolder } : {}),
  });
  const state = await store.reconstructState();
  const eligible: EligibleSource[] = [];
  const skipped: ProposalSkip[] = [];

  for (const candidate of scan.candidates) {
    if (!candidate.noteId) {
      skipped.push({
        relativePath: candidate.relativePath,
        reason: "missing_note_id",
      });
      continue;
    }
    const stored = state.sourceNotes.get(candidate.noteId);
    if (!stored) {
      skipped.push({
        relativePath: candidate.relativePath,
        noteId: candidate.noteId,
        reason: "source_note_missing",
      });
      continue;
    }
    if (stored.sourceHash !== candidate.sourceHash) {
      skipped.push({
        relativePath: candidate.relativePath,
        noteId: candidate.noteId,
        reason: "source_hash_mismatch",
      });
      continue;
    }
    eligible.push({
      candidate: candidate as VaultSourceCandidate & { noteId: string },
    });
  }

  const rawDrafts: ProposalArtifact[] = [];
  if (options.provider === "ollama") {
    const ollamaUrl = options.ollamaUrl ?? "http://localhost:11434";
    const modelName = options.modelName ?? "qwen3:8b";
    const promptVersion = options.promptVersion ?? "classification-prompt-v1";
    for (const { candidate } of eligible) {
      const draft = await generateClassification(
        ollamaUrl,
        modelName,
        promptVersion,
        candidate.noteId,
        candidate.sourceHash,
        candidate.body,
        {
          reviewCriteriaVersion: options.reviewCriteriaVersion,
        },
      );
      rawDrafts.push(draft);
    }
  } else {
    const context = {
      generatedAt: options.generatedAt,
      model: options.model ?? STUB_MODEL,
      ruleVersion: options.ruleVersion ?? "stub-proposal-v1",
      reviewCriteriaVersion:
        options.reviewCriteriaVersion ?? "review-policy-v1",
    };
    rawDrafts.push(
      ...eligible.map(({ candidate }) =>
        createClassificationDraft(candidate, context),
      ),
      ...createRelatedCandidateDrafts(eligible, context),
    );
  }

  // Precision Policy Configuration
  const confidenceThreshold = options.confidenceThreshold !== undefined
    ? options.confidenceThreshold
    : (options.provider === "ollama" ? 0.90 : 0.0);

  const maxLabels = options.maxLabels !== undefined
    ? options.maxLabels
    : (options.provider === "ollama" ? 3 : Infinity);

  const maxProposalsPerNote = options.maxProposalsPerNote !== undefined
    ? options.maxProposalsPerNote
    : (options.provider === "ollama" ? 1 : Infinity);

  // Sort rawDrafts by confidence.overall descending
  const sortedDrafts = [...rawDrafts].sort((a, b) => b.confidence.overall - a.confidence.overall);

  const exportedDrafts: ProposalArtifact[] = [];
  const noteProposalCount = new Map<string, number>();

  let suppressedByConfidence = 0;
  let suppressedByPolicy = 0;

  for (const draft of sortedDrafts) {
    // Check confidence threshold
    if (draft.confidence.overall < confidenceThreshold) {
      suppressedByConfidence += 1;
      continue;
    }

    // Check max labels per proposal
    const labelsCount = getLabelsCount(draft);
    if (labelsCount > maxLabels) {
      suppressedByPolicy += 1;
      continue;
    }

    // Check max proposals per source note
    const sourceNotes = Object.keys(draft.sourceHashes);
    const exceedsPerNote = sourceNotes.some(noteId => {
      const count = noteProposalCount.get(noteId) ?? 0;
      return count >= maxProposalsPerNote;
    });
    if (exceedsPerNote) {
      suppressedByPolicy += 1;
      continue;
    }

    exportedDrafts.push(draft);
    for (const noteId of sourceNotes) {
      noteProposalCount.set(noteId, (noteProposalCount.get(noteId) ?? 0) + 1);
    }
  }

  // Validate only the exported proposals
  exportedDrafts.forEach(validateProposalArtifact);

  const writtenArtifactIds: string[] = [];
  if (!options.dryRun) {
    for (const draft of exportedDrafts) {
      if (await store.readArtifact(draft.artifactId)) {
        throw new Error(`Artifact already exists: ${draft.artifactId}`);
      }
    }
    for (const draft of exportedDrafts) {
      await store.saveArtifact(draft);
      writtenArtifactIds.push(draft.artifactId);
    }
  }

  // Calculate metrics
  const scannedNotes = scan.scannedMarkdownFiles;
  const notesWithNoteId = scan.candidates.filter(c => c.noteId).length;
  const notesMissingNoteId = scan.candidates.filter(c => !c.noteId).length;
  const proposalsGenerated = rawDrafts.length;
  const proposalsExported = exportedDrafts.length;

  const allQuotes = exportedDrafts.flatMap(d => d.evidence.map(e => e.quote));
  const evidenceAverageLength = allQuotes.length > 0
    ? Math.round(allQuotes.reduce((sum, q) => sum + q.length, 0) / allQuotes.length)
    : 0;
  const evidenceMaxLength = allQuotes.length > 0
    ? Math.max(...allQuotes.map(q => q.length))
    : 0;

  const allLabelsCounts = exportedDrafts.map(getLabelsCount);
  const averageLabelsPerProposal = allLabelsCounts.length > 0
    ? Math.round((allLabelsCounts.reduce((sum, c) => sum + c, 0) / allLabelsCounts.length) * 100) / 100
    : 0;
  const maxLabelsPerProposal = allLabelsCounts.length > 0
    ? Math.max(...allLabelsCounts)
    : 0;

  const metrics: ProposalMetrics = {
    scannedNotes,
    notesWithNoteId,
    notesMissingNoteId,
    proposalsGenerated,
    proposalsExported,
    proposalsSuppressedByConfidence: suppressedByConfidence,
    proposalsSuppressedByPolicy: suppressedByPolicy,
    averageLabelsPerProposal,
    maxLabelsPerProposal,
    evidenceAverageLength,
    evidenceMaxLength,
  };

  return {
    eligibleNotes: eligible.length,
    drafts: exportedDrafts,
    skipped,
    writtenArtifactIds,
    dryRun: options.dryRun,
    metrics,
  };
}

function createClassificationDraft(
  candidate: VaultSourceCandidate & { noteId: string },
  context: GenerationContext,
): ProposalArtifact {
  const classification = readClassification(candidate.frontmatter);
  const seed = proposalSeed(
    "classification",
    `${candidate.noteId}:${candidate.sourceHash}`,
    context,
  );
  return finalizeDraft({
    artifactId: deterministicId("classification", seed),
    artifactHash: "",
    status: "proposed",
    sourceHashes: { [candidate.noteId]: candidate.sourceHash },
    referencedArtifactHashes: {},
    relationships: [],
    model: context.model,
    ruleVersion: context.ruleVersion,
    reviewCriteriaVersion: context.reviewCriteriaVersion,
    kind: "classification",
    knowledgeType: "interpretation",
    content: {
      classification,
      statement: `Stub classification candidate: ${classification}`,
    },
    confidence: {
      retrieval: null,
      reasoning: 0.5,
      overall: 0.5,
    },
    evidence: [evidenceFrom(candidate)],
    generatedAt: context.generatedAt,
  });
}

function createRelatedCandidateDrafts(
  eligible: readonly EligibleSource[],
  context: GenerationContext,
): ProposalArtifact[] {
  const drafts: ProposalArtifact[] = [];
  for (let leftIndex = 0; leftIndex < eligible.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < eligible.length;
      rightIndex += 1
    ) {
      const left = eligible[leftIndex]?.candidate;
      const right = eligible[rightIndex]?.candidate;
      if (!left || !right) {
        continue;
      }
      const retrieval = tokenSimilarity(left.body, right.body);
      const seed = proposalSeed(
        "related",
        `${left.noteId}:${left.sourceHash}:${right.noteId}:${right.sourceHash}`,
        context,
      );
      drafts.push(
        finalizeDraft({
          artifactId: deterministicId("related", seed),
          artifactHash: "",
          status: "proposed",
          sourceHashes: {
            [left.noteId]: left.sourceHash,
            [right.noteId]: right.sourceHash,
          },
          referencedArtifactHashes: {},
          relationships: [],
          model: context.model,
          ruleVersion: context.ruleVersion,
          reviewCriteriaVersion: context.reviewCriteriaVersion,
          kind: "related_candidate",
          knowledgeType: "interpretation",
          content: {
            noteIds: [left.noteId, right.noteId],
            statement:
              "These notes are a deterministic stub similarity candidate. Human review is required.",
          },
          confidence: {
            retrieval,
            reasoning: 0.25,
            overall: roundScore((retrieval + 0.25) / 2),
          },
          evidence: [evidenceFrom(left), evidenceFrom(right)],
          generatedAt: context.generatedAt,
        }),
      );
    }
  }
  return drafts;
}

interface GenerationContext {
  generatedAt: string;
  model: ModelIdentity;
  ruleVersion: string;
  reviewCriteriaVersion: string;
}

function finalizeDraft(
  artifact: ProposalArtifact,
): ProposalArtifact {
  const immutablePayload = { ...artifact, artifactHash: undefined };
  return {
    ...artifact,
    artifactHash: `sha256:${createHash("sha256")
      .update(stableStringify(immutablePayload), "utf8")
      .digest("hex")}`,
  };
}

export function validateProposalArtifact(
  artifact: ProposalArtifact,
): void {
  if (artifact.status !== "proposed") {
    throw new Error("Proposal artifact status must be proposed");
  }
  if (
    artifact.kind !== "classification" &&
    artifact.kind !== "related_candidate"
  ) {
    throw new Error(`Unsupported proposal kind: ${String(artifact.kind)}`);
  }
  if (artifact.evidence.length < 1) {
    throw new Error("Proposal evidence is required");
  }
  for (const evidence of artifact.evidence) {
    if (!evidence.noteId || !evidence.sourceHash || !evidence.quote.trim()) {
      throw new Error("Proposal evidence must identify source and quote");
    }
  }
  for (const name of ["retrieval", "reasoning", "overall"] as const) {
    if (!Object.hasOwn(artifact.confidence, name)) {
      throw new Error(`Missing confidence.${name}`);
    }
    const score = artifact.confidence[name];
    if (name === "overall" && score === null) {
      throw new Error("confidence.overall cannot be null");
    }
    if (score !== null && (score < 0 || score > 1)) {
      throw new Error(`Invalid confidence.${name}`);
    }
  }
  for (const evidence of artifact.evidence) {
    if (artifact.sourceHashes[evidence.noteId] !== evidence.sourceHash) {
      throw new Error("Evidence sourceHash must match artifact sourceHashes");
    }
  }
}

function evidenceFrom(
  candidate: VaultSourceCandidate & { noteId: string },
): ProposalEvidence {
  return {
    noteId: candidate.noteId,
    sourceHash: candidate.sourceHash,
    quote: firstEvidenceExcerpt(candidate.body),
  };
}

function firstEvidenceExcerpt(body: string): string {
  const compact = body.replace(/\s+/gu, " ").trim();
  if (!compact) {
    throw new Error("Cannot generate proposal from an empty source body");
  }
  return compact.slice(0, 240);
}

function readClassification(
  frontmatter: Readonly<Record<string, unknown>>,
): string {
  const value = frontmatter.type ?? frontmatter.domain;
  return typeof value === "string" && value.trim()
    ? value.trim()
    : "unclassified";
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return roundScore(intersection / union.size);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 1),
  );
}

function deterministicId(prefix: string, seed: string): string {
  return `draft_${prefix}_${createHash("sha256")
    .update(seed, "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

function proposalSeed(
  kind: string,
  sources: string,
  context: GenerationContext,
): string {
  return [
    kind,
    sources,
    context.model.provider,
    context.model.name,
    context.model.version,
    context.ruleVersion,
    context.reviewCriteriaVersion,
    context.generatedAt,
  ].join(":");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function getLabelsCount(draft: ProposalArtifact): number {
  const content = draft.content as Record<string, unknown>;
  if (Array.isArray(content.labels)) {
    return content.labels.length;
  }
  // Stub proposals store a single classification string
  return typeof content.classification === "string" ? 1 : 0;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
