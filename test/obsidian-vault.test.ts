import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hashSourceBody,
  parseObsidianMarkdown,
  scanObsidianVault,
} from "../src/index.js";

let root: string;
let vault: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "obsidian-vault-"));
  vault = join(root, "Vault");
  await mkdir(join(vault, "source"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Obsidian Vault source reader", () => {
  it("reads Markdown only from the configured source folder", async () => {
    await writeMarkdown(
      join(vault, "source", "included.md"),
      "note_A",
      "Included body\n",
    );
    await mkdir(join(vault, "other"), { recursive: true });
    await writeMarkdown(
      join(vault, "other", "excluded.md"),
      "note_B",
      "Excluded body\n",
    );
    await writeFile(join(vault, "source", "ignored.txt"), "ignored", "utf8");

    const report = await scanObsidianVault(vault);

    expect(report.scannedMarkdownFiles).toBe(1);
    expect(report.candidates.map((item) => item.relativePath)).toEqual([
      "source/included.md",
    ]);
    expect(report.candidates[0]?.noteId).toBe("note_A");
  });

  it("supports a safe custom source folder", async () => {
    await mkdir(join(vault, "04_Observations", "child"), {
      recursive: true,
    });
    await writeMarkdown(
      join(vault, "04_Observations", "child", "note.md"),
      "note_child",
      "Observation\n",
    );

    const report = await scanObsidianVault(vault, {
      sourceFolder: "04_Observations",
    });

    expect(report.sourceFolder).toBe("04_Observations");
    expect(report.candidates[0]?.relativePath).toBe(
      "04_Observations/child/note.md",
    );
  });

  it("reports a missing noteId without generating or writing one", async () => {
    const path = join(vault, "source", "missing.md");
    await writeFile(path, "---\ntype: observation\n---\nBody\n", "utf8");
    const before = await snapshot(vault);

    const report = await scanObsidianVault(vault);

    expect(report.candidates[0]).toMatchObject({
      relativePath: "source/missing.md",
      status: "missing_note_id",
    });
    expect(report.candidates[0]).not.toHaveProperty("noteId");
    expect(await snapshot(vault)).toEqual(before);
  });

  it("hashes the body while excluding all frontmatter including AI fields", async () => {
    const first = parseObsidianMarkdown(
      "---\nnoteId: note_A\naiSummary: first\n---\nSame body\r\n",
    );
    const second = parseObsidianMarkdown(
      "---\nnoteId: note_A\naiSummary: changed\nconfidence: 0.9\n---\nSame body\n",
    );

    expect(hashSourceBody(first.body)).toBe(hashSourceBody(second.body));
    expect(first.frontmatter.aiSummary).toBe("first");
    expect(second.frontmatter.aiSummary).toBe("changed");
  });

  it("normalizes CRLF and LF before calculating SHA-256", () => {
    expect(hashSourceBody("line 1\r\nline 2\r\n")).toBe(
      hashSourceBody("line 1\nline 2\n"),
    );
    expect(hashSourceBody("line 1\nline 2\n")).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("parses YAML frontmatter as structured data", () => {
    const parsed = parseObsidianMarkdown(
      "---\nnoteId: note_A\ntags:\n  - child\n  - observation\n---\nBody\n",
    );

    expect(parsed.frontmatter).toEqual({
      noteId: "note_A",
      tags: ["child", "observation"],
    });
    expect(parsed.body).toBe("Body\n");
  });

  it("rejects traversal and absolute source-folder configuration", async () => {
    await expect(
      scanObsidianVault(vault, { sourceFolder: "../outside" }),
    ).rejects.toThrow("safe Vault-relative");
    await expect(
      scanObsidianVault(vault, { sourceFolder: join(root, "outside") }),
    ).rejects.toThrow("safe Vault-relative");
  });

  it("does not follow symlinks out of the Vault", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeMarkdown(join(outside, "secret.md"), "note_secret", "Secret\n");
    await symlink(outside, join(vault, "source", "linked-outside"));

    const report = await scanObsidianVault(vault);

    expect(report.scannedMarkdownFiles).toBe(0);
    expect((await lstat(join(vault, "source", "linked-outside"))).isSymbolicLink())
      .toBe(true);
  });

  it("performs a read-only scan without changing content or timestamps", async () => {
    await writeMarkdown(
      join(vault, "source", "note.md"),
      "note_A",
      "Observed body\n",
    );
    const before = await snapshot(vault);

    await scanObsidianVault(vault);

    expect(await snapshot(vault)).toEqual(before);
  });

  it("rejects invalid noteId values from frontmatter", async () => {
    await writeFile(
      join(vault, "source", "invalid.md"),
      "---\nnoteId: ../escape\n---\nBody\n",
      "utf8",
    );

    await expect(scanObsidianVault(vault)).rejects.toThrow("Invalid noteId");
  });

  it("scopes a Pilot scan by filename prefix and enforces batch size", async () => {
    for (const name of ["pilot1-a.md", "pilot1-b.md", "pilot1-c.md"]) {
      await writeMarkdown(
        join(vault, "source", name),
        name.replace(".md", ""),
        "Pilot body\n",
      );
    }
    await writeMarkdown(
      join(vault, "source", "drill-ignore.md"),
      "drill-ignore",
      "Drill body\n",
    );

    const report = await scanObsidianVault(vault, {
      includePrefix: "pilot1-",
      minFiles: 3,
      maxFiles: 5,
    });

    expect(report.scannedMarkdownFiles).toBe(3);
    expect(report.candidates.map((candidate) => candidate.relativePath)).toEqual([
      "source/pilot1-a.md",
      "source/pilot1-b.md",
      "source/pilot1-c.md",
    ]);

    await expect(
      scanObsidianVault(vault, {
        includePrefix: "missing-",
        minFiles: 3,
        maxFiles: 5,
      }),
    ).rejects.toThrow("minimum is 3");
  });
});

async function writeMarkdown(
  path: string,
  noteId: string,
  body: string,
): Promise<void> {
  await writeFile(path, `---\nnoteId: ${noteId}\n---\n${body}`, "utf8");
}

async function snapshot(
  directory: string,
): Promise<Record<string, { content?: string; mtimeMs: number; type: string }>> {
  const result: Record<
    string,
    { content?: string; mtimeMs: number; type: string }
  > = {};
  await walk(directory, directory, result);
  return result;
}

async function walk(
  rootDirectory: string,
  currentDirectory: string,
  result: Record<
    string,
    { content?: string; mtimeMs: number; type: string }
  >,
): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(currentDirectory, entry.name);
    const relative = absolute.slice(rootDirectory.length + 1);
    const metadata = await stat(absolute);
    if (entry.isDirectory()) {
      result[relative] = { mtimeMs: metadata.mtimeMs, type: "directory" };
      await walk(rootDirectory, absolute, result);
    } else {
      result[relative] = {
        content: await readFile(absolute, "utf8"),
        mtimeMs: metadata.mtimeMs,
        type: "file",
      };
    }
  }
}
