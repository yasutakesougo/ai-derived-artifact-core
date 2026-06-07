#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

interface ReviewProposal {
  artifactId: string;
  sourceNoteIds: string[];
  sourceHashes: Record<string, string>;
  previousClassification: string;
  ollamaClassification: string;
  confidence: number;
  labels: string[];
  summary: string;
  humanReviewRequired: boolean;
  humanReviewRequiredReasons?: string[];
  hallucinatedTerms?: string[];
  flags: Array<{
    type: string;
    reason: string;
    claim?: string;
  }>;
  evidenceQuotes: string[];
  rawModelOutput: string;
  model: {
    provider: string;
    name: string;
    digest: string | null;
  };
  generatedAt: string;
}

interface Frontmatter {
  artifactId: string;
  status: string;
  reviewFormat: string;
  previousClassification: string;
  ollamaClassification: string;
  confidence: number;
  humanReviewRequired: boolean;
  generatedAt: string;
  reviewTimeSeconds?: number | undefined;
  reviewTime?: number | undefined;
}

interface ParsedReview {
  artifactId: string;
  frontmatter: Frontmatter;
  outcome: "approved" | "rejected" | "deferred" | "unreviewed";
  correctClassification?: "observation" | "behavior" | "sensory" | "communication" | undefined;
  reviewMemo: string;
  reviewTimeSeconds?: number | undefined;
}

interface CliOptions {
  markdownDir: string;
  jsonDir: string;
  outputDir: string;
}

const REASON_TYPES = [
  "classification_change",
  "low_confidence",
  "hallucinated_terms",
  "invalid_evidence_quote",
  "classification_label_mismatch",
  "model_flagged",
  "unsupported_inference",
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const mdFiles = (await readdir(options.markdownDir))
    .filter((name) => name.startsWith("draft_") && name.endsWith(".md"))
    .sort();

  const parsedReviews: ParsedReview[] = [];

  for (const name of mdFiles) {
    const mdPath = join(options.markdownDir, name);
    const content = await readFile(mdPath, "utf8");
    try {
      const parsed = parseReviewMarkdown(content);
      parsedReviews.push(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse ${name}: ${message}`);
    }
  }

  const approvedArtifacts: any[] = [];
  let approvedCount = 0;
  let rejectedCount = 0;
  let deferredCount = 0;
  let unreviewedCount = 0;

  const classificationCounts = {
    observation: 0,
    behavior: 0,
    sensory: 0,
    communication: 0,
  };

  const flaggedCounts: Record<string, number> = {};
  for (const reason of REASON_TYPES) {
    flaggedCounts[reason] = 0;
  }

  const reviewTimes: number[] = [];

  for (const parsed of parsedReviews) {
    const fm = parsed.frontmatter;

    // Track outcome counts
    if (parsed.outcome === "approved") {
      approvedCount++;
    } else if (parsed.outcome === "rejected") {
      rejectedCount++;
    } else if (parsed.outcome === "deferred") {
      deferredCount++;
    } else {
      unreviewedCount++;
    }

    // Parse reasons for flagged count (only for reviewed items)
    if (parsed.outcome !== "unreviewed") {
      // Load corresponding JSON to get detailed humanReviewRequiredReasons if not in frontmatter
      const jsonPath = join(options.jsonDir, `${fm.artifactId}.json`);
      let proposalJson: ReviewProposal | null = null;
      try {
        proposalJson = JSON.parse(await readFile(jsonPath, "utf8")) as ReviewProposal;
      } catch (err) {
        // Fallback: if JSON not found, log warning but continue
        process.stderr.write(`Warning: proposal JSON not found or invalid at ${jsonPath}\n`);
      }

      const reasons = proposalJson?.humanReviewRequiredReasons || [];
      for (const reason of reasons) {
        flaggedCounts[reason] = (flaggedCounts[reason] ?? 0) + 1;
      }

      // Track review times
      if (parsed.reviewTimeSeconds !== undefined) {
        reviewTimes.push(parsed.reviewTimeSeconds);
      }

      // If approved, construct approved artifact entry
      if (parsed.outcome === "approved") {
        const finalClassification = parsed.correctClassification || fm.ollamaClassification;
        if (finalClassification in classificationCounts) {
          classificationCounts[finalClassification as keyof typeof classificationCounts]++;
        }

        approvedArtifacts.push({
          artifactId: fm.artifactId,
          status: "approved",
          sourceNoteIds: proposalJson?.sourceNoteIds || [],
          sourceHashes: proposalJson?.sourceHashes || {},
          classification: finalClassification,
          previousClassification: fm.previousClassification,
          ollamaClassification: fm.ollamaClassification,
          confidence: fm.confidence,
          summary: proposalJson?.summary || "",
          labels: proposalJson?.labels || [],
          evidenceQuotes: proposalJson?.evidenceQuotes || [],
          reviewMemo: parsed.reviewMemo,
          reviewTimeSeconds: parsed.reviewTimeSeconds,
          approvedAt: new Date().toISOString(),
        });
      }
    }
  }

  const averageReviewTimeSeconds = reviewTimes.length > 0
    ? Number((reviewTimes.reduce((a, b) => a + b, 0) / reviewTimes.length).toFixed(1))
    : null;

  const summary = {
    status: "review_summary",
    generatedAt: new Date().toISOString(),
    total: parsedReviews.length,
    reviewed: {
      approvedCount,
      rejectedCount,
      deferredCount,
      unreviewedCount,
    },
    classificationCounts,
    flaggedCounts,
    averageReviewTimeSeconds,
  };

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(
    join(options.outputDir, "approved_artifacts.json"),
    `${JSON.stringify(approvedArtifacts, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(options.outputDir, "review_summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(
    `Aggregated ${parsedReviews.length} reviews: ${approvedCount} approved, ${rejectedCount} rejected, ${deferredCount} deferred.\n`,
  );
  process.stdout.write(
    `Wrote approved_artifacts.json and review_summary.json to ${options.outputDir}\n`,
  );
}

export function parseReviewMarkdown(markdown: string): ParsedReview {
  const normalized = markdown.replace(/\r\n?/gu, "\n").replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    throw new Error("Review Markdown requires YAML frontmatter");
  }
  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    throw new Error("Unclosed review frontmatter");
  }
  const yamlText = normalized.slice(4, closingIndex);
  const parsedFm = parseYaml(yamlText) as Record<string, any>;
  if (!parsedFm || typeof parsedFm !== "object" || Array.isArray(parsedFm)) {
    throw new Error("Review frontmatter must be a YAML mapping");
  }

  const frontmatter: Frontmatter = {
    artifactId: requireString(parsedFm.artifactId, "artifactId"),
    status: requireString(parsedFm.status, "status"),
    reviewFormat: requireString(parsedFm.reviewFormat, "reviewFormat"),
    previousClassification: requireString(parsedFm.previousClassification, "previousClassification"),
    ollamaClassification: requireString(parsedFm.ollamaClassification, "ollamaClassification"),
    confidence: requireNumber(parsedFm.confidence, "confidence"),
    humanReviewRequired: requireBoolean(parsedFm.humanReviewRequired, "humanReviewRequired"),
    generatedAt: requireString(parsedFm.generatedAt, "generatedAt"),
    reviewTimeSeconds: parsedFm.reviewTimeSeconds !== undefined ? requireNumber(parsedFm.reviewTimeSeconds, "reviewTimeSeconds") : undefined,
    reviewTime: parsedFm.reviewTime !== undefined ? requireNumber(parsedFm.reviewTime, "reviewTime") : undefined,
  };

  const body = normalized.slice(closingIndex + 5);
  const manualReviewText = extractManualReviewSection(body);

  // Parse outcome
  const isApproved = /- \[([xX])\] Approve proposal/i.test(manualReviewText);
  const isRejected = /- \[([xX])\] Reject proposal/i.test(manualReviewText);
  const isDeferred = /- \[([xX])\] Hold \/ needs discussion/i.test(manualReviewText);

  const checkedOutcomes = [isApproved, isRejected, isDeferred].filter(Boolean).length;
  if (checkedOutcomes > 1) {
    throw new Error("Multiple review outcomes checked");
  }

  let outcome: "approved" | "rejected" | "deferred" | "unreviewed" = "unreviewed";
  if (isApproved) {
    outcome = "approved";
  } else if (isRejected) {
    outcome = "rejected";
  } else if (isDeferred) {
    outcome = "deferred";
  }

  // Parse correct classification
  const isObs = /- \[([xX])\] observation/i.test(manualReviewText);
  const isBeh = /- \[([xX])\] behavior/i.test(manualReviewText);
  const isSen = /- \[([xX])\] sensory/i.test(manualReviewText);
  const isCom = /- \[([xX])\] communication/i.test(manualReviewText);

  const checkedClassifications = [isObs, isBeh, isSen, isCom].filter(Boolean).length;
  if (checkedClassifications > 1) {
    throw new Error("Multiple correct classifications checked");
  }

  let correctClassification: "observation" | "behavior" | "sensory" | "communication" | undefined;
  if (isObs) correctClassification = "observation";
  if (isBeh) correctClassification = "behavior";
  if (isSen) correctClassification = "sensory";
  if (isCom) correctClassification = "communication";

  // Parse review memo
  let reviewMemo = "";
  const memoMatch = /Review memo:\s*\n([\s\S]*)/i.exec(manualReviewText);
  if (memoMatch && memoMatch[1]) {
    const lines = memoMatch[1].split("\n");
    const memoLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(">")) {
        memoLines.push(trimmed.replace(/^>\s*/, ""));
      }
    }
    reviewMemo = memoLines.join("\n").trim();
  }

  const reviewTimeSeconds = frontmatter.reviewTimeSeconds !== undefined
    ? frontmatter.reviewTimeSeconds
    : frontmatter.reviewTime;

  return {
    artifactId: frontmatter.artifactId,
    frontmatter,
    outcome,
    correctClassification,
    reviewMemo,
    reviewTimeSeconds,
  };
}

function extractManualReviewSection(body: string): string {
  const heading = /^## Manual Review\s*$/mu.exec(body);
  if (!heading) {
    throw new Error("Manual Review section is missing");
  }
  const sectionStart = heading.index + heading[0].length;
  const remaining = body.slice(sectionStart);
  const nextHeading = /^---/mu.exec(remaining);
  return nextHeading ? remaining.slice(0, nextHeading.index) : remaining;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a valid number`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const markdownDir = readOption(args, "--markdown-dir");
  const jsonDir = readOption(args, "--json-dir");
  const outputDir = readOption(args, "--output-dir");

  if (!markdownDir || !jsonDir || !outputDir) {
    throw new Error("Missing required arguments: --markdown-dir, --json-dir, --output-dir");
  }

  return {
    markdownDir: resolve(markdownDir),
    jsonDir: resolve(jsonDir),
    outputDir: resolve(outputDir),
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

// Only execute main if run as a CLI script
if (process.argv[1] && basename(process.argv[1]).startsWith("aggregate-ollama-review")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
