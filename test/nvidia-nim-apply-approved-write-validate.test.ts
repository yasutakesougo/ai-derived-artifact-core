import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-apply-approved-write-validate-"));
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

describe("NVIDIA NIM review apply-approved write payload validate", () => {
  it("parses positional input path", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyApprovedWriteValidateArgs } from './scripts/ai/nvidia-nim-apply-approved-write-validate.mjs';
        const parsed = parseApplyApprovedWriteValidateArgs(['preview-output.json'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "preview-output.json"),
    });
  });

  it("validates fixture write payload successfully", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-approved-preview.expected.json");
    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-write-validate.mjs", inputPath],
      { cwd: process.cwd() },
    );

    const output = result.stdout;

    expect(output).toContain("Validation passed: NVIDIA NIM apply-approved preview write payload is valid for write connector.");
    expect(output).toContain("schemaVersion: nvidia-nim-apply-approved-preview/1.0");
    expect(output).toContain("preflight.passed: true");
    expect(output).toContain("items: 2");
    expect(output).toContain("warnings: 0");
  });

  it("fails for invalid schemaVersion", async () => {
    const inputPath = join(root, "invalid-schema.json");
    const payload = {
      schemaVersion: "other-version",
      generatedAt: "2026-06-01T00:00:00.000Z",
      inputPath: "/tmp/x",
      outputPath: "/tmp/y",
      summary: { total: 1, approved: 1, warnings: 0 },
      items: [],
      warnings: [],
      preflight: {
        passed: true,
        failures: [],
      },
    };

    await writeFile(inputPath, JSON.stringify(payload), "utf8");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-write-validate.mjs", inputPath],
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

  it("fails when preflight is missing", async () => {
    const inputPath = join(root, "missing-preflight.json");
    const payload = {
      schemaVersion: "nvidia-nim-apply-approved-preview/1.0",
      generatedAt: "2026-06-01T00:00:00.000Z",
      inputPath: "/tmp/x",
      outputPath: "/tmp/y",
      summary: { total: 1, approved: 1, warnings: 0 },
      items: [
        {
          artifactId: "a",
          path: "a.md",
          suggestedTitle: "A",
          labels: ["x"],
          reason: "ok",
        },
      ],
      warnings: [],
    };

    await writeFile(inputPath, JSON.stringify(payload), "utf8");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-write-validate.mjs", inputPath],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("preflight must be an object");
  });

  it("fails for invalid JSON payload", async () => {
    const invalidInput = join(root, "invalid.json");
    await writeFile(invalidInput, "{ invalid json", "utf8");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-write-validate.mjs", invalidInput],
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
