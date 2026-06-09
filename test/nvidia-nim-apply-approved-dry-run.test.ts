import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-apply-approved-dry-run-"));
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

describe("NVIDIA NIM review apply approved dry-run", () => {
  it("parses positional input path", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyApprovedDryRunArgs } from './scripts/ai/nvidia-nim-apply-approved-dry-run.mjs';
        const parsed = parseApplyApprovedDryRunArgs(['apply-dry-run.json'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "apply-dry-run.json"),
    });
  });

  it("loads fixture payload and prints dry-run plan candidates", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-dry-run.expected.json");
    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-dry-run.mjs", inputPath],
      { cwd: process.cwd() },
    );

    const output = result.stdout;
    expect(output).toContain("Apply approved-review dry-run plan:");
    expect(output).toContain("Input:");
    expect(output).toContain("Approved payload entries: 4");
    expect(output).toContain("Failed rows: 2");
    expect(output).toContain("- artifact-a");
    expect(output).toContain("path: fixture-a.md");
    expect(output).toContain("suggestedTitle: Artifact Alpha");
    expect(output).toContain("labels: gold, high-confidence");
    expect(output).toContain("reason: Looks consistent with policy");
    expect(output).toContain("- artifact-g");
    expect(output).toContain("reason: (none)");
  });

  it("warns when failed rows exist and exits non-fail", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-dry-run.expected.json");

    const child = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-dry-run.mjs", inputPath],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const output = `${child.stdout}\n${child.stderr}`;
    expect(output).toContain("Warning: 2 failed row(s) exist in dry-run payload.");
  });

  it("filters out non-approved entries when decision is present", async () => {
    const inputPath = join(root, "non-approve.json");
    const payload = {
      schemaVersion: "nvidia-nim-apply-dry-run/1.0",
      generatedAt: "2026-06-01T00:00:00.000Z",
      inputPath: "/tmp/fixture",
      summary: {
        total: 2,
        approved: 2,
        failed: 0,
      },
      items: [
        {
          artifactId: "artifact-a",
          path: "a.md",
          suggestedTitle: "A",
          labels: ["approve"],
          reason: "ready",
          decision: "approve",
        },
        {
          artifactId: "artifact-b",
          path: "b.md",
          suggestedTitle: "B",
          labels: ["skip"],
          reason: "no changes",
          decision: "reject",
        },
      ],
      failed: [],
    };

    await writeFile(inputPath, JSON.stringify(payload), "utf8");

    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-dry-run.mjs", inputPath],
      { cwd: process.cwd() },
    );

    expect(result.stdout).toContain("Approved payload entries: 1");
    expect(result.stdout).toContain("- artifact-a");
    expect(result.stdout).not.toContain("artifact-b");
  });

  it("fails for invalid JSON payload", async () => {
    const invalidInput = join(root, "invalid.json");
    await writeFile(invalidInput, "{ this is not valid json }", "utf8");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-dry-run.mjs", invalidInput],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Invalid JSON");
  });
});
