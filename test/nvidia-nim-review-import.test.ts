import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-import-"));
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

describe("NVIDIA NIM review import helpers", () => {
  it("parses --only and positional input path", async () => {
    const parsed = JSON.parse(
      await runNodeModule(`
        import { parseReviewImportArgs } from './scripts/ai/nvidia-nim-review-import.mjs';
        const parsed = parseReviewImportArgs(['--only', 'needs_review', 'reviews.jsonl'], ${JSON.stringify(root)});
        process.stdout.write(JSON.stringify(parsed));
      `),
    );

    expect(parsed).toEqual({
      inputPath: resolve(root, "reviews.jsonl"),
      only: "needs_review",
    });
  });

  it("parses JSONL and classifies bad lines as failures", async () => {
    const text = JSON.stringify({
      success: true,
      decision: "approve",
      file: "a.md",
      confidence: "high",
    }) +
      "\n" +
      "{invalid-json}\n" +
      JSON.stringify({ success: false, file: "b.md", error: "timeout" });

    const result = JSON.parse(
      await runNodeModule(`
        import { parseReviewImportJsonl, summarizeReviewImport } from './scripts/ai/nvidia-nim-review-import.mjs';
        const parsed = JSON.parse(${JSON.stringify(text)});
        const { records, failures } = parseReviewImportJsonl(parsed);
        const summary = summarizeReviewImport(records);
        process.stdout.write(JSON.stringify({ failures, summary, records }));
      `),
    );

    expect(result.failures).toBe(1);
    expect(result.summary.total).toBe(3);
    expect(result.summary.failed).toBe(2);
    expect(result.summary.approved).toBe(1);
    expect(result.records[0].success).toBe(true);
    expect(result.records[1].success).toBe(false);
    expect(result.records[2].success).toBe(false);
  });

  it("filters needs_review records with --only and exits non-zero when malformed JSON exists", async () => {
    const importPath = join(root, "reviews.jsonl");
    await writeFile(
      importPath,
      [
        JSON.stringify({
          file: "a.md",
          success: true,
          decision: "approve",
          confidence: "medium",
        }),
        JSON.stringify({
          file: "b.md",
          success: true,
          decision: "needs_review",
          confidence: "high",
        }),
        "{broken}",
      ].join("\n"),
      "utf8",
    );

    let output = "";
    try {
      await execFileAsync(
        "node",
        ["scripts/ai/nvidia-nim-review-import.mjs", "--only", "needs_review", importPath],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
    }

    expect(output).toContain('--- Filtered (needs_review) ---');
    expect(output).toContain('"file":"b.md"');
    expect(output).toContain('Failed: 2');
  });
});
