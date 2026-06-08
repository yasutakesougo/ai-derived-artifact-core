import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function resolveWithHelper(filePath: string, cwd: string): Promise<string> {
  const script = `
    import { resolveReviewFilePath } from './scripts/ai/nvidia-nim-paths.mjs';
    process.stdout.write(resolveReviewFilePath(${JSON.stringify(filePath)}, ${JSON.stringify(cwd)}));
  `;
  const result = await execFileAsync("node", ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
  });
  return result.stdout;
}

describe("NVIDIA NIM review path handling", () => {
  it("resolves relative fixture paths from the current working directory", async () => {
    const relative = "test/fixtures/nvidia-nim/test-artifact-1.md";

    await expect(resolveWithHelper(relative, process.cwd())).resolves.toBe(
      resolve(process.cwd(), relative),
    );
  });

  it("preserves absolute file paths", async () => {
    const absolute = resolve(
      process.cwd(),
      "test/fixtures/nvidia-nim/test-artifact-2.md",
    );

    await expect(resolveWithHelper(absolute, process.cwd())).resolves.toBe(
      absolute,
    );
  });

  it("rejects empty review paths", async () => {
    const script = `
      import { resolveReviewFilePath } from './scripts/ai/nvidia-nim-paths.mjs';
      try {
        resolveReviewFilePath('', ${JSON.stringify(process.cwd())});
      } catch (error) {
        process.stdout.write(error.message);
      }
    `;
    const result = await execFileAsync("node", ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
    });

    expect(result.stdout).toContain("non-empty string");
  });
});
