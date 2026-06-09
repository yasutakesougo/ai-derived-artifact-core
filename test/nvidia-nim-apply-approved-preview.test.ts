import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-apply-approved-preview-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runNodeModule(script: string): Promise<string> {
  const result = await execFileAsync("node", ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
  });
  return result.stdout;
}

describe("NVIDIA NIM review apply approved preview", () => {
  it("parses positional input path", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyApprovedPreviewArgs } from './scripts/ai/nvidia-nim-apply-approved-preview.mjs';
        const parsed = parseApplyApprovedPreviewArgs(['apply-approved-plan.json'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "apply-approved-plan.json"),
    });
  });

  it("loads fixture plan and prints apply preview", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-plan.expected.json");
    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-preview.mjs", inputPath],
      { cwd: process.cwd() },
    );

    const output = result.stdout;
    expect(output).toContain("Apply-approved preview:");
    expect(output).toContain("Total: 8");
    expect(output).toContain("Approved candidates: 4");
    expect(output).toContain("- artifact-a");
    expect(output).toContain("path: fixture-a.md");
    expect(output).toContain("labels: gold, high-confidence");
    expect(output).toContain("reason: Looks consistent with policy");
  });

  it("warns when warnings exist", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-plan.expected.json");

    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-preview.mjs", inputPath],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Warnings:");
    expect(output).toContain("[failed-row] line 7: Unterminated string in JSON at position 15");
  });

  it("reports no candidates and still shows warnings", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-plan-empty.expected.json");
    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-preview.mjs", inputPath],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Apply candidates:");
    expect(output).toContain("No apply candidates found.");
    expect(output).toContain("Warnings:");
    expect(output).toContain("[failed-row] line 3: No parseable approval candidates");
    expect(output).toContain("raw: line:3 -> skipped");
  });

  it("rejects --write option (preview only)", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-plan.expected.json");
    let output = "";
    let exitCode = 0;

    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-preview.mjs", "--write", inputPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Unknown option: --write");
    expect(output).toContain("Usage: npm run review:apply-approved-preview -- apply-approved-plan.json");
  });

  it("warns when approved count metadata does not match rendered items", async () => {
    const inputPath = join(root, "summary-mismatch.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        schemaVersion: "nvidia-nim-apply-approved-dry-run/1.0",
        generatedAt: "2026-06-01T00:00:00.000Z",
        inputPath: "/tmp/mismatch",
        summary: { total: 1, approved: 2, warnings: 0 },
        items: [{
          artifactId: "artifact-mismatch",
          path: "fixture-mismatch.md",
          suggestedTitle: "Mismatch",
          labels: ["gold"],
          reason: "count mismatch test",
        }],
        warnings: [],
      }),
      "utf8",
    );

    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-preview.mjs", inputPath],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Warning: summary.approved=2 does not match actual approved candidates 1.");
  });

  it("fails for invalid schema payload", async () => {
    const invalidInput = join(root, "invalid-plan.json");
    await writeFile(
      invalidInput,
      JSON.stringify({
        schemaVersion: "other",
        summary: { total: 1, approved: 1, warnings: 0 },
        generatedAt: "2026-06-01T00:00:00.000Z",
        inputPath: "/tmp/x",
        items: [],
        warnings: [],
      }),
      "utf8",
    );

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-preview.mjs", invalidInput],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Invalid schemaVersion");
  });
});
