#!/usr/bin/env node

import { stat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  filterBatchNames,
  parseOptionalCount,
  validateBatchScope,
  type BatchScope,
} from "./batch-scope.js";
import { StandardizedFrontmatter } from "./promote-gate.js";

interface CliOptions extends BatchScope {
  rawDir: string;
  standardizedDir: string;
  logDir: string;
  apply: boolean;
}

interface NormalizationPlanItem {
  fileName: string;
  sourceSystem: string;
  importId: string;
  frontmatter: StandardizedFrontmatter;
}

interface SkippedItem {
  fileName: string;
  sourceSystem: string;
  reason: "standardized_exists" | "empty_body" | "read_error";
  details: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runImportNormalizer(
    options,
    process.stdout.write.bind(process.stdout),
    process.stderr.write.bind(process.stderr)
  );
}

export async function runImportNormalizer(
  options: CliOptions,
  stdout: (text: string) => void,
  stderr: (text: string) => void
): Promise<void> {
  await mkdir(options.standardizedDir, { recursive: true });
  await mkdir(options.logDir, { recursive: true });

  const systems = [
    { name: "apple-notes", folder: "apple-notes" },
    { name: "onenote", folder: "onenote" },
  ];

  const rawFiles: Array<{ fileName: string; filePath: string; sourceSystem: string }> = [];

  for (const sys of systems) {
    const sysPath = join(options.rawDir, sys.folder);
    let files: string[] = [];
    try {
      files = (await readdir(sysPath))
        .filter((name) => name.endsWith(".md"))
        .sort();
    } catch (err) {
      // It's acceptable if one of the folders doesn't exist, just warn and continue
      stderr(`Warning: Raw folder for ${sys.name} does not exist at ${sysPath}. Skipping system.\n`);
      continue;
    }

    for (const file of files) {
      rawFiles.push({
        fileName: file,
        filePath: join(sysPath, file),
        sourceSystem: sys.name,
      });
    }
  }

  const selectedNames = new Set(
    filterBatchNames(
      rawFiles.map((file) => file.fileName),
      options,
    ),
  );
  const selectedRawFiles = rawFiles.filter((file) =>
    selectedNames.has(file.fileName),
  );

  stdout(`Scanned raw directory. Found ${selectedRawFiles.length} raw Markdown files to normalize.\n`);

  // Scan standardized directory to check for existing files to avoid overwriting
  let existingStandardized: string[] = [];
  try {
    existingStandardized = await readdir(options.standardizedDir);
  } catch (err) {
    // Ignore and proceed
  }
  const existingStandardizedSet = new Set(existingStandardized);

  const planList: NormalizationPlanItem[] = [];
  const skippedList: SkippedItem[] = [];

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  for (const raw of selectedRawFiles) {
    const name = raw.fileName;
    
    // Guardrail: Do not overwrite existing standardized files
    if (existingStandardizedSet.has(name)) {
      skippedList.push({
        fileName: name,
        sourceSystem: raw.sourceSystem,
        reason: "standardized_exists",
        details: `File already exists in standardized directory: ${join(options.standardizedDir, name)}`,
      });
      continue;
    }

    let rawContent = "";
    let fileStat;
    try {
      rawContent = await readFile(raw.filePath, "utf8");
      fileStat = await stat(raw.filePath);
    } catch (err) {
      skippedList.push({
        fileName: name,
        sourceSystem: raw.sourceSystem,
        reason: "read_error",
        details: `Failed to read raw file or stat: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Frontmatter stripping: if original has YAML frontmatter, strip it to get clean body
    let body = rawContent.replace(/\r\n?/gu, "\n").replace(/^\uFEFF/, "");
    const fmMatch = /^---\n([\s\S]*?)\n---\n/m.exec(body);
    let existingNoteId: string | undefined;
    if (fmMatch) {
      const existingFrontmatter = parseYaml(fmMatch[1]!) as unknown;
      if (
        existingFrontmatter &&
        typeof existingFrontmatter === "object" &&
        !Array.isArray(existingFrontmatter) &&
        typeof (existingFrontmatter as Record<string, unknown>).noteId === "string"
      ) {
        existingNoteId = requireNoteId(
          (existingFrontmatter as Record<string, string>).noteId!,
        );
      }
      body = body.slice(fmMatch[0].length);
    }

    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) {
      skippedList.push({
        fileName: name,
        sourceSystem: raw.sourceSystem,
        reason: "empty_body",
        details: "Raw file body is empty after stripping existing frontmatter.",
      });
      continue;
    }

    // Attachment Policy Estimation: scan for Markdown attachments or Obsidian links
    // Match Markdown images like ![alt](path) or Obsidian embeddings like ![[file]] or wiki links [[file]]
    const attachmentPattern = /!\[.*?\]\(.*?\)|!\[\[.*?\]\]|\[\[.*?\]\]/u;
    const hasAttachments = attachmentPattern.test(trimmedBody);
    const attachmentPolicy = hasAttachments ? "review" : "strip";

    // Generate unique importId
    const rand = Math.random().toString(36).substring(2, 8);
    const systemPrefix = raw.sourceSystem === "apple-notes" ? "an" : "on";
    const importId = `imp-${systemPrefix}-${dateStr}-${rand}`;

    // Timestamps
    const importedAt = new Date().toISOString();
    const originalCreatedAt = fileStat.birthtime ? fileStat.birthtime.toISOString() : null;
    const originalUpdatedAt = fileStat.mtime ? fileStat.mtime.toISOString() : null;

    const promotionStatus = hasAttachments ? "needs_review" : "promoted";
    const promotionReason = hasAttachments 
      ? "Initial normalization. Flagged for review due to embedded attachment/links."
      : "Initial normalization. Passed standard validation.";

    const frontmatter: StandardizedFrontmatter = {
      importId,
      noteId: existingNoteId ?? importId,
      sourceSystem: raw.sourceSystem,
      sourcePath: resolve(raw.filePath),
      importedAt,
      originalCreatedAt,
      originalUpdatedAt,
      promotionStatus,
      promotionReason,
      containsPersonalInfo: "unknown",
      attachmentPolicy,
      type: "unknown",
    };

    planList.push({
      fileName: name,
      sourceSystem: raw.sourceSystem,
      importId,
      frontmatter,
    });
  }

  // Write reports
  const summary = {
    status: "normalization_summary",
    generatedAt: new Date().toISOString(),
    total: selectedRawFiles.length,
    normalized: planList.length,
    skipped: skippedList.length,
  };

  await writeFile(join(options.logDir, "normalization_plan.json"), `${JSON.stringify(planList, null, 2)}\n`, "utf8");
  await writeFile(join(options.logDir, "normalization_skipped.json"), `${JSON.stringify(skippedList, null, 2)}\n`, "utf8");
  await writeFile(join(options.logDir, "normalization_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  stdout(`Normalization Dry-run reports written to ${options.logDir}\n`);
  stdout(`Summary: ${planList.length} files planned to normalize, ${skippedList.length} files skipped.\n\n`);

  if (!options.apply) {
    stdout("Dry-run complete. Run with --apply to execute normalization output.\n");
    return;
  }

  // File write-out phase
  stdout("Writing standardized files...\n");

  for (const plan of planList) {
    const rawFile = selectedRawFiles.find((f) => f.fileName === plan.fileName)!;
    
    // Read raw content again to construct final content
    const rawContent = await readFile(rawFile.filePath, "utf8");
    let body = rawContent.replace(/\r\n?/gu, "\n").replace(/^\uFEFF/, "");
    const fmMatch = /^---\n([\s\S]*?)\n---\n/m.exec(body);
    if (fmMatch) {
      body = body.slice(fmMatch[0].length);
    }

    const fmYaml = stringifyYaml(plan.frontmatter);
    const standardizedContent = `---\n${fmYaml}---\n\n${body.trim()}\n`;

    const destPath = join(options.standardizedDir, plan.fileName);
    await writeFile(destPath, standardizedContent, "utf8");
    stdout(`[NORMALIZED] Generated standardized file: ${plan.fileName}\n`);
  }

  stdout("\nNormalization completed successfully.\n");
}

function parseArgs(args: string[]): CliOptions {
  const rawDir = readOption(args, "--raw-dir");
  const standardizedDir = readOption(args, "--standardized-dir");
  const logDir = readOption(args, "--log-dir");
  const apply = args.includes("--apply");
  const includePrefix = readOption(args, "--include-prefix");
  const minFiles = parseOptionalCount(readOption(args, "--min-files"), "--min-files");
  const maxFiles = parseOptionalCount(readOption(args, "--max-files"), "--max-files");

  if (!rawDir || !standardizedDir || !logDir) {
    throw new Error("Missing required arguments: --raw-dir, --standardized-dir, --log-dir");
  }

  const options: CliOptions = {
    rawDir: resolve(rawDir),
    standardizedDir: resolve(standardizedDir),
    logDir: resolve(logDir),
    apply,
    ...(includePrefix ? { includePrefix } : {}),
    ...(minFiles !== undefined ? { minFiles } : {}),
    ...(maxFiles !== undefined ? { maxFiles } : {}),
  };
  validateBatchScope(options);
  return options;
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

function requireNoteId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`Invalid noteId in raw frontmatter: "${value}"`);
  }
  return value;
}

// CLI Execution Wrapper
if (process.argv[1] && basename(process.argv[1]).startsWith("import-normalizer")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
