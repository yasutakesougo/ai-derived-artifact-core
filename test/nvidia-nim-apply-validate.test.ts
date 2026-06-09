import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-apply-validate-"));
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

describe("NVIDIA NIM review apply validate", () => {
  it("parses positional input path", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseApplyValidateArgs } from './scripts/ai/nvidia-nim-apply-validate.mjs';
        const parsed = parseApplyValidateArgs(['apply-dry-run.json'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "apply-dry-run.json"),
    });
  });

  it("validates a fixture dry-run JSON payload successfully", async () => {
    const inputPath = resolve(import.meta.dirname, "fixtures", "nvidia-nim", "reviews-apply-dry-run.expected.json");

    const check = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-validate.mjs", inputPath],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const output = check.stdout;

    expect(typeof output).toBe("string");
    expect(output).toContain("Validation passed:");
    expect(output).toContain("schemaVersion: nvidia-nim-apply-dry-run/1.0");
    expect(output).toContain("summary.approved: 4");
  });

  it("fails for invalid JSON", async () => {
    const invalidInput = join(root, "invalid-json.json");
    await writeFile(invalidInput, "{ this is not valid json }");

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-validate.mjs", invalidInput],
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

  it("fails for schemaVersion mismatch", async () => {
    const invalidInput = join(root, "invalid-schema.json");
    await writeFile(
      invalidInput,
      JSON.stringify({
        schemaVersion: "other-version",
        inputPath: "/tmp/x",
        summary: { total: 1, approved: 1, failed: 0 },
        items: [],
        failed: [],
      }),
      "utf8",
    );

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-validate.mjs", invalidInput],
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

  it("fails for missing required item fields", async () => {
    const invalidInput = join(root, "invalid-item.json");
    await writeFile(
      invalidInput,
      JSON.stringify({
        schemaVersion: "nvidia-nim-apply-dry-run/1.0",
        inputPath: "/tmp/x",
        summary: { total: 1, approved: 1, failed: 0 },
        items: [{ artifactId: "a", path: "a.md", reason: "x", labels: ["t"] }],
        failed: [],
      }),
      "utf8",
    );

    let output = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-validate.mjs", invalidInput],
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
});
