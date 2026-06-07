import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSharePointImporter } from "../src/sharepoint-importer.js";

describe("runSharePointImporter", () => {
  let rootDir: string;
  let outputDir: string;
  let logDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sharepoint-importer-test-"));
    outputDir = join(rootDir, "import-raw-sharepoint");
    logDir = join(rootDir, "import-logs");

    await mkdir(outputDir);
    await mkdir(logDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("processes a sharepoint link and generates dry-run reports without creating files", async () => {
    let stdoutText = "";
    let stderrText = "";

    await runSharePointImporter(
      {
        outputDir,
        url: "https://company.sharepoint.com/sites/CarePortal/Shared Documents/manual-2026.pdf",
        title: "Care Observation Manual 2026",
        itemType: "file",
        logDir,
        apply: false,
      },
      (text) => { stdoutText += text; },
      (text) => { stderrText += text; }
    );

    expect(stdoutText).toContain("SharePoint Import Dry-run reports written to");
    expect(stdoutText).toContain("Summary: 1 planned, 0 skipped.");
    expect(stderrText).toBe("");

    // Verify reports exist
    const reportFiles = await readdir(logDir);
    expect(reportFiles).toContain("sharepoint_import_plan.json");
    expect(reportFiles).toContain("sharepoint_import_skipped.json");
    expect(reportFiles).toContain("sharepoint_import_summary.json");

    // Verify summary
    const summaryRaw = await readFile(join(logDir, "sharepoint_import_summary.json"), "utf8");
    const summary = JSON.parse(summaryRaw);
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(0);

    // Verify no files are written to outputDir
    const files = await readdir(outputDir);
    expect(files).toHaveLength(0);
  });

  it("creates a standardized inventory file when apply is true, applying safety defaults", async () => {
    let stdoutText = "";

    await runSharePointImporter(
      {
        outputDir,
        url: "https://company.sharepoint.com/sites/CarePortal/SitePages/Home.aspx",
        title: "Home Portal Page",
        itemType: "page",
        logDir,
        apply: true,
      },
      (text) => { stdoutText += text; },
      () => {}
    );

    expect(stdoutText).toContain("[IMPORTED] Generated SharePoint inventory file: sharepoint-Home-Portal-Page.md");

    // Verify file exists
    const files = await readdir(outputDir);
    expect(files).toContain("sharepoint-Home-Portal-Page.md");

    // Verify contents and safety rules
    const fileContent = await readFile(join(outputDir, "sharepoint-Home-Portal-Page.md"), "utf8");
    expect(fileContent).toMatch(/^importId: imp-sp-\d{8}-[a-z0-9]{6}$/mu);
    expect(fileContent).toContain("sourceSystem: sharepoint");
    expect(fileContent).toContain("sourceUrl: https://company.sharepoint.com/sites/CarePortal/SitePages/Home.aspx");
    expect(fileContent).toContain("title: Home Portal Page");
    expect(fileContent).toContain("itemType: page");
    expect(fileContent).toContain("importedAt:");
    expect(fileContent).toContain("originalCreatedAt: null");
    expect(fileContent).toContain("originalUpdatedAt: null");
    expect(fileContent).toContain("promotionReason: SharePoint inventory record creation.");
    expect(fileContent).toContain("textExtractionStatus: metadata_only");
    
    // Safety rules: automatic promotion prohibited, needs review
    expect(fileContent).toContain("promotionStatus: needs_review");
    expect(fileContent).toContain("attachmentPolicy: review");
    expect(fileContent).toContain("containsPersonalInfo: unknown");

    // Verify body content
    expect(fileContent).toContain("# SharePoint Document Inventory: Home Portal Page");
    expect(fileContent).toContain("Actual content extraction was bypassed to enforce security");
  });

  it("sanitizes filename and skips existing imports to prevent overwriting", async () => {
    // 1. Create a dummy file with bad name characters (which will be sanitized)
    const titleWithBadChars = "Care: Observation/Guide*2026?"; // Will be sanitized to Care_-Observation_Guide_2026_
    const expectedSanitizedName = "sharepoint-Care_-Observation_Guide_2026_.md";

    // Write pre-existing file in outputDir
    await writeFile(
      join(outputDir, expectedSanitizedName),
      `---
sourceSystem: sharepoint
sourceUrl: https://company.sharepoint.com/sites/existing
---
`,
      "utf8"
    );

    // 2. Try to import the same title (duplicate filename)
    let stdoutText = "";
    await runSharePointImporter(
      {
        outputDir,
        url: "https://company.sharepoint.com/sites/new",
        title: titleWithBadChars,
        itemType: "file",
        logDir,
        apply: false,
      },
      (text) => { stdoutText += text; },
      () => {}
    );

    expect(stdoutText).toContain("Summary: 0 planned, 1 skipped.");

    const skippedRaw = await readFile(join(logDir, "sharepoint_import_skipped.json"), "utf8");
    const skipped = JSON.parse(skippedRaw);
    expect(skipped[0].reason).toBe("inventory_exists");
    expect(skipped[0].details).toContain("already exists");
  });

  it("throws error for missing or invalid arguments", async () => {
    // Invalid itemType
    await expect(
      runSharePointImporter(
        {
          outputDir,
          url: "https://company.sharepoint.com/sites/new",
          title: "Test",
          itemType: "invalid-type" as any,
          logDir,
          apply: false,
        },
        () => {},
        () => {}
      )
    ).rejects.toThrow("Invalid item-type");
  });
});
