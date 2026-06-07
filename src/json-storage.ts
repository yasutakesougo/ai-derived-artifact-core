import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ArtifactStatus,
  DerivedArtifact,
  LifecycleEvent,
  ReviewDecision,
  SourceNote,
} from "./types.js";

type RecordKind = "source-notes" | "artifacts" | "reviews" | "events";

export interface ReconstructedState {
  sourceNotes: ReadonlyMap<string, SourceNote>;
  artifacts: ReadonlyMap<string, DerivedArtifact>;
  reviews: readonly ReviewDecision[];
  events: readonly LifecycleEvent[];
}

export class JsonAuditStore {
  constructor(private readonly recordsRoot: string) {}

  async initialize(): Promise<void> {
    await Promise.all(
      (["source-notes", "artifacts", "reviews", "events"] as const).map(
        (kind) => mkdir(this.kindPath(kind), { recursive: true }),
      ),
    );
  }

  async saveSourceNote(note: SourceNote): Promise<void> {
    assertSafeId(note.noteId);
    if (!Number.isInteger(note.sourceVersion) || note.sourceVersion < 1) {
      throw new Error("sourceVersion must be a positive integer");
    }
    await this.writeAppendOnly(
      "source-notes",
      `${note.noteId}--v${note.sourceVersion}`,
      note,
    );
  }

  async readSourceNote(
    noteId: string,
    sourceVersion?: number,
  ): Promise<SourceNote | undefined> {
    assertSafeId(noteId);
    if (sourceVersion !== undefined) {
      return this.readRecord<SourceNote>(
        "source-notes",
        `${noteId}--v${sourceVersion}`,
      );
    }
    const versions = (await this.listRecords<SourceNote>("source-notes"))
      .filter((note) => note.noteId === noteId)
      .sort((a, b) => b.sourceVersion - a.sourceVersion);
    return versions[0];
  }

  async saveArtifact(artifact: DerivedArtifact): Promise<void> {
    assertSafeId(artifact.artifactId);
    if (artifact.status !== "proposed") {
      throw new Error("New artifacts must be saved with proposed status");
    }
    await this.writeAppendOnly(
      "artifacts",
      artifact.artifactId,
      artifact,
    );
  }

  async readArtifact(
    artifactId: string,
  ): Promise<DerivedArtifact | undefined> {
    assertSafeId(artifactId);
    return this.readRecord<DerivedArtifact>("artifacts", artifactId);
  }

  async appendReviewDecision(decision: ReviewDecision): Promise<void> {
    assertSafeId(decision.decisionId);
    assertSafeId(decision.artifactId);
    await this.writeAppendOnly(
      "reviews",
      decision.decisionId,
      decision,
    );
  }

  async readReviewDecision(
    decisionId: string,
  ): Promise<ReviewDecision | undefined> {
    assertSafeId(decisionId);
    return this.readRecord<ReviewDecision>("reviews", decisionId);
  }

  async appendLifecycleEvent(event: LifecycleEvent): Promise<void> {
    assertSafeId(event.eventId);
    assertSafeId(event.artifactId);
    await this.writeAppendOnly("events", event.eventId, event);
  }

  async readLifecycleEvent(
    eventId: string,
  ): Promise<LifecycleEvent | undefined> {
    assertSafeId(eventId);
    return this.readRecord<LifecycleEvent>("events", eventId);
  }

  async applyReviewDecision(decision: ReviewDecision): Promise<DerivedArtifact> {
    const artifact = await this.requireArtifact(decision.artifactId);
    if (artifact.status !== decision.fromStatus) {
      throw new Error(
        `Review status mismatch: ${artifact.status} != ${decision.fromStatus}`,
      );
    }
    await this.appendReviewDecision(decision);
    return this.updateArtifactStatus(
      artifact.artifactId,
      decision.fromStatus,
      decision.decision,
    );
  }

  async applyLifecycleEvent(event: LifecycleEvent): Promise<DerivedArtifact> {
    const artifact = await this.requireArtifact(event.artifactId);
    if (artifact.status !== event.fromStatus) {
      throw new Error(
        `Event status mismatch: ${artifact.status} != ${event.fromStatus}`,
      );
    }
    await this.appendLifecycleEvent(event);
    return this.updateArtifactStatus(
      artifact.artifactId,
      event.fromStatus,
      event.toStatus,
    );
  }

  async reconstructState(): Promise<ReconstructedState> {
    const [sourceVersions, storedArtifacts, reviews, events] = await Promise.all([
      this.listRecords<SourceNote>("source-notes"),
      this.listRecords<DerivedArtifact>("artifacts"),
      this.listRecords<ReviewDecision>("reviews"),
      this.listRecords<LifecycleEvent>("events"),
    ]);

    const sourceNotes = new Map<string, SourceNote>();
    for (const note of sourceVersions) {
      const current = sourceNotes.get(note.noteId);
      if (!current || note.sourceVersion > current.sourceVersion) {
        sourceNotes.set(note.noteId, note);
      }
    }

    const artifacts = new Map<string, DerivedArtifact>();
    for (const stored of storedArtifacts) {
      const artifactReviews = reviews.filter(
        (item) => item.artifactId === stored.artifactId,
      );
      const artifactEvents = events.filter(
        (item) => item.artifactId === stored.artifactId,
      );
      if (artifactReviews.length > 1 || artifactEvents.length > 1) {
        throw new Error(
          `Artifact ${stored.artifactId} has duplicate transition records`,
        );
      }
      const decision = artifactReviews[0];
      const event = artifactEvents[0];
      let status: ArtifactStatus = "proposed";
      if (decision) {
        if (decision.fromStatus !== status) {
          throw new Error(`Invalid review history for ${stored.artifactId}`);
        }
        status = decision.decision;
      }
      if (event) {
        if (event.fromStatus !== status) {
          throw new Error(`Invalid event history for ${stored.artifactId}`);
        }
        status = event.toStatus;
      }
      artifacts.set(stored.artifactId, { ...stored, status });
    }

    return {
      sourceNotes,
      artifacts,
      reviews: Object.freeze(reviews),
      events: Object.freeze(events),
    };
  }

  private async requireArtifact(artifactId: string): Promise<DerivedArtifact> {
    const artifact = await this.readArtifact(artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    return artifact;
  }

  private async updateArtifactStatus(
    artifactId: string,
    expectedStatus: ArtifactStatus,
    nextStatus: ArtifactStatus,
  ): Promise<DerivedArtifact> {
    const artifact = await this.requireArtifact(artifactId);
    if (artifact.status !== expectedStatus) {
      throw new Error(
        `Artifact status changed concurrently: ${artifact.status}`,
      );
    }
    const updated = { ...artifact, status: nextStatus };
    await this.writeProjection(
      this.recordPath("artifacts", artifactId),
      updated,
    );
    return updated;
  }

  private async writeAppendOnly(
    kind: RecordKind,
    id: string,
    value: unknown,
  ): Promise<void> {
    await this.initialize();
    const path = this.recordPath(kind, id);
    const handle = await open(path, "wx").catch((error: unknown) => {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`Append-only record already exists: ${kind}/${id}`);
      }
      throw error;
    });
    try {
      await handle.writeFile(serialize(value), "utf8");
    } finally {
      await handle.close();
    }
  }

  private async writeProjection(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialize(value), "utf8");
    await rename(temporary, path);
  }

  private async readRecord<T>(
    kind: RecordKind,
    id: string,
  ): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(kind, id), "utf8")) as T;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async listRecords<T>(kind: RecordKind): Promise<T[]> {
    const names = await readdir(this.kindPath(kind))
      .then((entries) =>
        entries.filter((name) => name.endsWith(".json")).sort(),
      )
      .catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") {
          return [];
        }
        throw error;
      });
    return Promise.all(
      names.map(async (name) => {
        const text = await readFile(join(this.kindPath(kind), name), "utf8");
        return JSON.parse(text) as T;
      }),
    );
  }

  private kindPath(kind: RecordKind): string {
    return join(this.recordsRoot, kind);
  }

  private recordPath(kind: RecordKind, id: string): string {
    assertSafeId(id);
    return join(this.kindPath(kind), `${id}.json`);
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid record ID: ${id}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
