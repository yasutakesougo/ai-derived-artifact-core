import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-report-"));
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

describe("NVIDIA NIM review report", () => {
  it("parses --out and positional input path", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseReportArgs } from './scripts/ai/nvidia-nim-report.mjs';
        const parsed = parseReportArgs(['--out', 'review-report.md', 'reviews.jsonl'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "reviews.jsonl"),
      outputPath: resolve(root, "review-report.md"),
    });
  });

  it("writes markdown report with summary and extracted targets", async () => {
    const inputPath = join(root, "reviews.jsonl");
    const outputPath = join(root, "review-report.md");
    await writeFile(
      inputPath,
      [
        JSON.stringify({
          file: "artifact-a.md",
          artifactId: "a",
          success: true,
          decision: "approve",
          reason: "clean",
        }),
        JSON.stringify({
          file: "notes/b.md",
          artifactId: "b",
          success: true,
          decision: "needs_review",
          reason: "Needs domain check",
        }),
        JSON.stringify({
          file: "notes/c.md",
          success: true,
          decision: "reject",
          reason: "Outdated content",
        }),
        "{broken-json",
      ].join("\n"),
      "utf8",
    );

    let output = "";
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-report.mjs", "--out", outputPath, inputPath],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
    }

    const report = await readFile(outputPath, "utf8");

    expect(report).toContain("# NVIDIA NIM Review Report");
    expect(report).toContain("- Total: 4");
    expect(report).toContain("- Approve: 1");
    expect(report).toContain("- Needs Review: 1");
    expect(report).toContain("- Reject: 1");
    expect(report).toContain("- Failed: 1");
    expect(report).toContain("## Failed lines");
    expect(report).toContain("line 4");
    expect(report).toContain("## Needs Review");
    expect(report).toContain("| b | notes/b.md | needs_review | Needs domain check |");
    expect(report).toContain("## Reject");
    expect(report).toContain("| c.md | notes/c.md | reject | Outdated content |");
    expect(output).toContain("Markdown report written:");
    expect(output).toContain("Failed: 1");
  });
});
