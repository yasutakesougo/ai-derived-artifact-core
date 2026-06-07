#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface StandardizedFrontmatter {
  importId: string;
  sourceSystem: string;
  sourcePath?: string | undefined;
  sourceUrl?: string | undefined;
  importedAt: string;
  originalCreatedAt: string | null;
  originalUpdatedAt: string | null;
  promotionStatus: "promoted" | "needs_review" | "rejected";
  promotionReason: string;
  containsPersonalInfo: "true" | "false" | "unknown";
  attachmentPolicy: "strip" | "keep" | "review";
  type?: string | undefined;
}

export interface CliOptions {
  standardizedDir: string;
  sourceDir: string;
  logDir: string;
  rejectedDir: string;
  apply: boolean;
  confirmPromotion: boolean;
}

export interface PromotionPlanItem {
  fileName: string;
  importId: string;
  sourceSystem: string;
  proposedType: string;
}

export interface SkippedItem {
  fileName: string;
  importId?: string;
  reason: "duplicate_filename" | "duplicate_import_id" | "invalid_frontmatter" | "no_change";
  details: string;
}

export interface ParseResult {
  fileName: string;
  filePath: string;
  content: string;
  frontmatter: StandardizedFrontmatter | null;
  body: string;
  parseError?: string;
}

export interface EvaluationResult {
  parseResult: ParseResult;
  finalStatus: "promoted" | "needs_review" | "rejected";
  reasons: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runPromotionGate(
    options,
    process.stdout.write.bind(process.stdout),
    process.stderr.write.bind(process.stderr)
  );
}

export async function runPromotionGate(
  options: CliOptions,
  stdout: (text: string) => void,
  stderr: (text: string) => void
): Promise<void> {
  // 1. Guardrail validation
  if (options.apply || options.confirmPromotion) {
    if (!options.apply || !options.confirmPromotion) {
      throw new Error("Both --apply and --confirm-promotion flags must be provided to apply changes.");
    }
  }

  // Ensure directories exist (sourceDir is expected to exist, others will be created if needed)
  await mkdir(options.logDir, { recursive: true });
  await mkdir(options.rejectedDir, { recursive: true });

  // 2. Scan existing source notes for duplication check (filename & importId)
  let existingFiles: string[] = [];
  try {
    existingFiles = (await readdir(options.sourceDir))
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read source directory ${options.sourceDir}: ${message}`);
  }

  const existingFileNamesSet = new Set(existingFiles);
  const existingImportIdsSet = new Set<string>();

  for (const name of existingFiles) {
    const filePath = join(options.sourceDir, name);
    try {
      const content = await readFile(filePath, "utf8");
      const fmMatch = /^---\n([\s\S]*?)\n---\n/m.exec(content);
      if (fmMatch && fmMatch[1]) {
        const fm = parseYaml(fmMatch[1]) as Record<string, any>;
        if (fm && typeof fm === "object" && typeof fm.importId === "string") {
          existingImportIdsSet.add(fm.importId);
        }
      }
    } catch (err) {
      stderr(`Warning: Failed to read/parse existing source file ${name} for importId: ${String(err)}\n`);
    }
  }

  // 3. Scan standardized notes directory
  let standardizedFiles: string[] = [];
  try {
    standardizedFiles = (await readdir(options.standardizedDir))
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read standardized directory ${options.standardizedDir}: ${message}`);
  }

  stdout(`Loaded ${standardizedFiles.length} standardized files to evaluate.\n`);

  const parsedList: ParseResult[] = [];
  const skippedList: SkippedItem[] = [];

  // 4. Parse files
  for (const name of standardizedFiles) {
    const filePath = join(options.standardizedDir, name);
    try {
      const content = await readFile(filePath, "utf8");
      const normalized = content.replace(/\r\n?/gu, "\n").replace(/^\uFEFF/, "");
      
      if (!normalized.startsWith("---\n")) {
        skippedList.push({
          fileName: name,
          reason: "invalid_frontmatter",
          details: "Missing YAML frontmatter block.",
        });
        continue;
      }
      
      const closingIndex = normalized.indexOf("\n---\n", 4);
      if (closingIndex === -1) {
        skippedList.push({
          fileName: name,
          reason: "invalid_frontmatter",
          details: "Unclosed YAML frontmatter block.",
        });
        continue;
      }
      
      const yamlText = normalized.slice(4, closingIndex);
      const body = normalized.slice(closingIndex + 5);
      
      let fm: any;
      try {
        fm = parseYaml(yamlText);
      } catch (err) {
        skippedList.push({
          fileName: name,
          reason: "invalid_frontmatter",
          details: `YAML parsing error: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
        skippedList.push({
          fileName: name,
          reason: "invalid_frontmatter",
          details: "YAML frontmatter is not a mapping.",
        });
        continue;
      }

      // Basic validation of fields
      try {
        const frontmatter: StandardizedFrontmatter = {
          importId: requireString(fm.importId, "importId"),
          sourceSystem: requireString(fm.sourceSystem, "sourceSystem"),
          sourcePath: fm.sourcePath !== undefined ? requireString(fm.sourcePath, "sourcePath") : undefined,
          sourceUrl: fm.sourceUrl !== undefined ? requireString(fm.sourceUrl, "sourceUrl") : undefined,
          importedAt: requireString(fm.importedAt, "importedAt"),
          originalCreatedAt: fm.originalCreatedAt === null ? null : requireString(fm.originalCreatedAt, "originalCreatedAt"),
          originalUpdatedAt: fm.originalUpdatedAt === null ? null : requireString(fm.originalUpdatedAt, "originalUpdatedAt"),
          promotionStatus: requireEnum(fm.promotionStatus, ["promoted", "needs_review", "rejected"], "promotionStatus"),
          promotionReason: requireString(fm.promotionReason, "promotionReason"),
          containsPersonalInfo: requireEnum(fm.containsPersonalInfo, ["true", "false", "unknown"], "containsPersonalInfo"),
          attachmentPolicy: requireEnum(fm.attachmentPolicy, ["strip", "keep", "review"], "attachmentPolicy"),
          type: fm.type !== undefined ? requireString(fm.type, "type") : undefined,
        };

        // Ensure at least one of sourcePath or sourceUrl exists
        if (!frontmatter.sourcePath && !frontmatter.sourceUrl) {
          throw new Error("Either sourcePath or sourceUrl must be provided");
        }

        parsedList.push({
          fileName: name,
          filePath,
          content: normalized,
          frontmatter,
          body,
        });
      } catch (err) {
        skippedList.push({
          fileName: name,
          reason: "invalid_frontmatter",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      stderr(`Warning: Failed to read standardized file ${name}: ${String(err)}\n`);
    }
  }

  // 5. Evaluate rules and duplicates
  const evaluatedList: EvaluationResult[] = [];
  const processedImportIdsSet = new Set<string>();
  const processedFileNamesSet = new Set<string>();

  for (const parsed of parsedList) {
    const fm = parsed.frontmatter!;
    const name = parsed.fileName;
    const reasons: string[] = [];
    let isSkipped = false;

    // Duplication Check (Filename)
    if (existingFileNamesSet.has(name) || processedFileNamesSet.has(name)) {
      skippedList.push({
        fileName: name,
        importId: fm.importId,
        reason: "duplicate_filename",
        details: `Filename ${name} already exists in destination or is duplicated in this batch.`,
      });
      isSkipped = true;
    }

    // Duplication Check (ImportId)
    if (existingImportIdsSet.has(fm.importId) || processedImportIdsSet.has(fm.importId)) {
      skippedList.push({
        fileName: name,
        importId: fm.importId,
        reason: "duplicate_import_id",
        details: `ImportId ${fm.importId} already exists in destination or is duplicated in this batch.`,
      });
      isSkipped = true;
    }

    if (isSkipped) {
      continue;
    }

    processedFileNamesSet.add(name);
    processedImportIdsSet.add(fm.importId);

    // Rule Evaluation
    let finalStatus: "promoted" | "needs_review" | "rejected" = fm.promotionStatus;

    // Body length check
    const bodyLength = parsed.body.trim().length;
    if (bodyLength < 20) {
      finalStatus = "rejected";
      reasons.push(`Body length is too short (${bodyLength} chars < 20).`);
    } else if (bodyLength < 50 && finalStatus !== "rejected") {
      finalStatus = "needs_review";
      reasons.push(`Body length is in border-case (${bodyLength} chars < 50).`);
    } else if (bodyLength >= 10000) {
      finalStatus = "rejected";
      reasons.push(`Body length is too long (${bodyLength} chars >= 10000).`);
    }

    // PII check (field value)
    if (fm.containsPersonalInfo === "true") {
      finalStatus = "rejected";
      reasons.push("containsPersonalInfo is explicitly true.");
    } else if (fm.containsPersonalInfo === "unknown" && finalStatus !== "rejected") {
      finalStatus = "needs_review";
      reasons.push("containsPersonalInfo is unknown.");
    }

    // PII regex scan (Japanese phone numbers & email addresses)
    const phoneRegex = /\d{2,4}-\d{2,4}-\d{4}/u;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/u;
    
    if (phoneRegex.test(parsed.body)) {
      if (finalStatus !== "rejected") {
        finalStatus = "needs_review";
      }
      reasons.push("PII Regex Match: Potential phone number detected in body.");
    }
    if (emailRegex.test(parsed.body)) {
      if (finalStatus !== "rejected") {
        finalStatus = "needs_review";
      }
      reasons.push("PII Regex Match: Potential email address detected in body.");
    }

    // Attachment Policy
    if (fm.attachmentPolicy === "review" && finalStatus !== "rejected") {
      finalStatus = "needs_review";
      reasons.push("attachmentPolicy is set to review.");
    }

    // If initial status was rejected/needs_review, keep it or upgrade severity
    if (fm.promotionStatus === "rejected") {
      finalStatus = "rejected";
    } else if (fm.promotionStatus === "needs_review" && finalStatus !== "rejected") {
      finalStatus = "needs_review";
    }

    if (reasons.length === 0) {
      reasons.push("Passed all checks.");
    }

    evaluatedList.push({
      parseResult: parsed,
      finalStatus,
      reasons,
    });
  }

  // 6. Generate reports
  const planList: PromotionPlanItem[] = [];
  let diffMarkdown = `# Promotion Diff Report\n\nGenerated at: ${new Date().toISOString()}\n\n`;
  let promotedCount = 0;
  let needsReviewCount = 0;
  let rejectedCount = 0;

  for (const item of evaluatedList) {
    if (item.finalStatus === "promoted") {
      promotedCount++;
      planList.push({
        fileName: item.parseResult.fileName,
        importId: item.parseResult.frontmatter!.importId,
        sourceSystem: item.parseResult.frontmatter!.sourceSystem,
        proposedType: item.parseResult.frontmatter!.type || "unknown",
      });

      diffMarkdown += `## ${item.parseResult.fileName} (New File)\n\n`;
      diffMarkdown += `\`\`\`diff\n`;
      diffMarkdown += `+++ /source/${item.parseResult.fileName}\n`;
      const lines = item.parseResult.content.split("\n");
      for (const line of lines) {
        diffMarkdown += `+ ${line}\n`;
      }
      diffMarkdown += `\`\`\`\n\n`;
    } else if (item.finalStatus === "needs_review") {
      needsReviewCount++;
    } else if (item.finalStatus === "rejected") {
      rejectedCount++;
    }
  }

  const summary = {
    status: "promotion_summary",
    generatedAt: new Date().toISOString(),
    total: standardizedFiles.length,
    evaluated: evaluatedList.length,
    promoted: promotedCount,
    needsReview: needsReviewCount,
    rejected: rejectedCount,
    skipped: skippedList.length,
  };

  // Write reports to logDir
  await writeFile(join(options.logDir, "promotion_plan.json"), `${JSON.stringify(planList, null, 2)}\n`, "utf8");
  await writeFile(join(options.logDir, "promotion_diff.md"), diffMarkdown, "utf8");
  await writeFile(join(options.logDir, "promotion_skipped.json"), `${JSON.stringify(skippedList, null, 2)}\n`, "utf8");
  await writeFile(join(options.logDir, "promotion_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  stdout(`Promotion Gate Dry-run reports written to ${options.logDir}\n`);
  stdout(`Summary: ${promotedCount} promoted, ${needsReviewCount} needs_review, ${rejectedCount} rejected, ${skippedList.length} skipped.\n\n`);

  if (!options.apply) {
    stdout("Dry-run complete. Run with --apply --confirm-promotion to execute file operations.\n");
    return;
  }

  // 7. Apply phase
  stdout("Applying promotion decisions...\n");

  for (const item of evaluatedList) {
    const srcPath = item.parseResult.filePath;
    
    if (item.finalStatus === "promoted") {
      const destPath = join(options.sourceDir, item.parseResult.fileName);
      await copyFile(srcPath, destPath);
      stdout(`[PROMOTED] Copied ${item.parseResult.fileName} to ${options.sourceDir}\n`);
    } else if (item.finalStatus === "rejected") {
      const destPath = join(options.rejectedDir, item.parseResult.fileName);
      await copyFile(srcPath, destPath);
      await unlink(srcPath);
      stdout(`[REJECTED/ISOLATED] Moved ${item.parseResult.fileName} to ${options.rejectedDir}\n`);
    } else if (item.finalStatus === "needs_review") {
      stdout(`[HELD/REVIEW] Kept ${item.parseResult.fileName} in standardized directory (reasons: ${item.reasons.join(", ")})\n`);
    }
  }

  stdout("\nPromotion operations completed successfully.\n");
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Field "${name}" must be a non-empty string`);
  }
  return value.trim();
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Field "${name}" must be one of [${allowed.join(", ")}], got "${String(value)}"`);
  }
  return value as T;
}

function parseArgs(args: string[]): CliOptions {
  const standardizedDir = readOption(args, "--standardized-dir");
  const sourceDir = readOption(args, "--source-dir");
  const logDir = readOption(args, "--log-dir");
  const rejectedDir = readOption(args, "--rejected-dir");
  const apply = args.includes("--apply");
  const confirmPromotion = args.includes("--confirm-promotion");

  if (!standardizedDir || !sourceDir || !logDir || !rejectedDir) {
    throw new Error("Missing required arguments: --standardized-dir, --source-dir, --log-dir, --rejected-dir");
  }

  return {
    standardizedDir: resolve(standardizedDir),
    sourceDir: resolve(sourceDir),
    logDir: resolve(logDir),
    rejectedDir: resolve(rejectedDir),
    apply,
    confirmPromotion,
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

// CLI Execution Wrapper
if (process.argv[1] && basename(process.argv[1]).startsWith("promote-gate")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
