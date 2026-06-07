import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonAuditStore, runCli } from "../src/index.js";

let root: string;
let vaultPath: string;
let recordsPath: string;
let store: JsonAuditStore;

beforeEach(async () => {
  root = await mkdir(join(tmpdir(), `artifact-e2e-${Date.now()}`), {
    recursive: true,
  }) || join(tmpdir(), `artifact-e2e-${Date.now()}`);
  vaultPath = join(root, "Vault");
  recordsPath = join(root, "records");
  await mkdir(join(vaultPath, "source"), { recursive: true });
  store = new JsonAuditStore(recordsPath);
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("End-to-End CLI Workflow Integration", () => {
  it("executes the complete workflow safely and successfully", async () => {
    // 1. Create source note
    const noteContent = `---
noteId: note_A
type: observation
createdAt: 2026-06-06T21:00:00+09:00
---
This is the initial content of note A.
`;
    await writeFile(join(vaultPath, "source", "note_A.md"), noteContent, "utf8");

    // 2. Scan vault (dry-run)
    let scanDryStdout = "";
    const scanDryCode = await runCli(
      ["scan-vault", "--dry-run", "--vault", vaultPath, "--records", recordsPath],
      {
        stdout: (t) => { scanDryStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(scanDryCode).toBe(0);
    expect(scanDryStdout).toContain("Vault scan dry-run");
    expect(scanDryStdout).toContain("Scanned files: 1");
    expect(scanDryStdout).toContain("Written source notes: 1");
    expect(scanDryStdout).toContain("No files were modified.");

    const sourceNotesBefore = await readdir(join(recordsPath, "source-notes")).catch(() => []);
    expect(sourceNotesBefore).toHaveLength(0);

    // 3. Scan vault (write)
    let scanWriteStdout = "";
    const scanWriteCode = await runCli(
      ["scan-vault", "--write", "--vault", vaultPath, "--records", recordsPath],
      {
        stdout: (t) => { scanWriteStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(scanWriteCode).toBe(0);
    expect(scanWriteStdout).toContain("Vault scan");
    expect(scanWriteStdout).toContain("Scanned files: 1");
    expect(scanWriteStdout).toContain("Written source notes: 1");
    expect(scanWriteStdout).not.toContain("No files were modified.");

    const sourceNotesAfter = await readdir(join(recordsPath, "source-notes"));
    expect(sourceNotesAfter).toHaveLength(1);
    expect(sourceNotesAfter[0]).toContain("note_A--v1.json");

    // 4. Generate proposal (dry-run)
    let propDryStdout = "";
    const propDryCode = await runCli(
      [
        "generate-proposals",
        "--dry-run",
        "--vault",
        vaultPath,
        "--records",
        recordsPath,
        "--generated-at",
        "2026-06-06T22:00:00+09:00",
      ],
      {
        stdout: (t) => { propDryStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(propDryCode).toBe(0);
    expect(propDryStdout).toContain("Proposal generation dry-run");
    expect(propDryStdout).toContain("Eligible notes: 1");
    expect(propDryStdout).toContain("Drafts: 1");
    expect(propDryStdout).toContain("No files were modified.");

    const artifactsBefore = await readdir(join(recordsPath, "artifacts")).catch(() => []);
    expect(artifactsBefore).toHaveLength(0);

    // 5. Generate proposal (write)
    let propWriteStdout = "";
    const propWriteCode = await runCli(
      [
        "generate-proposals",
        "--write",
        "--vault",
        vaultPath,
        "--records",
        recordsPath,
        "--generated-at",
        "2026-06-06T22:00:00+09:00",
      ],
      {
        stdout: (t) => { propWriteStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(propWriteCode).toBe(0);
    expect(propWriteStdout).toContain("Proposal generation");
    expect(propWriteStdout).toContain("Written artifacts: 1");

    const artifactsAfter = await readdir(join(recordsPath, "artifacts"));
    expect(artifactsAfter).toHaveLength(1);
    const artifactId = artifactsAfter[0]!.replace(".json", "");

    // 6. Export review (dry-run)
    let expDryStdout = "";
    const expDryCode = await runCli(
      ["export-review", "--dry-run", "--vault", vaultPath, "--records", recordsPath],
      {
        stdout: (t) => { expDryStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(expDryCode).toBe(0);
    expect(expDryStdout).toContain("Review export dry-run");
    expect(expDryStdout).toContain("No files were modified.");

    const reviewFilesBefore = await readdir(join(vaultPath, "ai-review")).catch(() => []);
    expect(reviewFilesBefore).toHaveLength(0);

    // 7. Export review (write)
    let expWriteStdout = "";
    const expWriteCode = await runCli(
      ["export-review", "--write", "--vault", vaultPath, "--records", recordsPath],
      {
        stdout: (t) => { expWriteStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(expWriteCode).toBe(0);
    expect(expWriteStdout).toContain("Review export");
    expect(expWriteStdout).toContain("Written Markdown files: 1");

    const reviewFilesAfter = await readdir(join(vaultPath, "ai-review"));
    expect(reviewFilesAfter).toHaveLength(1);
    expect(reviewFilesAfter[0]).toBe(`${artifactId}.md`);

    // 8. Simulate human approval
    const reviewFilePath = join(vaultPath, "ai-review", `${artifactId}.md`);
    const reviewContent = await readFile(reviewFilePath, "utf8");
    expect(reviewContent).toContain("- [ ] Approve");
    const approvedReviewContent = reviewContent.replace("- [ ] Approve", "- [x] Approve");
    await writeFile(reviewFilePath, approvedReviewContent, "utf8");

    // 9. Import review (dry-run)
    let impDryStdout = "";
    const impDryCode = await runCli(
      [
        "import-review",
        "--dry-run",
        "--vault",
        vaultPath,
        "--records",
        recordsPath,
        "--decided-by",
        "reviewer_A",
        "--reason",
        "Looks good",
        "--decided-at",
        "2026-06-06T22:30:00+09:00",
      ],
      {
        stdout: (t) => { impDryStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(impDryCode).toBe(0);
    expect(impDryStdout).toContain("Review import dry-run");
    expect(impDryStdout).toContain("Decisions: 1");
    expect(impDryStdout).toContain("No records were modified.");

    const reviewsBefore = await readdir(join(recordsPath, "reviews")).catch(() => []);
    expect(reviewsBefore).toHaveLength(0);

    // 10. Import review (write)
    let impWriteStdout = "";
    const impWriteCode = await runCli(
      [
        "import-review",
        "--write",
        "--vault",
        vaultPath,
        "--records",
        recordsPath,
        "--decided-by",
        "reviewer_A",
        "--reason",
        "Looks good",
        "--decided-at",
        "2026-06-06T22:30:00+09:00",
      ],
      {
        stdout: (t) => { impWriteStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(impWriteCode).toBe(0);
    expect(impWriteStdout).toContain("Review import");
    expect(impWriteStdout).toContain("Written ReviewDecisions: 1");

    const reviewsAfter = await readdir(join(recordsPath, "reviews"));
    expect(reviewsAfter).toHaveLength(1);

    // 11. Verify approved state
    const state1 = await store.reconstructState();
    const approvedArtifact = state1.artifacts.get(artifactId);
    expect(approvedArtifact).toBeDefined();
    expect(approvedArtifact?.status).toBe("approved");

    // 12. Modify source note
    const modifiedNoteContent = `---
noteId: note_A
type: observation
createdAt: 2026-06-06T21:00:00+09:00
---
This is the modified content of note A.
`;
    await writeFile(join(vaultPath, "source", "note_A.md"), modifiedNoteContent, "utf8");

    // Scan vault again to update records
    const scan2Code = await runCli(
      ["scan-vault", "--write", "--vault", vaultPath, "--records", recordsPath],
      {
        stdout: () => {},
        stderr: (t) => { console.error(t); },
      },
    );
    expect(scan2Code).toBe(0);

    const sourceNotesList = await readdir(join(recordsPath, "source-notes"));
    expect(sourceNotesList).toHaveLength(2); // note_A--v1 and note_A--v2

    // 13. Run freshness (dry-run)
    let freshDryStdout = "";
    const freshDryCode = await runCli(
      ["freshness", "--dry-run", "--records", recordsPath],
      {
        stdout: (t) => { freshDryStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(freshDryCode).toBe(0);
    expect(freshDryStdout).toContain("Freshness dry-run");
    expect(freshDryStdout).toContain("Candidates: 1");
    expect(freshDryStdout).toContain(`${artifactId}: approved -> stale`);
    expect(freshDryStdout).toContain("No files were modified.");

    const eventsBefore = await readdir(join(recordsPath, "events")).catch(() => []);
    expect(eventsBefore).toHaveLength(0);

    // 14. Run freshness (write)
    let freshWriteStdout = "";
    const freshWriteCode = await runCli(
      ["freshness", "--write", "--records", recordsPath],
      {
        stdout: (t) => { freshWriteStdout += t; },
        stderr: (t) => { console.error(t); },
      },
    );
    expect(freshWriteCode).toBe(0);
    expect(freshWriteStdout).toContain("Freshness evaluation");
    expect(freshWriteStdout).toContain("Written lifecycle events: 1");

    // 15. Verify stale transition
    const state2 = await store.reconstructState();
    const staleArtifact = state2.artifacts.get(artifactId);
    expect(staleArtifact).toBeDefined();
    expect(staleArtifact?.status).toBe("stale");

    // 16. Verify audit trail is append-only and intact
    const eventsList = await readdir(join(recordsPath, "events"));
    expect(eventsList).toHaveLength(1);
    const eventData = JSON.parse(
      await readFile(join(recordsPath, "events", eventsList[0]!), "utf8"),
    );
    expect(eventData.toStatus).toBe("stale");
    expect(eventData.artifactId).toBe(artifactId);
    expect(eventData.reason).toContain("source_hash_changed");

    // Ensure the source notes are never deleted or modified
    const v1Note = JSON.parse(
      await readFile(join(recordsPath, "source-notes", "note_A--v1.json"), "utf8"),
    );
    const v2Note = JSON.parse(
      await readFile(join(recordsPath, "source-notes", "note_A--v2.json"), "utf8"),
    );
    expect(v1Note.body).toContain("initial content");
    expect(v2Note.body).toContain("modified content");

    // Ensure the original vault note exists and was not altered by the tool (it was modified by us)
    const vaultNoteBody = await readFile(join(vaultPath, "source", "note_A.md"), "utf8");
    expect(vaultNoteBody).toBe(modifiedNoteContent);
  });
});
