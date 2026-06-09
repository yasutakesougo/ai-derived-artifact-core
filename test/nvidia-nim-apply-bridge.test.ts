import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-apply-bridge-"));
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

describe("NVIDIA NIM review apply bridge", () => {
  it("parses --json and optional --out", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyBridgeArgs } from './scripts/ai/nvidia-nim-apply-bridge.mjs';
        const parsed = parseApplyBridgeArgs(['--json', '--out', 'payload.json', 'reviews.jsonl'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "reviews.jsonl"),
      outputPath: resolve(root, "payload.json"),
      outputJson: true,
    });
  });

  it("writes JSON payload from fixture and excludes non-approved entries", async () => {
    const fixtureInput = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-plan.jsonl");
    const expectedPayload = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-bridge.expected.json");
    const outputPath = join(root, "payload.json");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-bridge.mjs", "--json", "--out", outputPath, fixtureInput],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    const jsonText = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(jsonText);
    const expected = JSON.parse(await readFile(expectedPayload, "utf8"));
    const normalized = {
      ...parsed,
      inputPath: "INPUT_PATH_PLACEHOLDER",
    };

    expect(exitCode).toBe(1);
    expect(output).toContain("Apply bridge payload written:");
    expect(parsed).toHaveProperty("summary.approved", 4);
    expect(parsed).toHaveProperty("summary.failed", 2);
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items.map((item: { artifactId: string }) => item.artifactId)).toContain("artifact-a");
    expect(parsed.items.map((item: { artifactId: string }) => item.artifactId)).not.toContain("artifact-b");
    expect(parsed.items.map((item: { artifactId: string }) => item.artifactId)).not.toContain("artifact-f");
    expect(normalized).toEqual(expected);
  });

  it("writes markdown payload when --out is set without --json", async () => {
    const fixtureInput = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-plan.jsonl");
    const expectedMarkdown = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-bridge.expected.md");
    const outputPath = join(root, "apply-bridge.md");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-bridge.mjs", "--out", outputPath, fixtureInput],
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
    expect(output).toContain("Apply bridge payload written:");
    expect(normalizedOutput.trim()).toBe(expectedText.trim());
  });
});
