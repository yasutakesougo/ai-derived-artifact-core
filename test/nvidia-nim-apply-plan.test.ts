import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-apply-plan-"));
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

describe("NVIDIA NIM review apply-plan helpers", () => {
  it("parses positional input path and optional --out", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyPlanArgs } from './scripts/ai/nvidia-nim-apply-plan.mjs';
        const parsed = parseApplyPlanArgs(['--out', 'apply-plan.md', 'reviews.jsonl'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "reviews.jsonl"),
      outputPath: resolve(root, "apply-plan.md"),
    });
  });

  it("writes apply plan containing only approved items to stdout", async () => {
    const inputPath = join(root, "reviews.jsonl");
    await writeFile(
      inputPath,
      [
        JSON.stringify({
          file: "artifact-a.md",
          artifactId: "a",
          success: true,
          decision: "approve",
          suggestedTitle: "Useful Artifact",
          labels: ["label-a", "label-b"],
          reason: "Looks complete",
          confidence: "high",
        }),
        JSON.stringify({
          file: "artifact-b.md",
          success: true,
          decision: "needs_review",
          suggestedTitle: "Need check",
          labels: ["risk"],
          reason: "Needs policy review",
        }),
        JSON.stringify({
          file: "artifact-c.md",
          success: true,
          decision: "approve",
          suggestedTitle: "",
          labels: [],
          reason: "Clean",
          confidence: "medium",
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-plan.mjs", inputPath],
      { cwd: process.cwd() },
    );

    const output = result.stdout;
    expect(output).toContain("--- NVIDIA NIM review apply plan ---");
    expect(output).toContain("Total: 3");
    expect(output).toContain("Approved: 2");
    expect(output).toContain("Failed: 0");
    expect(output).toContain("- a");
    expect(output).toContain("path: artifact-a.md");
    expect(output).toContain("suggestedTitle: Useful Artifact");
    expect(output).toContain("labels: label-a, label-b");
    expect(output).toContain("- artifact-c.md");
    expect(output).not.toContain("Need policy review");
  });

  it("writes markdown plan to --out and returns non-zero when parse failures exist", async () => {
    const inputPath = join(root, "reviews.jsonl");
    const outputPath = join(root, "apply-plan.md");
    await writeFile(
      inputPath,
      [
        JSON.stringify({
          file: "artifact-a.md",
          artifactId: "a",
          success: true,
          decision: "approve",
          suggestedTitle: "Useful Artifact",
          labels: ["label-a"],
          reason: "Looks complete",
        }),
        "{broken-json",
      ].join("\n"),
      "utf8",
    );

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-plan.mjs", "--out", outputPath, inputPath],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Apply plan written:");
    expect(output).toContain("line 2");
    expect(await readFile(outputPath, "utf8")).toContain("# NVIDIA NIM Review Apply Plan");
    expect(await readFile(outputPath, "utf8")).toContain("| a | artifact-a.md | Useful Artifact | label-a | Looks complete |");
    expect(await readFile(outputPath, "utf8")).toContain("line 2");
  });

  it("uses fixture JSONL and verifies apply-plan output snapshot", async () => {
    const fixtureInput = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-plan.jsonl");
    const expectedMarkdown = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-plan.expected.md");
    const outputPath = join(root, "apply-plan.md");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-plan.mjs", "--out", outputPath, fixtureInput],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    const outputText = await readFile(outputPath, "utf8");
    const expectedText = await readFile(expectedMarkdown, "utf8");
    const normalizedOutput = outputText.replace(`Input: ${fixtureInput}`, "Input: INPUT_PATH_PLACEHOLDER");

    expect(exitCode).toBe(1);
    expect(output).toContain("Apply plan written:");
    expect(output).toContain("Total: 8");
    expect(output).toContain("Approved: 4");
    expect(output).toContain("Failed: 2");
    expect(output).toContain("- artifact-a");
    expect(output).toContain("  path: fixture-a.md");
    expect(output).not.toContain("artifact-b");
    expect(output).not.toContain("artifact-f");
    expect(output).not.toContain("Needs manual check");
    expect(output).toContain("Failed lines:");
    expect(output).toContain("line 5");
    expect(output).toContain("line 7");
    expect(normalizedOutput.trim()).toBe(expectedText.trim());
  });
});
