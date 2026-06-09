import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nim-aggregate-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("NVIDIA NIM review aggregate helpers", () => {
  it("parses positional input path", async () => {
    const jsonlPath = join(root, "reviews.jsonl");

    const parsed = JSON.parse(
      await execFileAsync("node", [
        "--input-type=module",
        "-e",
        `import { parseAggregateArgs } from './scripts/ai/nvidia-nim-aggregate.mjs';
        const parsed = parseAggregateArgs(['${jsonlPath}']);
        process.stdout.write(JSON.stringify(parsed));`,
      ], {
        cwd: process.cwd(),
      }).then((r) => r.stdout),
    );

    expect(parsed).toEqual({
      inputPath: resolve(jsonlPath),
    });
  });

  it("aggregates need-review and reject and reports failed lines", async () => {
    const importPath = join(root, "reviews.jsonl");
    await writeFile(
      importPath,
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
        ["scripts/ai/nvidia-nim-aggregate.mjs", importPath],
        { cwd: process.cwd() },
      );
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
    }

    expect(output).toContain('Total: 4');
    expect(output).toContain('Approve: 1');
    expect(output).toContain('Needs Review: 1');
    expect(output).toContain('Reject: 1');
    expect(output).toContain('Failed: 1');
    expect(output).toContain('Failed lines:');
    expect(output).toContain('line 4');
    expect(output).toContain('Needs Review:');
    expect(output).toContain('- b');
    expect(output).toContain('classification: needs_review');
    expect(output).toContain('reason: Needs domain check');
    expect(output).toContain('path: notes/c.md');
  });
});
