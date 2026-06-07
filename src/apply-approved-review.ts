#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

interface ApprovedArtifact {
  artifactId: string;
  status: string;
  sourceNoteIds: string[];
  classification: string;
  previousClassification: string;
  ollamaClassification: string;
}

interface CliOptions {
  approvedJson: string;
  sourceDir: string;
  reportDir: string;
  apply: boolean;
  confirmReviewed: boolean;
  backupDir?: string;
}

interface ApplyPlanItem {
  noteId: string;
  fileName: string;
  currentType: string;
  proposedType: string;
}

interface SkippedItem {
  noteId: string;
  fileName: string;
  reason: "no_change" | "not_approved" | "file_missing";
  details?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runApplyApprovedReview(
    options,
    process.stdout.write.bind(process.stdout),
    process.stderr.write.bind(process.stderr)
  );
}

export async function runApplyApprovedReview(
  options: CliOptions,
  stdout: (text: string) => void,
  stderr: (text: string) => void
): Promise<void> {
  // Guardrail check: if apply is requested, verify confirmReviewed and backupDir
  if (options.apply || options.confirmReviewed) {
    if (!options.apply || !options.confirmReviewed) {
      throw new Error("Both --apply and --confirm-reviewed flags must be provided to apply changes.");
    }
    if (!options.backupDir) {
      throw new Error("--backup-dir <path> is required when applying changes.");
    }
  }

  let approvedList: ApprovedArtifact[] = [];
  try {
    const raw = await readFile(options.approvedJson, "utf8");
    approvedList = JSON.parse(raw) as ApprovedArtifact[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read approved artifacts from ${options.approvedJson}: ${message}`);
  }

  stdout(`Loaded ${approvedList.length} approved artifacts.\n`);

  // Build maps of approved classifications
  const approvedNotesMap = new Map<string, string>(); // noteId -> classification
  for (const approved of approvedList) {
    if (approved.status !== "approved") {
      continue;
    }
    for (const noteId of approved.sourceNoteIds) {
      approvedNotesMap.set(noteId, approved.classification);
    }
  }

  // Scan source notes directory
  let filesInSource: string[] = [];
  try {
    filesInSource = (await readdir(options.sourceDir))
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read source directory ${options.sourceDir}: ${message}`);
  }

  const sourceNotesSet = new Set(filesInSource.map((name) => basename(name, ".md")));

  const plan: ApplyPlanItem[] = [];
  const skipped: SkippedItem[] = [];
  const affectedNotes: string[] = [];
  let diffMarkdown = `# Apply Diff Report\n\nGenerated at: ${new Date().toISOString()}\n\n`;

  // 1. Process files in source directory
  for (const name of filesInSource) {
    const noteId = basename(name, ".md");
    const filePath = join(options.sourceDir, name);

    // If not approved
    if (!approvedNotesMap.has(noteId)) {
      skipped.push({
        noteId,
        fileName: name,
        reason: "not_approved",
        details: "This note has not been approved in approved_artifacts.json.",
      });
      continue;
    }

    const proposedType = approvedNotesMap.get(noteId)!;

    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      stderr(`Warning: Failed to read ${name} even though it exists. Skipping.\n`);
      continue;
    }

    // Find YAML frontmatter
    const fmMatch = /^---\n([\s\S]*?)\n---\n/m.exec(content);
    if (!fmMatch || !fmMatch[1]) {
      skipped.push({
        noteId,
        fileName: name,
        reason: "not_approved",
        details: "No valid YAML frontmatter found in source note.",
      });
      continue;
    }

    const frontmatterText = fmMatch[1];
    const typeMatch = /^type:\s*(\S+)\s*$/m.exec(frontmatterText);
    if (!typeMatch) {
      skipped.push({
        noteId,
        fileName: name,
        reason: "not_approved",
        details: '"type" field not found in frontmatter of source note.',
      });
      continue;
    }

    const currentType = typeMatch[1]!;

    if (currentType === proposedType) {
      skipped.push({
        noteId,
        fileName: name,
        reason: "no_change",
        details: `The file type is already "${proposedType}".`,
      });
      continue;
    }

    // Plan change
    plan.push({
      noteId,
      fileName: name,
      currentType,
      proposedType,
    });
    affectedNotes.push(noteId);

    diffMarkdown += `## ${name}\n\n`;
    diffMarkdown += `\`\`\`diff\n`;
    diffMarkdown += `--- ${name} (current)\n`;
    diffMarkdown += `+++ ${name} (proposed)\n`;
    diffMarkdown += `@@ - type: ${currentType} + type: ${proposedType} @@\n`;
    diffMarkdown += `- type: ${currentType}\n`;
    diffMarkdown += `+ type: ${proposedType}\n`;
    diffMarkdown += `\`\`\`\n\n`;
  }

  // 2. Identify missing source note files for approved notes
  for (const [noteId, proposedType] of approvedNotesMap.entries()) {
    if (!sourceNotesSet.has(noteId)) {
      skipped.push({
        noteId,
        fileName: `${noteId}.md`,
        reason: "file_missing",
        details: `Source note file does not exist in ${options.sourceDir}.`,
      });
    }
  }

  // Write dry-run reports
  await mkdir(options.reportDir, { recursive: true });
  await writeFile(join(options.reportDir, "apply_plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(join(options.reportDir, "apply_diff.md"), diffMarkdown, "utf8");
  await writeFile(join(options.reportDir, "affected_notes.json"), `${JSON.stringify(affectedNotes, null, 2)}\n`, "utf8");
  await writeFile(join(options.reportDir, "skipped_items.json"), `${JSON.stringify(skipped, null, 2)}\n`, "utf8");

  stdout(`Dry-run reports written to ${options.reportDir}\n`);
  stdout(`Summary: ${plan.length} notes planned to change, ${skipped.length} items skipped.\n\n`);

  if (!options.apply) {
    stdout("Dry-run complete. Run with --apply --confirm-reviewed --backup-dir <path> to execute updates.\n");
    return;
  }

  // Proceed with Backup
  const backupDir = resolve(options.backupDir!);
  stdout(`Backing up source notes to ${backupDir}...\n`);
  await mkdir(backupDir, { recursive: true });
  await cp(options.sourceDir, backupDir, { recursive: true });
  stdout("Backup complete.\n\n");

  // Apply changes to files
  for (const item of plan) {
    const filePath = join(options.sourceDir, item.fileName);
    let content = await readFile(filePath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---\n/m.exec(content)!;
    const frontmatterText = fmMatch[1]!;
    const updatedFrontmatterText = frontmatterText.replace(
      /^type:\s*(\S+)\s*$/m,
      `type: ${item.proposedType}`
    );
    const updatedContent = content.replace(frontmatterText, updatedFrontmatterText);

    await writeFile(filePath, updatedContent, "utf8");
    stdout(`[APPLIED] Updated type to "${item.proposedType}" in ${item.fileName}\n`);
  }

  stdout(`\nApplied ${plan.length} changes successfully.\n`);
}

function parseArgs(args: string[]): CliOptions {
  const approvedJson = readOption(args, "--approved-json");
  const sourceDir = readOption(args, "--source-dir");
  const reportDir = readOption(args, "--report-dir");
  const backupDir = readOption(args, "--backup-dir");
  const apply = args.includes("--apply");
  const confirmReviewed = args.includes("--confirm-reviewed");

  if (!approvedJson || !sourceDir || !reportDir) {
    throw new Error("Missing required arguments: --approved-json, --source-dir, --report-dir");
  }

  return {
    approvedJson: resolve(approvedJson),
    sourceDir: resolve(sourceDir),
    reportDir: resolve(reportDir),
    apply,
    confirmReviewed,
    ...(backupDir ? { backupDir: resolve(backupDir) } : {}),
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
if (process.argv[1] && basename(process.argv[1]).startsWith("apply-approved-review")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
