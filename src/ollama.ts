import { createHash } from "node:crypto";
import type { ProposalArtifact, GenerationContext } from "./types.js";
import { canonicalizeSourceBody } from "./obsidian-vault.js";

export const CLASSIFICATION_PROMPT_TEMPLATE = `You are an expert knowledge classification agent.
Classify the following note by assigning appropriate category labels. Provide a short summary justification, confidence scores, and supporting evidence quotes extracted verbatim from the note.

Note Content:
"""
{{note_body}}
"""

Format your response strictly as a JSON object matching this schema:
{
  "type": "object",
  "properties": {
    "labels": {
      "type": "array",
      "items": { "type": "string" }
    },
    "summary": { "type": "string" },
    "confidence": {
      "type": "object",
      "properties": {
        "retrieval": { "type": "number", "minimum": 0, "maximum": 1 },
        "reasoning": { "type": "number", "minimum": 0, "maximum": 1 },
        "overall": { "type": "number", "minimum": 0, "maximum": 1 }
      },
      "required": ["retrieval", "reasoning", "overall"]
    },
    "evidence": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "quote": { "type": "string" }
        },
        "required": ["quote"]
      }
    }
  },
  "required": ["labels", "summary", "confidence", "evidence"]
}`;

function sha256(text: string): string {
  const digest = createHash("sha256")
    .update(text, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export async function resolveOllamaModelDigest(
  ollamaUrl: string,
  modelName: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      models?: Array<{ name: string; digest: string }>;
    };
    if (!data.models || !Array.isArray(data.models)) {
      return null;
    }
    let found = data.models.find((m) => m.name === modelName);
    if (!found) {
      found = data.models.find((m) => {
        const n1 = m.name.toLowerCase();
        const n2 = modelName.toLowerCase();
        return n1 === n2 || n1 === `${n2}:latest` || `${n1}:latest` === n2;
      });
    }
    return found ? found.digest : null;
  } catch {
    return null;
  }
}

export async function generateClassification(
  ollamaUrl: string,
  modelName: string,
  promptVersion: string,
  noteId: string,
  sourceHash: string,
  noteBody: string,
  options: {
    temperature?: number | undefined;
    top_p?: number | undefined;
    reviewCriteriaVersion?: string | undefined;
  } = {},
): Promise<ProposalArtifact> {
  const temperature = options.temperature ?? 0;
  const top_p = options.top_p ?? 1;
  const reviewCriteriaVersion =
    options.reviewCriteriaVersion ?? "review-policy-v1";

  const renderedPrompt = CLASSIFICATION_PROMPT_TEMPLATE.replace(
    "{{note_body}}",
    noteBody,
  );
  const promptHash = sha256(CLASSIFICATION_PROMPT_TEMPLATE);
  const inputHash = sha256(canonicalizeSourceBody(noteBody));

  const digest = await resolveOllamaModelDigest(ollamaUrl, modelName);

  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      prompt: renderedPrompt,
      stream: false,
      options: {
        temperature,
        top_p,
      },
      format: "json",
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama generation failed with status ${response.status}`);
  }

  const data = (await response.json()) as { response?: string };
  if (!data.response) {
    throw new Error("Ollama generation returned empty response");
  }

  const parsed = JSON.parse(data.response);

  // Schema Validation
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid classification output: not an object");
  }
  if (!Array.isArray(parsed.labels)) {
    throw new Error("Invalid classification output: labels must be an array");
  }
  if (typeof parsed.summary !== "string") {
    throw new Error("Invalid classification output: summary must be a string");
  }
  if (!parsed.confidence || typeof parsed.confidence !== "object") {
    throw new Error(
      "Invalid classification output: confidence must be an object",
    );
  }
  if (typeof parsed.confidence.overall !== "number") {
    throw new Error(
      "Invalid classification output: confidence.overall must be a number",
    );
  }
  if (!Array.isArray(parsed.evidence) || parsed.evidence.length === 0) {
    throw new Error("Invalid classification output: evidence is mandatory");
  }

  // Quote Validation
  for (const item of parsed.evidence) {
    if (typeof item.quote !== "string" || !item.quote.trim()) {
      throw new Error(
        "Invalid classification output: evidence quote is required",
      );
    }
    if (!noteBody.includes(item.quote)) {
      throw new Error(
        `Evidence quote "${item.quote}" not found in source body`,
      );
    }
  }

  const now = new Date().toISOString();

  const generationContext: GenerationContext = {
    provider: "ollama",
    task: "classification",
    promptVersion,
    promptHash,
    inputHash,
    model: {
      name: modelName,
      digest,
    },
    parameters: {
      temperature,
      top_p,
    },
    generatedAt: now,
  };

  const draftArtifact: ProposalArtifact = {
    artifactId: "", // resolved below
    artifactHash: "", // resolved below
    status: "proposed",
    sourceHashes: { [noteId]: sourceHash },
    referencedArtifactHashes: {},
    relationships: [],
    model: {
      provider: "ollama",
      name: modelName,
      version: digest || "unknown",
    },
    ruleVersion: "ollama-classification-v1",
    reviewCriteriaVersion,
    kind: "classification",
    knowledgeType: "interpretation",
    content: {
      classification: parsed.labels[0] || "unclassified",
      labels: parsed.labels,
      summary: parsed.summary,
      statement: `Ollama classification: ${parsed.summary}`,
    },
    confidence: {
      retrieval:
        typeof parsed.confidence.retrieval === "number"
          ? parsed.confidence.retrieval
          : null,
      reasoning:
        typeof parsed.confidence.reasoning === "number"
          ? parsed.confidence.reasoning
          : null,
      overall: parsed.confidence.overall,
    },
    evidence: parsed.evidence.map((ev: { quote: string }) => ({
      noteId,
      sourceHash,
      quote: ev.quote,
    })),
    generatedAt: now,
    generationContext,
  };

  const seed = [
    "classification",
    `${noteId}:${sourceHash}`,
    generationContext.model.name,
    generationContext.model.digest ?? "no-digest",
    generationContext.promptVersion,
    generationContext.promptHash,
    generationContext.inputHash,
    generationContext.generatedAt,
  ].join(":");

  draftArtifact.artifactId = `draft_classification_${createHash("sha256")
    .update(seed, "utf8")
    .digest("hex")
    .slice(0, 20)}`;

  return finalizeDraft(draftArtifact);
}

function finalizeDraft(artifact: ProposalArtifact): ProposalArtifact {
  const immutablePayload = { ...artifact, artifactHash: undefined };
  return {
    ...artifact,
    artifactHash: `sha256:${createHash("sha256")
      .update(stableStringify(immutablePayload), "utf8")
      .digest("hex")}`,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
