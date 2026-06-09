import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-apply-dry-run-"));
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

describe("NVIDIA NIM review apply dry-run", () => {
  it("parses positional input path and optional output flags", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyDryRunArgs } from './scripts/ai/nvidia-nim-apply-dry-run.mjs';
        const parsed = parseApplyDryRunArgs(['--json', '--out', 'apply-plan.json', 'reviews.jsonl'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "reviews.jsonl"),
      outputPath: resolve(root, "apply-plan.json"),
      outputJson: true,
    });
  });

  it("writes apply dry-run JSON from bridge payload and keeps approved fields", async () => {
    const payloadInput = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-bridge.expected.json");
    const outputPath = join(root, "apply-dry-run.json");
    const expectedOutput = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-dry-run.expected.json");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-dry-run.mjs", "--json", "--out", outputPath, payloadInput],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    const outputText = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(outputText);
    const expected = JSON.parse(await readFile(expectedOutput, "utf8"));
    const normalized = {
      ...parsed,
      inputPath: "INPUT_PATH_PLACEHOLDER",
    };

    expect(exitCode).toBe(1);
    expect(output).toContain("Dry-run plan written:");
    expect(parsed.summary.approved).toBe(4);
    expect(parsed.summary.failed).toBe(2);
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items.map((item: { artifactId: string }) => item.artifactId)).toContain("artifact-a");
    expect(parsed.items.map((item: { artifactId: string }) => item.artifactId)).not.toContain("artifact-b");
    expect(parsed.items.map((item: { artifactId: string }) => item.artifactId)).not.toContain("artifact-f");
    expect(normalized).toEqual(expected);
  });

  it("writes markdown dry-run plan from reviews.jsonl and matches fixture snapshot", async () => {
    const jsonlInput = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-plan.jsonl");
    const outputPath = join(root, "apply-dry-run.md");
    const expectedMarkdown = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-dry-run.expected.md");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-dry-run.mjs", "--out", outputPath, jsonlInput],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    const outputText = await readFile(outputPath, "utf8");
    const expectedText = await readFile(expectedMarkdown, "utf8");
    const normalizedOutput = outputText.replace(`Input: ${jsonlInput}`, "Input: INPUT_PATH_PLACEHOLDER");

    expect(exitCode).toBe(1);
    expect(output).toContain("Dry-run plan written:");
    expect(normalizedOutput.trim()).toBe(expectedText.trim());
  });
});
