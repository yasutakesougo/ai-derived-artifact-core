import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPromotionGate } from "../src/promote-gate.js";

describe("runPromotionGate", () => {
  let rootDir: string;
  let standardizedDir: string;
  let sourceDir: string;
  let logDir: string;
  let rejectedDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "promote-gate-test-"));
    standardizedDir = join(rootDir, "import-standardized");
    sourceDir = join(rootDir, "source");
    logDir = join(rootDir, "import-logs");
    rejectedDir = join(rootDir, "import-rejected");

    await mkdir(standardizedDir);
    await mkdir(sourceDir);
    await mkdir(logDir);
    await mkdir(rejectedDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("handles dry-run promotion gate correctly and outputs reports without file side-effects", async () => {
    // 1. Normal promoted note
    await writeFile(
      join(standardizedDir, "sample-promoted.md"),
      `---
importId: imp-an-001
sourceSystem: apple-notes
sourcePath: file:///notes/101
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: promoted
promotionReason: Initial standard state
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
# Normal Observation Note
This note is long enough to pass the criteria. It has more than fifty characters.
`,
      "utf8"
    );

    // 2. Short note (rejected due to length < 20)
    await writeFile(
      join(standardizedDir, "sample-too-short.md"),
      `---
importId: imp-an-002
sourceSystem: apple-notes
sourcePath: file:///notes/102
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: promoted
promotionReason: Too short
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
Short.
`,
      "utf8"
    );

    // 3. Border length note (needs_review due to length 20-49)
    await writeFile(
      join(standardizedDir, "sample-border-length.md"),
      `---
importId: imp-an-003
sourceSystem: apple-notes
sourcePath: file:///notes/103
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: promoted
promotionReason: Border length
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
This note is between twenty and forty-nine chars.
`,
      "utf8"
    );

    let stdoutText = "";
    let stderrText = "";

    await runPromotionGate(
      {
        standardizedDir,
        sourceDir,
        logDir,
        rejectedDir,
        apply: false,
        confirmPromotion: false,
      },
      (text) => {
        stdoutText += text;
      },
      (text) => {
        stderrText += text;
      }
    );

    expect(stdoutText).toContain("Promotion Gate Dry-run reports written to");
    expect(stdoutText).toContain("Summary: 1 promoted, 1 needs_review, 1 rejected, 0 skipped.");
    expect(stderrText).toBe("");

    // Verify dry-run output reports
    const reportFiles = await readdir(logDir);
    expect(reportFiles).toContain("promotion_plan.json");
    expect(reportFiles).toContain("promotion_diff.md");
    expect(reportFiles).toContain("promotion_skipped.json");
    expect(reportFiles).toContain("promotion_summary.json");

    // Verify plan
    const planRaw = await readFile(join(logDir, "promotion_plan.json"), "utf8");
    const plan = JSON.parse(planRaw);
    expect(plan).toHaveLength(1);
    expect(plan[0].fileName).toBe("sample-promoted.md");
    expect(plan[0].importId).toBe("imp-an-001");

    // Verify summary
    const summaryRaw = await readFile(join(logDir, "promotion_summary.json"), "utf8");
    const summary = JSON.parse(summaryRaw);
    expect(summary.promoted).toBe(1);
    expect(summary.needsReview).toBe(1);
    expect(summary.rejected).toBe(1);

    // Verify no files are copied/moved yet
    const sourceFiles = await readdir(sourceDir);
    expect(sourceFiles).toHaveLength(0);
    const rejectedFiles = await readdir(rejectedDir);
    expect(rejectedFiles).toHaveLength(0);
    const standardizedFiles = await readdir(standardizedDir);
    expect(standardizedFiles).toHaveLength(3);
  });

  it("downgrades containsPersonalInfo='false' to needs_review if PII regex matches", async () => {
    // Normal promoted note BUT contains phone number in body
    await writeFile(
      join(standardizedDir, "sample-pii-phone.md"),
      `---
importId: imp-an-004
sourceSystem: apple-notes
sourcePath: file:///notes/104
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: promoted
promotionReason: Standard setting
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
# Normal Observation
Staff should contact the supervisor at 090-1234-5678 immediately if there is any issue.
This note is long enough.
`,
      "utf8"
    );

    let stdoutText = "";
    await runPromotionGate(
      {
        standardizedDir,
        sourceDir,
        logDir,
        rejectedDir,
        apply: false,
        confirmPromotion: false,
      },
      (text) => { stdoutText += text; },
      () => {}
    );

    // It should be classified as needs_review, not promoted
    expect(stdoutText).toContain("Summary: 0 promoted, 1 needs_review, 0 rejected, 0 skipped.");
  });

  it("detects and flags duplicates (duplicate filenames & duplicate importIds)", async () => {
    // 1. Promoted note
    await writeFile(
      join(standardizedDir, "sample-dup.md"),
      `---
importId: imp-an-005
sourceSystem: apple-notes
sourcePath: file:///notes/105
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: promoted
promotionReason: Standard
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
# Duplication Test Note A
This is a standard observation note that has plenty of length to be promoted.
`,
      "utf8"
    );

    // 2. Note with duplicate importId but different name
    await writeFile(
      join(standardizedDir, "sample-dup-diff-name.md"),
      `---
importId: imp-an-005
sourceSystem: apple-notes
sourcePath: file:///notes/105-different
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: promoted
promotionReason: Duplicate ID
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
# Duplication Test Note B
This note has a duplicate importId. It should be skipped due to duplicate_import_id.
`,
      "utf8"
    );

    // 3. Write a mock file in sourceDir that has imp-an-existing as importId
    await writeFile(
      join(sourceDir, "existing-note.md"),
      `---
importId: imp-an-existing
type: observation
---
`,
      "utf8"
    );

    // 4. Note that duplicates the existing note's importId
    await writeFile(
      join(standardizedDir, "sample-dup-existing-id.md"),
      `---
importId: imp-an-existing
sourceSystem: apple-notes
sourcePath: file:///notes/106
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: promoted
promotionReason: Duplicate existing ID
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
# Duplication Test Note C
This note duplicates an existing importId in sourceDir.
`,
      "utf8"
    );

    let stdoutText = "";
    await runPromotionGate(
      {
        standardizedDir,
        sourceDir,
        logDir,
        rejectedDir,
        apply: false,
        confirmPromotion: false,
      },
      (text) => { stdoutText += text; },
      () => {}
    );

    expect(stdoutText).toContain("Summary: 1 promoted, 0 needs_review, 0 rejected, 2 skipped.");

    const skippedRaw = await readFile(join(logDir, "promotion_skipped.json"), "utf8");
    const skipped = JSON.parse(skippedRaw);
    expect(skipped).toHaveLength(2);
    expect(skipped.map((s: any) => s.reason)).toContain("duplicate_import_id");
  });

  it("applies changes successfully and moves/copies files in apply mode", async () => {
    // 1. Promoted note
    await writeFile(
      join(standardizedDir, "sample-promoted.md"),
      `---
importId: imp-an-010
sourceSystem: apple-notes
sourcePath: file:///notes/110
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: promoted
promotionReason: Standard promoted note
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
# Normal Observation Note
This note is long enough to pass the criteria. It has more than fifty characters.
`,
      "utf8"
    );

    // 2. Rejected note
    await writeFile(
      join(standardizedDir, "sample-rejected.md"),
      `---
importId: imp-an-011
sourceSystem: apple-notes
sourcePath: file:///notes/111
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: rejected
promotionReason: Manually rejected standard note
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
This note is long enough, but is explicitly marked as rejected in frontmatter.
`,
      "utf8"
    );

    // 3. Needs review note
    await writeFile(
      join(standardizedDir, "sample-review.md"),
      `---
importId: imp-an-012
sourceSystem: apple-notes
sourcePath: file:///notes/112
importedAt: 2026-06-07T12:00:00Z
originalCreatedAt: 2026-06-05T12:00:00Z
originalUpdatedAt: 2026-06-06T12:00:00Z
promotionStatus: needs_review
promotionReason: Manually flagged
containsPersonalInfo: "false"
attachmentPolicy: strip
type: observation
---
This note is long enough, but is explicitly marked as needs_review in frontmatter.
`,
      "utf8"
    );

    let stdoutText = "";
    await runPromotionGate(
      {
        standardizedDir,
        sourceDir,
        logDir,
        rejectedDir,
        apply: true,
        confirmPromotion: true,
      },
      (text) => { stdoutText += text; },
      () => {}
    );

    expect(stdoutText).toContain("[PROMOTED] Copied sample-promoted.md");
    expect(stdoutText).toContain("[REJECTED/ISOLATED] Moved sample-rejected.md");
    expect(stdoutText).toContain("[HELD/REVIEW] Kept sample-review.md");

    // Verify sourceDir (should contain only sample-promoted.md)
    const sourceFiles = await readdir(sourceDir);
    expect(sourceFiles).toContain("sample-promoted.md");
    expect(sourceFiles).not.toContain("sample-rejected.md");
    expect(sourceFiles).not.toContain("sample-review.md");

    // Verify rejectedDir (should contain only sample-rejected.md)
    const rejectedFiles = await readdir(rejectedDir);
    expect(rejectedFiles).toContain("sample-rejected.md");
    expect(rejectedFiles).not.toContain("sample-promoted.md");

    // Verify standardizedDir (should contain only sample-review.md, others should be copied/moved)
    const standardizedFiles = await readdir(standardizedDir);
    expect(standardizedFiles).toContain("sample-review.md");
    expect(standardizedFiles).not.toContain("sample-rejected.md"); // moved
    expect(standardizedFiles).toContain("sample-promoted.md"); // only copied, not moved (needs to remain or can be deleted? Requirement says 'promoted ... is copied', so standard is to copy. Keeping is safe.)
  });

  it("throws error for mismatched or missing apply/confirm flags", async () => {
    await expect(
      runPromotionGate(
        {
          standardizedDir,
          sourceDir,
          logDir,
          rejectedDir,
          apply: true,
          confirmPromotion: false,
        },
        () => {},
        () => {}
      )
    ).rejects.toThrow("Both --apply and --confirm-promotion flags must be provided to apply changes.");

    await expect(
      runPromotionGate(
        {
          standardizedDir,
          sourceDir,
          logDir,
          rejectedDir,
          apply: false,
          confirmPromotion: true,
        },
        () => {},
        () => {}
      )
    ).rejects.toThrow("Both --apply and --confirm-promotion flags must be provided to apply changes.");
  });
});
