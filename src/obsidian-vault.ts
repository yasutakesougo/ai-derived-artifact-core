import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

export interface VaultSourceCandidate {
  relativePath: string;
  noteId?: string;
  sourceHash: string;
  body: string;
  frontmatter: Readonly<Record<string, unknown>>;
  status: "ready" | "missing_note_id";
}

export interface VaultScanReport {
  vaultPath: string;
  sourceFolder: string;
  scannedMarkdownFiles: number;
  candidates: readonly VaultSourceCandidate[];
}

export interface VaultScanOptions {
  sourceFolder?: string;
}

export async function scanObsidianVault(
  vaultPath: string,
  options: VaultScanOptions = {},
): Promise<VaultScanReport> {
  const sourceFolder = validateSourceFolder(options.sourceFolder ?? "source");
  const vaultRoot = await realpath(resolve(vaultPath));
  const sourceRoot = resolve(vaultRoot, sourceFolder);
  assertContained(vaultRoot, sourceRoot);

  const sourceStats = await lstat(sourceRoot);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error("Configured source folder must be a real directory");
  }
  const sourceRealPath = await realpath(sourceRoot);
  assertContained(vaultRoot, sourceRealPath);

  const markdownFiles = await collectMarkdownFiles(
    vaultRoot,
    sourceRealPath,
  );
  const candidates = await Promise.all(
    markdownFiles.map(async (absolutePath) => {
      const markdown = await readFile(absolutePath, "utf8");
      const parsed = parseObsidianMarkdown(markdown);
      const noteId = readNoteId(parsed.frontmatter);
      return {
        relativePath: toPortablePath(relative(vaultRoot, absolutePath)),
        ...(noteId ? { noteId } : {}),
        sourceHash: hashSourceBody(parsed.body),
        body: parsed.body,
        frontmatter: parsed.frontmatter,
        status: noteId ? "ready" : "missing_note_id",
      } satisfies VaultSourceCandidate;
    }),
  );

  return {
    vaultPath: vaultRoot,
    sourceFolder: toPortablePath(sourceFolder),
    scannedMarkdownFiles: markdownFiles.length,
    candidates: candidates.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    ),
  };
}

export function parseObsidianMarkdown(markdown: string): {
  frontmatter: Readonly<Record<string, unknown>>;
  body: string;
} {
  const normalized = normalizeLineEndings(markdown).replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    throw new Error("Unclosed YAML frontmatter");
  }

  const yamlText = normalized.slice(4, closingIndex);
  const parsed = parseYaml(yamlText);
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error("Frontmatter must be a YAML mapping");
  }
  return {
    frontmatter: (parsed ?? {}) as Record<string, unknown>,
    body: normalized.slice(closingIndex + 5),
  };
}

export function canonicalizeSourceBody(body: string): string {
  return normalizeLineEndings(body).replace(/^\uFEFF/, "");
}

export function hashSourceBody(body: string): string {
  const digest = createHash("sha256")
    .update(canonicalizeSourceBody(body), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function readNoteId(
  frontmatter: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = frontmatter.noteId;
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("frontmatter noteId must be a string");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid noteId: ${value}`);
  }
  return value;
}

function validateSourceFolder(folder: string): string {
  if (
    !folder ||
    isAbsolute(folder) ||
    folder.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new Error("Source folder must be a safe Vault-relative path");
  }
  return folder;
}

async function collectMarkdownFiles(
  vaultRoot: string,
  directory: string,
): Promise<string[]> {
  assertContained(vaultRoot, directory);
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    assertContained(vaultRoot, path);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(vaultRoot, path)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
}

function assertContained(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Path escapes the Vault root");
  }
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function toPortablePath(value: string): string {
  return value.split(sep).join("/");
}
