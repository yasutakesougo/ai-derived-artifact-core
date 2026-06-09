import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-jsonl-"));
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

describe("NVIDIA NIM batch JSONL export helpers", () => {
  it("parses --out and keeps review files in argument order", async () => {
    const stdout = await runNodeModule(`
      import { parseBatchReviewArgs } from './scripts/ai/nvidia-nim-batch-jsonl.mjs';
      const parsed = parseBatchReviewArgs(['--out', 'reviews.jsonl', 'a.md', 'b.md'], ${JSON.stringify(root)});
      process.stdout.write(JSON.stringify(parsed));
    `);

    expect(JSON.parse(stdout)).toEqual({
      files: ["a.md", "b.md"],
      outPath: resolve(root, "reviews.jsonl"),
    });
  });

  it("formats success and failure results as one JSON object per line", async () => {
    const stdout = await runNodeModule(`
      import { formatBatchReviewJsonl } from './scripts/ai/nvidia-nim-batch-jsonl.mjs';
      const text = formatBatchReviewJsonl([
        { file: 'a.md', success: true, decision: 'approve', confidence: 'high' },
        { file: 'missing.md', success: false, error: 'ENOENT' }
      ]);
      process.stdout.write(text);
    `);

    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).success).toBe(true);
    expect(JSON.parse(lines[1]!).success).toBe(false);
  });

  it("writes failed reviews to JSONL while preserving stdout summary", async () => {
    const outPath = join(root, "reviews.jsonl");

    let stdout = "";
    try {
      await execFileAsync(
        "node",
        [
          "scripts/ai/nvidia-nim-review-batch.mjs",
          "--out",
          outPath,
          "test/fixtures/nvidia-nim/missing-artifact.md",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NVIDIA_API_KEY: "test-key",
            NVIDIA_MODEL: "test-model",
          },
        },
      );
    } catch (error) {
      stdout = (error as { stdout?: string }).stdout ?? "";
    }

    expect(stdout).toContain("--- Summary ---");
    expect(stdout).toContain("Failed: 1");
    expect(stdout).toContain("JSONL written:");

    const jsonl = await readFile(outPath, "utf8");
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.success).toBe(false);
    expect(record.file).toBe("test/fixtures/nvidia-nim/missing-artifact.md");
    expect(record.error).toContain("ENOENT");
  });
});
