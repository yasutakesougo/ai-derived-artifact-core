import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function fixturePath(name: string) {
  return resolve(import.meta.dirname, "fixtures", "nvidia-nim", name);
}

describe("NVIDIA NIM review apply-approved write guard", () => {
  it("rejects --write in apply-approved-dry-run", async () => {
    const inputPath = fixturePath("reviews-apply-dry-run.expected.json");
    let output = "";
    let exitCode = 0;

    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-dry-run.mjs", "--write", inputPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Unknown option: --write");
    expect(output).toContain("Usage: npm run review:apply-approved-dry-run -- [--json] [--out apply-approved-plan.json] apply-dry-run.json");
  });

  it("rejects --write in apply-approved-validate", async () => {
    const inputPath = fixturePath("reviews-apply-approved-plan.expected.json");
    let output = "";
    let exitCode = 0;

    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-validate.mjs", "--write", inputPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Unknown option: --write");
    expect(output).toContain("Usage: npm run review:apply-approved-validate -- apply-approved-plan.json");
  });

  it("preview command now accepts --write for synthetic write output", async () => {
    const inputPath = fixturePath("reviews-apply-approved-plan.expected.json");
    let output = "";
    let exitCode = 0;

    try {
      await execFileAsync(
        "node",
        [
          "scripts/ai/nvidia-nim-apply-approved-preview.mjs",
          "--write",
          "--allowlist",
          process.cwd(),
          "--out",
          "preview-write.json",
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
    expect(output).not.toContain("Unknown option: --write");
  });

  it("validates write output via apply-approved-write-validate", async () => {
    const inputPath = fixturePath("reviews-apply-approved-preview.expected.json");
    const result = await execFileAsync(
      "node",
      ["scripts/ai/nvidia-nim-apply-approved-write-validate.mjs", inputPath],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    const output = result.stdout;
    expect(output).toContain("Validation passed: NVIDIA NIM apply-approved preview write payload is valid for write connector.");
    expect(output).toContain("schemaVersion: nvidia-nim-apply-approved-preview/1.0");
    expect(output).toContain("preflight.passed: true");
    expect(output).toContain("items: 2");
    expect(output).toContain("warnings: 0");
  });

  it("rejects --write in apply-approved-preflight command", async () => {
    const inputPath = fixturePath("reviews-apply-approved-plan.expected.json");
    let output = "";
    let exitCode = 0;

    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-apply-approved-preflight.mjs", "--write", inputPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    } catch (error) {
      output = (error as { stdout?: string; stderr?: string }).stdout ?? "";
      output += (error as { stdout?: string; stderr?: string }).stderr ?? "";
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Unknown option: --write");
    expect(output).toContain("Usage: npm run review:apply-approved-preflight -- [--allowlist PATH] [--expected-plan-hash HASH] [--expected-input-path PATH] [--expected-input-hash HASH] apply-approved-plan.json");
  });
});
