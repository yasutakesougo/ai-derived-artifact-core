import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImportNormalizer } from "../src/import-normalizer.js";

describe("runImportNormalizer", () => {
  let rootDir: string;
  let rawDir: string;
  let rawAppleDir: string;
  let rawOnenoteDir: string;
  let standardizedDir: string;
  let logDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "import-normalizer-test-"));
    rawDir = join(rootDir, "import-raw");
    rawAppleDir = join(rawDir, "apple-notes");
    rawOnenoteDir = join(rawDir, "onenote");
    standardizedDir = join(rootDir, "import-standardized");
    logDir = join(rootDir, "import-logs");

    await mkdir(rawDir);
    await mkdir(rawAppleDir);
    await mkdir(rawOnenoteDir);
    await mkdir(standardizedDir);
    await mkdir(logDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("identifies and processes raw markdown files, generating dry-run reports", async () => {
    // 1. Normal Apple note without attachments
    await writeFile(
      join(rawAppleDir, "apple-obs-01.md"),
      `# Normal Note Title
This note is from Apple Notes. It has some observations.
No attachments here.
`,
      "utf8"
    );

    // 2. OneNote with attachment reference
    await writeFile(
      join(rawOnenoteDir, "onenote-obs-02.md"),
      `# OneNote Incident
Incident happened. See photo:
![Incident scene](file:///images/floor.jpg)
`,
      "utf8"
    );

    // 3. Apple note with Obsidian wiki-links
    await writeFile(
      join(rawAppleDir, "apple-wiki-links.md"),
      `# Wiki Links Note
Please check [[related-note]].
`,
      "utf8"
    );

    // 4. Empty note (should be skipped)
    await writeFile(join(rawAppleDir, "empty.md"), "   \n  ", "utf8");

    let stdoutText = "";
    let stderrText = "";

    await runImportNormalizer(
      {
        rawDir,
        standardizedDir,
        logDir,
        apply: false,
      },
      (text) => { stdoutText += text; },
      (text) => { stderrText += text; }
    );

    expect(stdoutText).toContain("Scanned raw directory. Found 4 raw Markdown files to normalize.");
    expect(stdoutText).toContain("Summary: 3 files planned to normalize, 1 files skipped.");
    expect(stderrText).toBe("");

    // Verify report output
    const reportFiles = await readdir(logDir);
    expect(reportFiles).toContain("normalization_plan.json");
    expect(reportFiles).toContain("normalization_skipped.json");
    expect(reportFiles).toContain("normalization_summary.json");

    // Verify summary
    const summaryRaw = await readFile(join(logDir, "normalization_summary.json"), "utf8");
    const summary = JSON.parse(summaryRaw);
    expect(summary.total).toBe(4);
    expect(summary.normalized).toBe(3);
    expect(summary.skipped).toBe(1);

    // Verify skipped file details
    const skippedRaw = await readFile(join(logDir, "normalization_skipped.json"), "utf8");
    const skipped = JSON.parse(skippedRaw);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].fileName).toBe("empty.md");
    expect(skipped[0].reason).toBe("empty_body");

    // Verify plan details
    const planRaw = await readFile(join(logDir, "normalization_plan.json"), "utf8");
    const plan = JSON.parse(planRaw);
    expect(plan).toHaveLength(3);

    // check apple-obs-01: no attachments, attachmentPolicy: strip
    const note1 = plan.find((p: any) => p.fileName === "apple-obs-01.md");
    expect(note1).toBeDefined();
    expect(note1.sourceSystem).toBe("apple-notes");
    expect(note1.frontmatter.attachmentPolicy).toBe("strip");

    // check onenote-obs-02: has attachment image, attachmentPolicy: review
    const note2 = plan.find((p: any) => p.fileName === "onenote-obs-02.md");
    expect(note2).toBeDefined();
    expect(note2.sourceSystem).toBe("onenote");
    expect(note2.frontmatter.attachmentPolicy).toBe("review");

    // check apple-wiki-links: has [[wiki-link]], attachmentPolicy: review
    const note3 = plan.find((p: any) => p.fileName === "apple-wiki-links.md");
    expect(note3).toBeDefined();
    expect(note3.sourceSystem).toBe("apple-notes");
    expect(note3.frontmatter.attachmentPolicy).toBe("review");

    // Check no files were created in standardizedDir
    const stdFiles = await readdir(standardizedDir);
    expect(stdFiles).toHaveLength(0);
  });

  it("does not overwrite existing files in standardizedDir", async () => {
    // 1. Write file in standardizedDir
    await writeFile(
      join(standardizedDir, "duplicate-file.md"),
      "Existing standardized content",
      "utf8"
    );

    // 2. Place same file in rawDir
    await writeFile(
      join(rawAppleDir, "duplicate-file.md"),
      "New raw content",
      "utf8"
    );

    let stdoutText = "";
    await runImportNormalizer(
      {
        rawDir,
        standardizedDir,
        logDir,
        apply: false,
      },
      (text) => { stdoutText += text; },
      () => {}
    );

    expect(stdoutText).toContain("Summary: 0 files planned to normalize, 1 files skipped.");

    const skippedRaw = await readFile(join(logDir, "normalization_skipped.json"), "utf8");
    const skipped = JSON.parse(skippedRaw);
    expect(skipped[0].fileName).toBe("duplicate-file.md");
    expect(skipped[0].reason).toBe("standardized_exists");
  });

  it("writes files correctly when apply is true", async () => {
    await writeFile(
      join(rawAppleDir, "sample.md"),
      `# Normal Observation
This is note body text.
`,
      "utf8"
    );

    let stdoutText = "";
    await runImportNormalizer(
      {
        rawDir,
        standardizedDir,
        logDir,
        apply: true,
      },
      (text) => { stdoutText += text; },
      () => {}
    );

    expect(stdoutText).toContain("[NORMALIZED] Generated standardized file: sample.md");

    // Verify standardizedDir contains sample.md
    const stdFiles = await readdir(standardizedDir);
    expect(stdFiles).toContain("sample.md");

    // Verify contents of the generated file
    const fileContent = await readFile(join(standardizedDir, "sample.md"), "utf8");
    expect(fileContent).toContain("importId: imp-an-");
    expect(fileContent).toContain("sourceSystem: apple-notes");
    expect(fileContent).toContain("containsPersonalInfo: unknown");
    expect(fileContent).toContain("# Normal Observation");
    expect(fileContent).toContain("This is note body text.");
  });

  it("strips pre-existing frontmatter in raw file when standardizing", async () => {
    await writeFile(
      join(rawAppleDir, "has-frontmatter.md"),
      `---
oldKey: oldValue
status: raw
---
# Actual Heading
Actual note body text here.
`,
      "utf8"
    );

    await runImportNormalizer(
      {
        rawDir,
        standardizedDir,
        logDir,
        apply: true,
      },
      () => {},
      () => {}
    );

    const fileContent = await readFile(join(standardizedDir, "has-frontmatter.md"), "utf8");
    expect(fileContent).toContain("importId: imp-an-");
    expect(fileContent).not.toContain("oldKey: oldValue");
    expect(fileContent).toContain("# Actual Heading");
    expect(fileContent).toContain("Actual note body text here.");
  });
});
