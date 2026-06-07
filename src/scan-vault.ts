import type { SourceNote } from "./types.js";
import { JsonAuditStore } from "./json-storage.js";
import { scanObsidianVault } from "./obsidian-vault.js";

export interface VaultScanAndSaveOptions {
  vaultPath: string;
  sourceFolder?: string;
  includePrefix?: string;
  minFiles?: number;
  maxFiles?: number;
  dryRun: boolean;
}

export interface VaultScanAndSaveSkip {
  relativePath: string;
  reason: "missing_note_id";
}

export interface VaultScanAndSaveReport {
  scannedFiles: number;
  writtenNoteIds: readonly string[];
  skipped: readonly VaultScanAndSaveSkip[];
  dryRun: boolean;
}

export async function scanVaultAndSave(
  store: JsonAuditStore,
  options: VaultScanAndSaveOptions,
): Promise<VaultScanAndSaveReport> {
  const scan = await scanObsidianVault(options.vaultPath, {
    ...(options.sourceFolder ? { sourceFolder: options.sourceFolder } : {}),
    ...(options.includePrefix ? { includePrefix: options.includePrefix } : {}),
    ...(options.minFiles !== undefined ? { minFiles: options.minFiles } : {}),
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
  });

  const state = await store.reconstructState();
  const currentNotes = new Map<string, SourceNote>(state.sourceNotes);
  const writtenNoteIds: string[] = [];
  const skipped: VaultScanAndSaveSkip[] = [];
  const now = new Date().toISOString();

  for (const candidate of scan.candidates) {
    if (!candidate.noteId) {
      skipped.push({
        relativePath: candidate.relativePath,
        reason: "missing_note_id",
      });
      continue;
    }

    const existing = currentNotes.get(candidate.noteId);
    if (!existing || existing.sourceHash !== candidate.sourceHash) {
      const nextVersion = existing ? existing.sourceVersion + 1 : 1;

      const knowledgeType =
        candidate.frontmatter.knowledgeType === "observation" ||
        candidate.frontmatter.knowledgeType === "interpretation"
          ? candidate.frontmatter.knowledgeType
          : candidate.frontmatter.type === "observation" ||
            candidate.frontmatter.type === "interpretation"
          ? candidate.frontmatter.type
          : "observation";

      const note: SourceNote = {
        noteId: candidate.noteId,
        sourceVersion: nextVersion,
        sourceHash: candidate.sourceHash,
        knowledgeType,
        createdAt:
          (candidate.frontmatter.createdAt as string) ||
          existing?.createdAt ||
          now,
        updatedAt: now,
        immutablePolicy: "ai_must_not_edit_body",
        body: candidate.body,
      };

      if (!options.dryRun) {
        await store.saveSourceNote(note);
      }
      currentNotes.set(candidate.noteId, note);
      writtenNoteIds.push(candidate.noteId);
    }
  }

  return {
    scannedFiles: scan.scannedMarkdownFiles,
    writtenNoteIds,
    skipped,
    dryRun: options.dryRun,
  };
}
