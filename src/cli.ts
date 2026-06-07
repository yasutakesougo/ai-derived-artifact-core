#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonAuditStore } from "./json-storage.js";
import {
  runFreshness,
  type FreshnessOptions,
  type FreshnessReport,
} from "./dry-run.js";
import {
  scanVaultAndSave,
  type VaultScanAndSaveReport,
} from "./scan-vault.js";
import {
  generateProposalDrafts,
  type ProposalGenerationReport,
} from "./proposals.js";
import {
  exportReviewMarkdown,
  type ReviewExportReport,
} from "./review-export.js";
import {
  importManualReviewDecisions,
  type ReviewImportReport,
} from "./review-import.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function runCli(
  args: readonly string[],
  io: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  try {
    if (args[0] === "freshness") {
      const parsed = parseFreshnessArgs(args);
      const report = await runFreshness(
        new JsonAuditStore(parsed.recordsPath),
        parsed.options,
      );
      io.stdout(formatFreshnessReport(report));
    } else if (args[0] === "scan-vault") {
      const parsed = parseScanVaultArgs(args);
      const report = await scanVaultAndSave(
        new JsonAuditStore(parsed.recordsPath),
        parsed.options,
      );
      io.stdout(formatVaultScanAndSaveReport(report));
    } else if (args[0] === "proposals" || args[0] === "generate-proposals") {
      const parsed = parseProposalArgs(args);
      const report = await generateProposalDrafts(
        new JsonAuditStore(parsed.recordsPath),
        parsed.options,
      );
      io.stdout(formatProposalReport(report));
    } else if (args[0] === "review-export" || args[0] === "export-review") {
      const parsed = parseReviewExportArgs(args);
      const report = await exportReviewMarkdown(
        new JsonAuditStore(parsed.recordsPath),
        parsed.options,
      );
      io.stdout(formatReviewExportReport(report));
    } else if (args[0] === "review-import" || args[0] === "import-review") {
      const parsed = parseReviewImportArgs(args);
      const report = await importManualReviewDecisions(
        new JsonAuditStore(parsed.recordsPath),
        parsed.options,
      );
      io.stdout(formatReviewImportReport(report));
    } else {
      throw new Error(
        "Usage: scan-vault ... | generate-proposals ... | export-review ... | import-review ... | freshness ...",
      );
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}\n`);
    return 1;
  }
}

function parseReviewImportArgs(args: readonly string[]): {
  recordsPath: string;
  options: Parameters<typeof importManualReviewDecisions>[1];
} {
  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  if (dryRun === write) {
    throw new Error(
      "Review import requires exactly one of --dry-run or --write",
    );
  }
  const vaultPath = readOption(args, "--vault");
  const decidedBy = readOption(args, "--decided-by");
  const reason = readOption(args, "--reason");
  const decidedAt = readOption(args, "--decided-at");
  if (!vaultPath) {
    throw new Error("Missing value for --vault");
  }
  if (!decidedBy) {
    throw new Error("Missing value for --decided-by");
  }
  if (!reason) {
    throw new Error("Missing value for --reason");
  }
  if (!decidedAt) {
    throw new Error("Missing value for --decided-at");
  }
  const reviewFolder = readOption(args, "--review-folder");
  const sourceFolder = readOption(args, "--source-folder");
  return {
    recordsPath: resolve(readOption(args, "--records") ?? "records"),
    options: {
      vaultPath: resolve(vaultPath),
      dryRun,
      decidedBy,
      reason,
      decidedAt,
      ...(reviewFolder ? { reviewFolder } : {}),
      ...(sourceFolder ? { sourceFolder } : {}),
    },
  };
}

function parseReviewExportArgs(args: readonly string[]): {
  recordsPath: string;
  options: Parameters<typeof exportReviewMarkdown>[1];
} {
  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  if (dryRun === write) {
    throw new Error(
      "Review export requires exactly one of --dry-run or --write",
    );
  }
  const vaultPath = readOption(args, "--vault");
  if (!vaultPath) {
    throw new Error("Missing value for --vault");
  }
  const reviewFolder = readOption(args, "--review-folder");
  const sourceFolder = readOption(args, "--source-folder");
  return {
    recordsPath: resolve(readOption(args, "--records") ?? "records"),
    options: {
      vaultPath: resolve(vaultPath),
      dryRun,
      ...(reviewFolder ? { reviewFolder } : {}),
      ...(sourceFolder ? { sourceFolder } : {}),
    },
  };
}

interface ParsedFreshnessArgs {
  recordsPath: string;
  options: FreshnessOptions;
}

function parseFreshnessArgs(args: readonly string[]): ParsedFreshnessArgs {
  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  if (dryRun === write) {
    throw new Error(
      "Usage: freshness (--dry-run | --write) [--records PATH] [version options]",
    );
  }

  const recordsPath = resolve(readOption(args, "--records") ?? "records");
  const provider = readOption(args, "--model-provider");
  const name = readOption(args, "--model-name");
  const version = readOption(args, "--model-version");
  const modelParts = [provider, name, version];
  if (modelParts.some(Boolean) && !modelParts.every(Boolean)) {
    throw new Error(
      "--model-provider, --model-name, and --model-version must be used together",
    );
  }
  const ruleVersion = readOption(args, "--rule-version");
  const reviewCriteriaVersion = readOption(
    args,
    "--review-criteria-version",
  );
  const detectedBy = readOption(args, "--detected-by");
  const occurredAt = readOption(args, "--occurred-at");
  const promptVersion = readOption(args, "--prompt-version");
  const promptHash = readOption(args, "--prompt-hash");
  const modelDigest = readOption(args, "--model-digest");

  return {
    recordsPath,
    options: {
      dryRun,
      ...(provider && name && version
        ? { model: { provider, name, version } }
        : {}),
      ...(ruleVersion ? { ruleVersion } : {}),
      ...(reviewCriteriaVersion ? { reviewCriteriaVersion } : {}),
      ...(detectedBy ? { detectedBy } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      ...(promptVersion ? { promptVersion } : {}),
      ...(promptHash ? { promptHash } : {}),
      ...(modelDigest !== undefined ? { modelDigest } : {}),
    },
  };
}

function parseScanVaultArgs(args: readonly string[]): {
  recordsPath: string;
  options: Parameters<typeof scanVaultAndSave>[1];
} {
  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  if (dryRun === write) {
    throw new Error(
      "Usage: scan-vault (--dry-run | --write) --vault PATH [--records PATH] [--source-folder PATH]",
    );
  }
  const vaultPath = readOption(args, "--vault");
  if (!vaultPath) {
    throw new Error("Missing value for --vault");
  }
  const sourceFolder = readOption(args, "--source-folder");
  return {
    recordsPath: resolve(readOption(args, "--records") ?? "records"),
    options: {
      vaultPath: resolve(vaultPath),
      dryRun,
      ...(sourceFolder ? { sourceFolder } : {}),
    },
  };
}

function parseProposalArgs(args: readonly string[]): {
  recordsPath: string;
  options: Parameters<typeof generateProposalDrafts>[1];
} {
  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  if (dryRun === write) {
    throw new Error("Proposals require exactly one of --dry-run or --write");
  }
  const vaultPath = readOption(args, "--vault");
  if (!vaultPath) {
    throw new Error("Missing value for --vault");
  }
  const generatedAt = readOption(args, "--generated-at");
  if (!generatedAt) {
    throw new Error("Missing value for --generated-at");
  }
  const sourceFolder = readOption(args, "--source-folder");
  const provider = readOption(args, "--provider");
  if (provider && provider !== "stub" && provider !== "ollama") {
    throw new Error("Invalid provider option. Must be 'stub' or 'ollama'");
  }
  const ollamaUrl = readOption(args, "--ollama-url");
  const modelName = readOption(args, "--model");
  const promptVersion = readOption(args, "--prompt-version");

  return {
    recordsPath: resolve(readOption(args, "--records") ?? "records"),
    options: {
      vaultPath: resolve(vaultPath),
      dryRun,
      generatedAt,
      ...(sourceFolder ? { sourceFolder } : {}),
      provider: (provider as "stub" | "ollama") ?? "stub",
      ...(ollamaUrl ? { ollamaUrl } : {}),
      ...(modelName ? { modelName } : {}),
      ...(promptVersion ? { promptVersion } : {}),
    },
  };
}

function readOption(
  args: readonly string[],
  option: string,
): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function formatFreshnessReport(report: FreshnessReport): string {
  const lines = [
    report.dryRun ? "Freshness dry-run" : "Freshness evaluation",
    `Evaluated: ${report.evaluatedArtifacts}`,
    `Candidates: ${report.candidates.length}`,
  ];
  for (const candidate of report.candidates) {
    lines.push(
      `${candidate.artifactId}: ${candidate.currentStatus} -> ${candidate.candidateStatus}`,
      `  reasons: ${candidate.evaluation.reasons.join(", ")}`,
    );
  }
  if (report.dryRun) {
    lines.push("No files were modified.");
  } else {
    lines.push(`Written lifecycle events: ${report.writtenEventIds.length}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatVaultScanAndSaveReport(report: VaultScanAndSaveReport): string {
  const lines = [
    report.dryRun ? "Vault scan dry-run" : "Vault scan",
    `Scanned files: ${report.scannedFiles}`,
    `Written source notes: ${report.writtenNoteIds.length}`,
    `Skipped: ${report.skipped.length}`,
  ];
  for (const noteId of report.writtenNoteIds) {
    lines.push(`  Saved SourceNote: ${noteId}`);
  }
  for (const skipped of report.skipped) {
    lines.push(`  Skipped ${skipped.relativePath}: ${skipped.reason}`);
  }
  if (report.dryRun) {
    lines.push("No files were modified.");
  }
  return `${lines.join("\n")}\n`;
}

function formatProposalReport(report: ProposalGenerationReport): string {
  const lines = [
    report.dryRun ? "Proposal generation dry-run" : "Proposal generation",
    `Eligible notes: ${report.eligibleNotes}`,
    `Drafts: ${report.drafts.length}`,
    `Skipped: ${report.skipped.length}`,
  ];
  for (const draft of report.drafts) {
    lines.push(`${draft.artifactId}: ${draft.kind} [${draft.status}]`);
  }
  for (const skipped of report.skipped) {
    lines.push(
      `Skipped ${skipped.relativePath}: ${skipped.reason}`,
    );
  }
  if (report.metrics) {
    const m = report.metrics;
    lines.push(
      "--- metrics ---",
      `  scannedNotes: ${m.scannedNotes}`,
      `  notesWithNoteId: ${m.notesWithNoteId}`,
      `  notesMissingNoteId: ${m.notesMissingNoteId}`,
      `  proposalsGenerated: ${m.proposalsGenerated}`,
      `  proposalsExported: ${m.proposalsExported}`,
      `  proposalsSuppressedByConfidence: ${m.proposalsSuppressedByConfidence}`,
      `  proposalsSuppressedByPolicy: ${m.proposalsSuppressedByPolicy}`,
      `  averageLabelsPerProposal: ${m.averageLabelsPerProposal}`,
      `  maxLabelsPerProposal: ${m.maxLabelsPerProposal}`,
      `  evidenceAverageLength: ${m.evidenceAverageLength}`,
      `  evidenceMaxLength: ${m.evidenceMaxLength}`,
    );
  }
  lines.push(
    report.dryRun
      ? "No files were modified."
      : `Written artifacts: ${report.writtenArtifactIds.length}`,
  );
  return `${lines.join("\n")}\n`;
}

function formatReviewExportReport(report: ReviewExportReport): string {
  const lines = [
    report.dryRun ? "Review export dry-run" : "Review export",
    `Output: ${report.outputPath}`,
    `Artifacts: ${report.items.length}`,
  ];
  for (const item of report.items) {
    lines.push(`${item.artifactId}: ${item.status} -> ${item.relativePath}`);
  }
  lines.push(
    report.dryRun
      ? "No files were modified."
      : `Written Markdown files: ${report.writtenPaths.length}`,
  );
  return `${lines.join("\n")}\n`;
}

function formatReviewImportReport(report: ReviewImportReport): string {
  const lines = [
    report.dryRun ? "Review import dry-run" : "Review import",
    `Decisions: ${report.items.length}`,
    `Skipped: ${report.skipped.length}`,
  ];
  for (const item of report.items) {
    lines.push(`${item.artifactId}: ${item.outcome}`);
  }
  for (const skipped of report.skipped) {
    lines.push(`Skipped ${skipped.relativePath}: ${skipped.reason}`);
  }
  lines.push(
    report.dryRun
      ? "No records were modified."
      : `Written ReviewDecisions: ${report.writtenDecisionIds.length}`,
  );
  return `${lines.join("\n")}\n`;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
