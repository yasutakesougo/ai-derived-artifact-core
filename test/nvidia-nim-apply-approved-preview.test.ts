import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
        const parsed = parseApplyApprovedPreviewArgs(['--allowlist', 'allow', '--out', 'write-output.md', '--expected-plan-hash', 'planhash', '--expected-input-path', 'input.json', '--expected-input-hash', 'inputhash', 'apply-approved-plan.json'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "apply-approved-plan.json"),
      outputPath: resolve(root, "write-output.md"),
      write: false,
      allowlist: [resolve(root, "allow")],
      expectedPlanHash: "planhash",
      expectedInputPath: resolve(root, "input.json"),
      expectedInputHash: "inputhash",
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

  it("writes preview write-plan when preflight passes", async () => {
    const sourcePath = join(root, "source-input.txt");
    const payloadPath = join(root, "payload.json");
    const outputPath = join(root, "apply-approved-preview.json");
    const expectedPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-preview.expected.json");

    await writeFile(sourcePath, "synthetic source text", "utf8");

    const sourceHash = createHash("sha256").update("synthetic source text", "utf8").digest("hex");
    await writeFile(
      payloadPath,
      JSON.stringify({
        schemaVersion: "nvidia-nim-apply-approved-dry-run/1.0",
        generatedAt: "2026-06-09T00:00:00.000Z",
        inputPath: "source-input.txt",
        summary: { total: 2, approved: 2, warnings: 0 },
        items: [
          {
            artifactId: "artifact-a",
            path: "fixture-a.md",
            suggestedTitle: "Alpha",
            labels: ["gold"],
            reason: "No warning synthetic",
          },
          {
            artifactId: "artifact-b",
            path: "fixture-b.md",
            suggestedTitle: "Beta",
            labels: ["safe"],
            reason: "No warning synthetic B",
          },
        ],
        warnings: [],
      }),
      "utf8",
    );

    const result = await execFileAsync(
      "node",
      [
        "scripts/ai/nvidia-nim-apply-approved-preview.mjs",
        "--write",
        "--allowlist",
        root,
        "--expected-input-path",
        sourcePath,
        "--expected-input-hash",
        sourceHash,
        "--out",
        outputPath,
        payloadPath,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.stdout).toContain("Apply-approved preview plan written:");
    const expected = JSON.parse(await readFile(expectedPath, "utf8"));
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    const normalized = {
      ...output,
      generatedAt: "GENERATED_AT_PLACEHOLDER",
      inputPath: "INPUT_PATH_PLACEHOLDER",
      outputPath: "OUTPUT_PATH_PLACEHOLDER",
    };
    expect(normalized).toEqual(expected);
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

  it("rejects --write when --allowlist is missing", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-plan.expected.json");
    let output = "";
    let exitCode = 0;

    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-preview.mjs", "--write", "--out", join(root, "out.md"), inputPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Missing required --allowlist for --write");
    expect(output).toContain("Usage: npm run review:apply-approved-preview -- [--write] [--out apply-approved-preview.json] [--allowlist PATH] [--expected-plan-hash HASH] [--expected-input-path PATH] [--expected-input-hash HASH] apply-approved-plan.json");
  });

  it("blocks write path when preflight fails", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-plan.expected.json");
    let output = "";
    let exitCode = 0;

    try {
      await execFileAsync(
        "node",
        [
          "scripts/ai/nvidia-nim-apply-approved-preview.mjs",
          "--write",
          "--allowlist",
          root,
          "--out",
          join(root, "write-fail.md"),
          inputPath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Write preflight failed:");
    expect(output).toContain("[WARNINGS_BLOCKED]");
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
