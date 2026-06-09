import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-apply-approved-validate-"));
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

describe("NVIDIA NIM review apply approved plan validate", () => {
  it("parses positional input path", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyApprovedValidateArgs } from './scripts/ai/nvidia-nim-apply-approved-validate.mjs';
        const parsed = parseApplyApprovedValidateArgs(['apply-approved-plan.json'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "apply-approved-plan.json"),
    });
  });

  it("validates fixture plan payload successfully", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-plan.expected.json");
    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-validate.mjs", inputPath],
      { cwd: process.cwd() },
    );

    const output = result.stdout;

    expect(output).toContain("Validation passed: NVIDIA NIM apply-approved-dry-run plan is valid for apply-approved-review receiver.");
    expect(output).toContain("schemaVersion: nvidia-nim-apply-approved-dry-run/1.0");
    expect(output).toContain("summary.total: 8");
    expect(output).toContain("summary.approved: 4");
    expect(output).toContain("summary.warnings: 2");
    expect(output).toContain("items: 4");
    expect(output).toContain("warnings: 2");
  });

  it("fails for invalid schemaVersion", async () => {
    const inputPath = join(root, "invalid-schema.json");
    const payload = {
      schemaVersion: "other-version",
      generatedAt: "2026-06-01T00:00:00.000Z",
      inputPath: "/tmp/x",
      summary: { total: 1, approved: 1, warnings: 0 },
      items: [],
      warnings: [],
    };

    await writeFile(inputPath, JSON.stringify(payload), "utf8");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-validate.mjs", inputPath],
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

  it("fails when required item fields are missing", async () => {
    const inputPath = join(root, "invalid-item.json");
    const payload = {
      schemaVersion: "nvidia-nim-apply-approved-dry-run/1.0",
      generatedAt: "2026-06-01T00:00:00.000Z",
      inputPath: "/tmp/x",
      summary: { total: 1, approved: 1, warnings: 0 },
      items: [{ artifactId: "a", path: "a.md", labels: [], reason: "x" }],
      warnings: [],
    };

    await writeFile(inputPath, JSON.stringify(payload), "utf8");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-validate.mjs", inputPath],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("suggestedTitle must be string");
  });

  it("fails for invalid JSON payload", async () => {
    const invalidInput = join(root, "invalid.json");
    await writeFile(invalidInput, "{ invalid json", "utf8");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-validate.mjs", invalidInput],
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
