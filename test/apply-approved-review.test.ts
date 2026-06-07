import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runApplyApprovedReview } from "../src/apply-approved-review.js";

describe("runApplyApprovedReview", () => {
  let rootDir: string;
  let sourceDir: string;
  let reportDir: string;
  let backupDir: string;
  let approvedJsonPath: string;

  const mockApprovedArtifacts = [
    {
      artifactId: "draft_classification_A",
      status: "approved",
      sourceNoteIds: ["obs-A"],
      classification: "sensory",
      previousClassification: "observation",
      ollamaClassification: "sensory",
    },
    {
      artifactId: "draft_classification_B",
      status: "approved",
      sourceNoteIds: ["obs-B"],
      classification: "observation",
      previousClassification: "observation",
      ollamaClassification: "observation",
    },
    {
      artifactId: "draft_classification_C",
      status: "rejected",
      sourceNoteIds: ["obs-C"],
      classification: "behavior",
      previousClassification: "observation",
      ollamaClassification: "behavior",
    },
  ];

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "apply-review-test-"));
    sourceDir = join(rootDir, "source");
    reportDir = join(rootDir, "reports");
    backupDir = join(rootDir, "backups");
    await mkdir(sourceDir);
    await mkdir(reportDir);

    approvedJsonPath = join(rootDir, "approved_artifacts.json");
    await writeFile(approvedJsonPath, JSON.stringify(mockApprovedArtifacts), "utf8");

    // Write mock source files
    await writeFile(
      join(sourceDir, "obs-A.md"),
      `---
noteId: obs-A
type: observation
date: 2026-05-11
---
# Title A
Note content A
`,
      "utf8"
    );

    await writeFile(
      join(sourceDir, "obs-B.md"),
      `---
noteId: obs-B
type: observation
date: 2026-05-12
---
# Title B
Note content B
`,
      "utf8"
    );

    await writeFile(
      join(sourceDir, "obs-C.md"),
      `---
noteId: obs-C
type: observation
date: 2026-05-13
---
# Title C
Note content C
`,
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("generates 4 reports but does not modify files in dry-run mode", async () => {
    let stdoutText = "";
    let stderrText = "";

    await runApplyApprovedReview(
      {
        approvedJson: approvedJsonPath,
        sourceDir,
        reportDir,
        apply: false,
        confirmReviewed: false,
      },
      (text) => {
        stdoutText += text;
      },
      (text) => {
        stderrText += text;
      }
    );

    expect(stdoutText).toContain("Dry-run reports written to");
    expect(stdoutText).toContain("Summary: 1 notes planned to change");
    expect(stderrText).toBe("");

    // Verify 4 report files are generated
    const reportFiles = await readdir(reportDir);
    expect(reportFiles).toContain("apply_plan.json");
    expect(reportFiles).toContain("apply_diff.md");
    expect(reportFiles).toContain("affected_notes.json");
    expect(reportFiles).toContain("skipped_items.json");

    // Verify content of apply_plan.json
    const planRaw = await readFile(join(reportDir, "apply_plan.json"), "utf8");
    const plan = JSON.parse(planRaw);
    expect(plan).toHaveLength(1);
    expect(plan[0].noteId).toBe("obs-A");
    expect(plan[0].currentType).toBe("observation");
    expect(plan[0].proposedType).toBe("sensory");

    // Verify content of skipped_items.json
    const skippedRaw = await readFile(join(reportDir, "skipped_items.json"), "utf8");
    const skipped = JSON.parse(skippedRaw);
    
    // obs-B: no_change
    const skipB = skipped.find((s: any) => s.noteId === "obs-B");
    expect(skipB).toBeDefined();
    expect(skipB.reason).toBe("no_change");

    // obs-C: status is rejected, so it should be not_approved
    const skipC = skipped.find((s: any) => s.noteId === "obs-C");
    expect(skipC).toBeDefined();
    expect(skipC.reason).toBe("not_approved");

    // Verify file A was NOT modified
    const fileA = await readFile(join(sourceDir, "obs-A.md"), "utf8");
    expect(fileA).toContain("type: observation");
  });

  it("updates type in frontmatter, creates backup, and writes reports in apply mode", async () => {
    let stdoutText = "";
    let stderrText = "";

    await runApplyApprovedReview(
      {
        approvedJson: approvedJsonPath,
        sourceDir,
        reportDir,
        apply: true,
        confirmReviewed: true,
        backupDir,
      },
      (text) => {
        stdoutText += text;
      },
      (text) => {
        stderrText += text;
      }
    );

    expect(stdoutText).toContain("Backup complete");
    expect(stdoutText).toContain("[APPLIED] Updated type to \"sensory\" in obs-A.md");
    expect(stderrText).toBe("");

    // Verify backup files exist
    const backupFiles = await readdir(backupDir);
    expect(backupFiles).toContain("obs-A.md");
    expect(backupFiles).toContain("obs-B.md");
    expect(backupFiles).toContain("obs-C.md");

    // Verify backup content is original
    const backupA = await readFile(join(backupDir, "obs-A.md"), "utf8");
    expect(backupA).toContain("type: observation");

    // Verify source file A WAS modified
    const fileA = await readFile(join(sourceDir, "obs-A.md"), "utf8");
    expect(fileA).toContain("type: sensory");
    expect(fileA).toContain("Note content A"); // check body remains unchanged

    // Verify source file B was NOT modified
    const fileB = await readFile(join(sourceDir, "obs-B.md"), "utf8");
    expect(fileB).toContain("type: observation");

    // Verify 4 report files are also generated in apply mode
    const reportFiles = await readdir(reportDir);
    expect(reportFiles).toContain("apply_plan.json");
    expect(reportFiles).toContain("apply_diff.md");
    expect(reportFiles).toContain("affected_notes.json");
    expect(reportFiles).toContain("skipped_items.json");
  });

  it("throws error if flags are mismatched or backup-dir is missing when applying", async () => {
    // 1. Mismatched: apply: true, confirmReviewed: false
    await expect(
      runApplyApprovedReview(
        {
          approvedJson: approvedJsonPath,
          sourceDir,
          reportDir,
          apply: true,
          confirmReviewed: false,
          backupDir,
        },
        () => {},
        () => {}
      )
    ).rejects.toThrow("Both --apply and --confirm-reviewed flags must be provided to apply changes.");

    // 2. Mismatched: apply: false, confirmReviewed: true
    await expect(
      runApplyApprovedReview(
        {
          approvedJson: approvedJsonPath,
          sourceDir,
          reportDir,
          apply: false,
          confirmReviewed: true,
          backupDir,
        },
        () => {},
        () => {}
      )
    ).rejects.toThrow("Both --apply and --confirm-reviewed flags must be provided to apply changes.");

    // 3. Missing backupDir when applying
    await expect(
      runApplyApprovedReview(
        {
          approvedJson: approvedJsonPath,
          sourceDir,
          reportDir,
          apply: true,
          confirmReviewed: true,
        },
        () => {},
        () => {}
      )
    ).rejects.toThrow("--backup-dir <path> is required when applying changes.");
  });

  it("logs warnings to stderr for missing files and includes them in skipped_items.json", async () => {
    // Delete file A
    await rm(join(sourceDir, "obs-A.md"));

    let stdoutText = "";
    let stderrText = "";

    await runApplyApprovedReview(
      {
        approvedJson: approvedJsonPath,
        sourceDir,
        reportDir,
        apply: false,
        confirmReviewed: false,
      },
      (text) => {
        stdoutText += text;
      },
      (text) => {
        stderrText += text;
      }
    );

    // Verify obs-A.md is logged in skipped_items.json as file_missing
    const skippedRaw = await readFile(join(reportDir, "skipped_items.json"), "utf8");
    const skipped = JSON.parse(skippedRaw);
    const skipA = skipped.find((s: any) => s.noteId === "obs-A");
    expect(skipA).toBeDefined();
    expect(skipA.reason).toBe("file_missing");
  });
});
