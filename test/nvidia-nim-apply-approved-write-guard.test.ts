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

  it("rejects --write in apply-approved-preview command", async () => {
    const inputPath = fixturePath("reviews-apply-approved-plan.expected.json");
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
