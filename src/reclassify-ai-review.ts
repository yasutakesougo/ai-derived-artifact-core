#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3:8b";

interface ExistingArtifact {
  artifactId: string;
  sourceHashes: Record<string, string>;
  content: {
    classification: string;
  };
}

interface SourceNote {
  noteId: string;
  sourceHash: string;
  body: string;
}

interface ModelFlag {
  type: string;
  reason: string;
  claim?: string;
}

interface ModelClassification {
  classification: string;
  labels: string[];
  summary: string;
  confidence: number;
  humanReviewRequired: boolean;
  evidenceQuotes: string[];
  flags: ModelFlag[];
}

interface ReclassificationResult {
  status: "proposal";
  artifactId: string;
  sourceNoteIds: string[];
  sourceHashes: Record<string, string>;
  previousClassification: string;
  ollamaClassification: string;
  confidence: number;
  labels: string[];
  summary: string;
  humanReviewRequired: boolean;
  humanReviewRequiredReasons?: string[] | undefined;
  hallucinatedTerms?: string[] | undefined;
  flags: ModelFlag[];
  evidenceQuotes: string[];
  rawModelOutput: string;
  model: {
    provider: "ollama";
    name: string;
    digest: string | null;
  };
  generatedAt: string;
}

interface CliOptions {
  dryRun: boolean;
  controlledTaxonomy: boolean;
  recordsPath: string;
  outputPath: string;
  ollamaUrl: string;
  model: string;
  limit?: number;
}

const PROMPT = `You are reclassifying a human observation note. Your output is only a proposal for later human review.

Rules:
- Use only facts explicitly present in the input note.
- Do not diagnose, infer causes, infer intentions, or claim progress unless the note explicitly states it.
- "classification" is one concise primary category.
- "labels" contains 1 to 3 concise categories, including the primary classification.
- "summary" is a short factual Japanese summary.
- "confidence" is a number from 0 to 1 reflecting support from the note.
- Set "humanReviewRequired" true when the classification is ambiguous, confidence is below 0.80, or any unsupported inference is present.
- "evidenceQuotes" contains 1 to 3 exact verbatim excerpts from the note.
- Put every claim not directly supported by the note in "flags". Use type "unsupported_inference".
- Return strict JSON only. Do not use Markdown.

Required JSON shape:
{
  "classification": "string",
  "labels": ["string"],
  "summary": "string",
  "confidence": 0.0,
  "humanReviewRequired": true,
  "evidenceQuotes": ["exact quote"],
  "flags": [
    {
      "type": "unsupported_inference",
      "reason": "string",
      "claim": "string"
    }
  ]
}

Input note:
`;

const CONTROLLED_TAXONOMY_PROMPT = `You are reclassifying a human observation note. Your output is only a proposal for later human review.

Choose exactly one primary classification from this controlled taxonomy:
- observation: general factual observation that is not primarily one of the categories below.
- behavior: a clinically or support-relevant behavior pattern, challenging behavior, strong repetitive/atypical pattern, non-compliance/refusal, safety risk, or explicit clinical behavioral characteristics requiring support intervention.
- sensory: a response to or exploration of sound, touch, water, texture, movement, or other sensory input.
- communication: expressive or receptive communication, including speech, gesture, PECS, requests, or social signaling.

Category Selection Priority & Guidelines:
1. Prioritize "observation" over "behavior" for general daily activities and interactions:
   - Activities of Daily Living (ADLs) (e.g., eating, dressing, toilet routines) must be "observation", NOT "behavior" unless there is an explicit challenging behavior or severe refusal.
   - Execution of routines or following schedules (e.g., following visual schedule steps, task transitions) must be "observation", NOT "behavior".
   - Social interactions (e.g., playing alongside peers, sharing toys/blocks, waiting turns, verbal/non-verbal greetings) must be "observation" or "communication", NOT "behavior".
   - General participation or engagement in activities (e.g., drawing, crafting, reading) must be "observation".
2. Prioritize "sensory" over other categories when sensory factors are dominant:
   - Sensory play (e.g., playing with water, touching surfaces, feeling textures) must be "sensory".
   - Exploration of sensory stimuli, sensory avoidance (e.g., pulling hands away, wearing earmuffs to avoid noise), sensory self-regulation, or response/reaction to sensory stimuli must be "sensory", NOT "behavior" (even if the action is repetitive).
3. Strictly restrict "behavior" to actual support/intervention-related behaviors:
   - Do NOT classify a note as "behavior" merely because it describes physical movements, ADLs, or actions.
   - Only use "behavior" when the note describes a challenging behavior, a strong repetitive/atypical pattern of clinical significance (not simple sensory play), safety risks, or a specific behavioral concern that requires staff intervention/support.

Strict Restrictions & Negative Rules (Confinement Rules):
- Factual Bounds: Use ONLY facts explicitly written in the input note. Do NOT assume, extrapolate, or invent any background context, intentions, or causes not explicitly written.
- No Clinical Diagnosis: Do NOT diagnose the subject or make medical/clinical judgments (e.g., do not say "this is autistic behavior" or "they have sensory processing issues" unless explicitly written in the note).
- No Intervention Prescription: Do NOT suggest or prescribe support plans or future intervention strategies. Just describe the recorded facts.
- No Personal Information Generation: Do NOT generate or introduce any new names, dates, initials, or identifiers that are not present in the input note.
- Single Note Confinement: Do NOT refer to or assume any past behaviors, other notes, or external knowledge about the subject. Each reclassification must be self-contained within the provided input text.

Rules:
- Use only facts explicitly present in the input note.
- Do not diagnose, infer causes, infer intentions, or infer broad traits.
- "classification" must be exactly one of: observation, behavior, sensory, communication.
- "labels" contains the primary classification plus at most 2 concise factual Japanese labels.
- "summary" is a short factual Japanese summary.
- Calibrate "confidence" using this scale:
  - 0.90-1.00: one category is directly and unambiguously dominant
  - 0.80-0.89: one category is best supported but another is plausible
  - 0.60-0.79: materially ambiguous or mixed-category note
  - below 0.60: insufficient evidence
- Do not default to 0.95. Select a value justified by the note.
- Set "humanReviewRequired" true when confidence is below 0.80, categories are materially mixed, or any unsupported inference is present.
- "evidenceQuotes" contains 1 to 3 exact verbatim excerpts from the note.
- Put every claim not directly supported by the note in "flags". Use type "unsupported_inference".
- Return strict JSON only. Do not use Markdown.

Required JSON shape:
{
  "classification": "observation",
  "labels": ["observation"],
  "summary": "string",
  "confidence": 0.0,
  "humanReviewRequired": true,
  "evidenceQuotes": ["exact quote"],
  "flags": [
    {
      "type": "unsupported_inference",
      "reason": "string",
      "claim": "string"
    }
  ]
}

Input note:
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifacts = await loadJsonFiles<ExistingArtifact>(
    join(options.recordsPath, "artifacts"),
  );
  const sourceNotes = await loadJsonFiles<SourceNote>(
    join(options.recordsPath, "source-notes"),
  );
  const notesById = new Map(sourceNotes.map((note) => [note.noteId, note]));
  const selected = artifacts
    .filter((artifact) => Object.keys(artifact.sourceHashes).length > 0)
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    .slice(0, options.limit ?? artifacts.length);

  const digest = await resolveModelDigest(options.ollamaUrl, options.model);
  const results: ReclassificationResult[] = [];

  for (const [index, artifact] of selected.entries()) {
    const sourceNoteIds = Object.keys(artifact.sourceHashes).sort();
    const noteBodies = sourceNoteIds.map((noteId) => {
      const note = notesById.get(noteId);
      if (!note) {
        throw new Error(`Source note not found: ${noteId}`);
      }
      if (note.sourceHash !== artifact.sourceHashes[noteId]) {
        throw new Error(`Source hash mismatch: ${noteId}`);
      }
      return `[${noteId}]\n${note.body}`;
    });

    process.stderr.write(
      `[${index + 1}/${selected.length}] ${artifact.artifactId}\n`,
    );
    const rawModelOutput = await generate(
      options.ollamaUrl,
      options.model,
      `${options.controlledTaxonomy ? CONTROLLED_TAXONOMY_PROMPT : PROMPT}${noteBodies.join("\n\n")}`,
    );
    const parsed = validateModelOutput(rawModelOutput);
    const flags = [...parsed.flags];

    for (const quote of parsed.evidenceQuotes) {
      if (!noteBodies.some((body) => body.includes(quote))) {
        flags.push({
          type: "invalid_evidence_quote",
          reason: "The evidence quote was not found verbatim in any input note.",
          claim: quote,
        });
      }
    }
    if (!parsed.labels.includes(parsed.classification)) {
      flags.push({
        type: "classification_label_mismatch",
        reason: "The primary classification was not included in labels.",
        claim: parsed.classification,
      });
    }

    // Check if summary contains external information (hallucination detection)
    const kanjiRegex = /[\u4e00-\u9faf]{2,}/g;
    const katakanaRegex = /[\u30a0-\u30ff]{2,}/g;
    const numberRegex = /\d+/g;
    const initialRegex = /[A-Z]+/g;
    const fullSourceText = noteBodies.join("\n");

    const checkSummaryContent = (matches: RegExpMatchArray | null, label: string) => {
      if (!matches) return;
      for (const match of matches) {
        if (!fullSourceText.includes(match)) {
          flags.push({
            type: "unsupported_inference",
            reason: `Summary contains ${label} "${match}" not found in source notes.`,
            claim: match,
          });
        }
      }
    };

    checkSummaryContent(parsed.summary.match(kanjiRegex), "phrase");
    checkSummaryContent(parsed.summary.match(katakanaRegex), "katakana phrase");
    checkSummaryContent(parsed.summary.match(numberRegex), "number");
    checkSummaryContent(parsed.summary.match(initialRegex), "initial/alphabet");
    if (
      options.controlledTaxonomy &&
      !["observation", "behavior", "sensory", "communication"].includes(
        parsed.classification,
      )
    ) {
      throw new Error(
        `Classification is outside the controlled taxonomy: ${parsed.classification}`,
      );
    }

    const humanReviewRequiredReasons: string[] = [];
    const hallucinatedTerms: string[] = [];

    if (artifact.content.classification !== parsed.classification) {
      humanReviewRequiredReasons.push("classification_change");
    }
    if (parsed.confidence < 0.8) {
      humanReviewRequiredReasons.push("low_confidence");
    }
    if (parsed.humanReviewRequired) {
      humanReviewRequiredReasons.push("model_flagged");
    }

    for (const flag of flags) {
      if (flag.type === "invalid_evidence_quote") {
        if (!humanReviewRequiredReasons.includes("invalid_evidence_quote")) {
          humanReviewRequiredReasons.push("invalid_evidence_quote");
        }
      } else if (flag.type === "classification_label_mismatch") {
        if (!humanReviewRequiredReasons.includes("classification_label_mismatch")) {
          humanReviewRequiredReasons.push("classification_label_mismatch");
        }
      } else if (flag.type === "unsupported_inference") {
        if (flag.reason.startsWith("Summary contains")) {
          if (flag.claim && !hallucinatedTerms.includes(flag.claim)) {
            hallucinatedTerms.push(flag.claim);
          }
          if (!humanReviewRequiredReasons.includes("hallucinated_terms")) {
            humanReviewRequiredReasons.push("hallucinated_terms");
          }
        } else {
          if (!humanReviewRequiredReasons.includes("unsupported_inference")) {
            humanReviewRequiredReasons.push("unsupported_inference");
          }
        }
      }
    }

    results.push({
      status: "proposal",
      artifactId: artifact.artifactId,
      sourceNoteIds,
      sourceHashes: artifact.sourceHashes,
      previousClassification: artifact.content.classification,
      ollamaClassification: parsed.classification,
      confidence: parsed.confidence,
      labels: parsed.labels,
      summary: parsed.summary,
      humanReviewRequired: humanReviewRequiredReasons.length > 0,
      humanReviewRequiredReasons: humanReviewRequiredReasons.length > 0 ? humanReviewRequiredReasons : undefined,
      hallucinatedTerms: hallucinatedTerms.length > 0 ? hallucinatedTerms : undefined,
      flags,
      evidenceQuotes: parsed.evidenceQuotes,
      rawModelOutput,
      model: {
        provider: "ollama",
        name: options.model,
        digest,
      },
      generatedAt: new Date().toISOString(),
    });
  }

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(results[0], null, 2)}\n`);
    return;
  }

  await mkdir(options.outputPath, { recursive: false });
  for (const result of results) {
    await writeJsonExclusive(
      join(options.outputPath, `${result.artifactId}.json`),
      result,
    );
  }
  await writeJsonExclusive(
    join(options.outputPath, "summary.json"),
    buildSummary(results, options),
  );
  process.stdout.write(
    `Wrote ${results.length} proposal JSON files and summary.json to ${options.outputPath}\n`,
  );
}

function parseArgs(args: string[]): CliOptions {
  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  if (dryRun === write) {
    throw new Error("Specify exactly one of --dry-run or --write");
  }
  const limitValue = readOption(args, "--limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return {
    dryRun,
    controlledTaxonomy: args.includes("--controlled-taxonomy"),
    recordsPath: resolve(readOption(args, "--records") ?? "records"),
    outputPath: resolve(
      readOption(args, "--output") ?? "../real-vault/ai-review-ollama",
    ),
    ollamaUrl: readOption(args, "--ollama-url") ?? DEFAULT_OLLAMA_URL,
    model: readOption(args, "--model") ?? DEFAULT_MODEL,
    ...(limit === undefined ? {} : { limit }),
  };
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

async function loadJsonFiles<T>(directory: string): Promise<T[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) =>
      JSON.parse(await readFile(join(directory, name), "utf8")),
    ),
  );
}

async function resolveModelDigest(
  ollamaUrl: string,
  model: string,
): Promise<string | null> {
  const response = await fetch(`${ollamaUrl}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama tags request failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    models?: Array<{ name: string; digest: string }>;
  };
  return payload.models?.find((item) => item.name === model)?.digest ?? null;
}

async function generate(
  ollamaUrl: string,
  model: string,
  prompt: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          think: false,
          format: "json",
          options: {
            temperature: 0,
            top_p: 1,
          },
        }),
      });
      const body = (await response.json()) as {
        response?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          body.error ?? `Ollama request failed: ${response.status}`,
        );
      }
      if (!body.response?.trim()) {
        throw new Error("Ollama returned an empty response");
      }
      return body.response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        process.stderr.write(
          `  Ollama request failed; retrying (${attempt}/3)\n`,
        );
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, attempt * 2000),
        );
      }
    }
  }
  throw lastError;
}

function validateModelOutput(raw: string): ModelClassification {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Model output is invalid JSON: ${String(error)}`);
  }
  if (!isRecord(value)) {
    throw new Error("Model output must be a JSON object");
  }
  const classification = requireString(value.classification, "classification");
  const labels = requireStringArray(value.labels, "labels", 1);
  const summary = requireString(value.summary, "summary");
  const confidence = value.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error("confidence must be a number from 0 to 1");
  }
  if (typeof value.humanReviewRequired !== "boolean") {
    throw new Error("humanReviewRequired must be a boolean");
  }
  const evidenceQuotes = requireStringArray(
    value.evidenceQuotes,
    "evidenceQuotes",
    1,
  );
  if (!Array.isArray(value.flags)) {
    throw new Error("flags must be an array");
  }
  const flags = value.flags.map((flag, index) => {
    if (!isRecord(flag)) {
      throw new Error(`flags[${index}] must be an object`);
    }
    const claim =
      flag.claim === undefined
        ? undefined
        : requireString(flag.claim, `flags[${index}].claim`);
    return {
      type: requireString(flag.type, `flags[${index}].type`),
      reason: requireString(flag.reason, `flags[${index}].reason`),
      ...(claim === undefined ? {} : { claim }),
    };
  });
  return {
    classification,
    labels,
    summary,
    confidence,
    humanReviewRequired: value.humanReviewRequired,
    evidenceQuotes,
    flags,
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(
  value: unknown,
  name: string,
  minimumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimumLength) {
    throw new Error(`${name} must contain at least ${minimumLength} item(s)`);
  }
  return value.map((item, index) =>
    requireString(item, `${name}[${index}]`),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function buildSummary(results: ReclassificationResult[], options: CliOptions) {
  const classificationCounts = countBy(
    results.map((result) => result.ollamaClassification),
  );
  const confidenceDistribution = {
    "0.90-1.00": results.filter((item) => item.confidence >= 0.9).length,
    "0.80-0.89": results.filter(
      (item) => item.confidence >= 0.8 && item.confidence < 0.9,
    ).length,
    "0.60-0.79": results.filter(
      (item) => item.confidence >= 0.6 && item.confidence < 0.8,
    ).length,
    "0.00-0.59": results.filter((item) => item.confidence < 0.6).length,
  };
  const classificationDifferences = results
    .filter(
      (item) => item.previousClassification !== item.ollamaClassification,
    )
    .map((item) => ({
      artifactId: item.artifactId,
      sourceNoteIds: item.sourceNoteIds,
      previousClassification: item.previousClassification,
      ollamaClassification: item.ollamaClassification,
    }));
  const invalidJsonCount = 0;
  const emptyResponseCount = 0;
  const flaggedResults = results
    .filter((item) => item.flags.length > 0)
    .map((item) => ({
      artifactId: item.artifactId,
      flags: item.flags,
    }));

  return {
    status: "proposal_summary",
    generatedAt: new Date().toISOString(),
    model: options.model,
    ollamaUrl: options.ollamaUrl,
    controlledTaxonomy: options.controlledTaxonomy,
    total: results.length,
    classificationCounts,
    confidenceDistribution,
    humanReviewRequiredCount: results.filter(
      (item) => item.humanReviewRequired,
    ).length,
    classificationDifferenceCount: classificationDifferences.length,
    classificationDifferences,
    qualityChecks: {
      invalidJsonCount,
      emptyResponseCount,
      overInferenceFlaggedCount: flaggedResults.length,
      flaggedResults,
    },
  };
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
