#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

interface CliOptions {
  outputDir: string;
  url: string;
  title: string;
  itemType: "file" | "folder" | "page" | "unknown";
  logDir: string;
  apply: boolean;
}

interface SharePointFrontmatter {
  importId: string;
  sourceSystem: "sharepoint";
  sourceUrl: string;
  title: string;
  itemType: "file" | "folder" | "page" | "unknown";
  importedAt: string;
  originalCreatedAt: null;
  originalUpdatedAt: null;
  promotionReason: string;
  fetchStatus: "success" | "failed";
  textExtractionStatus: "extracted" | "metadata_only" | "failed";
  promotionStatus: "needs_review" | "rejected";
  attachmentPolicy: "review";
  containsPersonalInfo: "unknown";
}

interface ImportPlanItem {
  fileName: string;
  sourceUrl: string;
  title: string;
  itemType: string;
  frontmatter: SharePointFrontmatter;
}

interface SkippedItem {
  sourceUrl: string;
  title: string;
  reason: "inventory_exists" | "write_error";
  details: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runSharePointImporter(
    options,
    process.stdout.write.bind(process.stdout),
    process.stderr.write.bind(process.stderr)
  );
}

export async function runSharePointImporter(
  options: CliOptions,
  stdout: (text: string) => void,
  stderr: (text: string) => void
): Promise<void> {
  const allowedTypes = ["file", "folder", "page", "unknown"] as const;
  if (!allowedTypes.includes(options.itemType)) {
    throw new Error(`Invalid item-type: "${options.itemType}". Must be one of [${allowedTypes.join(", ")}]`);
  }

  await mkdir(options.outputDir, { recursive: true });
  await mkdir(options.logDir, { recursive: true });

  stdout(`Scanning target inventory directory: ${options.outputDir}\n`);

  // 1. Scan existing inventory files to check for duplicate sourceUrl
  let existingFiles: string[] = [];
  try {
    existingFiles = (await readdir(options.outputDir))
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (err) {
    // Ignore and proceed
  }

  const existingUrls = new Set<string>();
  const existingFileNames = new Set<string>(existingFiles);

  for (const name of existingFiles) {
    const filePath = join(options.outputDir, name);
    try {
      const content = await readFile(filePath, "utf8");
      const fmMatch = /^---\n([\s\S]*?)\n---\n/m.exec(content);
      if (fmMatch && fmMatch[1]) {
        const fm = parseYaml(fmMatch[1]) as Record<string, any>;
        if (fm && typeof fm === "object" && typeof fm.sourceUrl === "string") {
          existingUrls.add(fm.sourceUrl);
        }
      }
    } catch (err) {
      stderr(`Warning: Failed to read/parse existing inventory file ${name}: ${String(err)}\n`);
    }
  }

  const planList: ImportPlanItem[] = [];
  const skippedList: SkippedItem[] = [];

  // 2. Title Sanitization for safe fileName
  // Remove OS forbidden characters: \ / : * ? " < > |
  const safeTitle = options.title.replace(/[\\/:*?"<>|]/gu, "_").replace(/\s+/gu, "-").trim();
  const fileName = `sharepoint-${safeTitle || "item"}.md`;

  // 3. Duplication Check (URL and Filename)
  if (existingUrls.has(options.url) || existingFileNames.has(fileName)) {
    skippedList.push({
      sourceUrl: options.url,
      title: options.title,
      reason: "inventory_exists",
      details: `Inventory record with the same URL or filename already exists: ${fileName}`,
    });
  } else {
    // Generate Frontmatter
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const rand = Math.random().toString(36).substring(2, 8);
    const importId = `imp-sp-${dateStr}-${rand}`;

    const frontmatter: SharePointFrontmatter = {
      importId,
      sourceSystem: "sharepoint",
      sourceUrl: options.url,
      title: options.title,
      itemType: options.itemType,
      importedAt: new Date().toISOString(),
      originalCreatedAt: null,
      originalUpdatedAt: null,
      promotionReason: "SharePoint inventory record creation. Automatic promotion prohibited.",
      fetchStatus: "success",
      textExtractionStatus: "metadata_only",
      promotionStatus: "needs_review", // Safety rule: automatic promotion prohibited
      attachmentPolicy: "review",
      containsPersonalInfo: "unknown",
    };

    planList.push({
      fileName,
      sourceUrl: options.url,
      title: options.title,
      itemType: options.itemType,
      frontmatter,
    });
  }

  // 4. Write reports
  const summary = {
    status: "sharepoint_import_summary",
    generatedAt: new Date().toISOString(),
    total: 1,
    imported: planList.length,
    skipped: skippedList.length,
  };

  await writeFile(join(options.logDir, "sharepoint_import_plan.json"), `${JSON.stringify(planList, null, 2)}\n`, "utf8");
  await writeFile(join(options.logDir, "sharepoint_import_skipped.json"), `${JSON.stringify(skippedList, null, 2)}\n`, "utf8");
  await writeFile(join(options.logDir, "sharepoint_import_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  stdout(`SharePoint Import Dry-run reports written to ${options.logDir}\n`);
  stdout(`Summary: ${planList.length} planned, ${skippedList.length} skipped.\n\n`);

  if (!options.apply) {
    stdout("Dry-run complete. Run with --apply to execute file output.\n");
    return;
  }

  // 5. File Output Phase
  for (const plan of planList) {
    const fmYaml = stringifyYaml(plan.frontmatter);
    const body = `# SharePoint Document Inventory: ${plan.title}

- **Source URL**: ${plan.sourceUrl}
- **Item Type**: ${plan.itemType}
- **Imported At**: ${plan.frontmatter.importedAt}


## Metadata Summary
This record represents a reference to a SharePoint resource.
Actual content extraction was bypassed to enforce security and privacy policies (metadata-only inventory).
`;

    const destPath = join(options.outputDir, plan.fileName);
    await writeFile(destPath, `---\n${fmYaml}---\n\n${body}`, "utf8");
    stdout(`[IMPORTED] Generated SharePoint inventory file: ${plan.fileName}\n`);
  }

  stdout("\nSharePoint import completed successfully.\n");
}

function parseArgs(args: string[]): CliOptions {
  const outputDir = readOption(args, "--output-dir");
  const url = readOption(args, "--url");
  const title = readOption(args, "--title");
  const itemTypeVal = readOption(args, "--item-type");
  const logDir = readOption(args, "--log-dir");
  const apply = args.includes("--apply");

  if (!outputDir || !url || !title || !itemTypeVal || !logDir) {
    throw new Error("Missing required arguments: --output-dir, --url, --title, --item-type, --log-dir");
  }

  const allowedTypes = ["file", "folder", "page", "unknown"] as const;
  if (!allowedTypes.includes(itemTypeVal as any)) {
    throw new Error(`Invalid item-type: "${itemTypeVal}". Must be one of [${allowedTypes.join(", ")}]`);
  }

  return {
    outputDir: resolve(outputDir),
    url,
    title,
    itemType: itemTypeVal as any,
    logDir: resolve(logDir),
    apply,
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
if (process.argv[1] && basename(process.argv[1]).startsWith("sharepoint-importer")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
