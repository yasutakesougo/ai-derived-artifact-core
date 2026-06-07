#!/usr/bin/env node
/**
 * Mock Ollama server for Phase B.0 operational validation.
 * Listens on port 11434 and serves two endpoints:
 *   - GET  /api/tags     → returns a fake model manifest
 *   - POST /api/generate → returns a deterministic classification JSON
 *
 * The /api/generate handler extracts verbatim quotes from the note body
 * so evidence passes the strict quote-validation check.
 *
 * Usage:  node scratch/mock-ollama.js
 * Stop:   Ctrl+C or kill the process
 */

import { createServer } from "node:http";

const PORT = 11434;
const MODEL_NAME = "qwen3:8b";
const MODEL_DIGEST = "sha256:mock_digest_for_validation_run";

/** Fake model tags response */
const TAGS_RESPONSE = JSON.stringify({
  models: [
    {
      name: MODEL_NAME,
      digest: MODEL_DIGEST,
      size: 4_000_000_000,
      modified_at: new Date().toISOString(),
    },
  ],
});

/**
 * Extract short verbatim quotes from the note body embedded in the prompt.
 * The prompt template wraps the note in triple-quoted delimiters.
 */
function extractNoteBody(prompt) {
  const start = prompt.indexOf('"""');
  const end = prompt.lastIndexOf('"""');
  if (start === -1 || end === -1 || start === end) {
    return "";
  }
  return prompt.slice(start + 3, end).trim();
}

/**
 * Pick up to 2 verbatim sentences/lines from the note body as evidence quotes.
 * Falls back to the first 120 chars if sentence splitting yields nothing.
 */
function extractQuotes(noteBody) {
  if (!noteBody) return ["(no content)"];

  // Split on sentence-ending punctuation or newlines
  const sentences = noteBody
    .split(/(?<=[。．.!?！？\n])\s*/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  if (sentences.length === 0) {
    // Fallback: first 120 chars
    return [noteBody.slice(0, 120).trim()];
  }

  return sentences.slice(0, 2);
}

/**
 * Generate deterministic labels from the note body keywords.
 */
function inferLabels(noteBody) {
  const lower = noteBody.toLowerCase();
  const labels = [];

  const patterns = [
    [/行動|行為|behavior/u, "behavior"],
    [/観察|observation|記録/u, "observation"],
    [/支援|介入|支持|support|intervention/u, "intervention"],
    [/アセスメント|assessment|評価/u, "assessment"],
    [/環境|environment/u, "environment"],
    [/コミュニケーション|communication|会話/u, "communication"],
    [/emotion|感情|情緒/u, "emotion"],
    [/sensory|感覚/u, "sensory"],
    [/routine|日課|ルーティン/u, "routine"],
    [/meal|食事|eating/u, "daily_living"],
  ];

  for (const [pattern, label] of patterns) {
    if (pattern.test(lower)) {
      labels.push(label);
    }
    if (labels.length >= 2) break;
  }

  if (labels.length === 0) {
    labels.push("observation");
  }

  return labels;
}

/**
 * Handle POST /api/generate
 */
function handleGenerate(body) {
  const noteBody = extractNoteBody(body.prompt || "");
  const quotes = extractQuotes(noteBody);
  const labels = inferLabels(noteBody);

  const classification = {
    labels,
    summary: `Mock classification: ${labels.join(", ")}. Extracted from note content.`,
    confidence: {
      retrieval: 0.92,
      reasoning: 0.91,
      overall: 0.93,
    },
    evidence: quotes.map((quote) => ({ quote })),
  };

  return JSON.stringify({
    model: body.model || MODEL_NAME,
    created_at: new Date().toISOString(),
    response: JSON.stringify(classification),
    done: true,
  });
}

const server = createServer((req, res) => {
  // GET /api/tags
  if (req.method === "GET" && req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(TAGS_RESPONSE);
    console.log("[mock-ollama] GET /api/tags → 200");
    return;
  }

  // POST /api/generate
  if (req.method === "POST" && req.url === "/api/generate") {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(data);
        const response = handleGenerate(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(response);
        console.log(
          `[mock-ollama] POST /api/generate model=${body.model} → 200`,
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
        console.error("[mock-ollama] POST /api/generate → 500", err);
      }
    });
    return;
  }

  // Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
  console.log(`[mock-ollama] ${req.method} ${req.url} → 404`);
});

server.listen(PORT, () => {
  console.log(`[mock-ollama] Listening on http://localhost:${PORT}`);
  console.log(`[mock-ollama] Model: ${MODEL_NAME} (${MODEL_DIGEST})`);
  console.log("[mock-ollama] Press Ctrl+C to stop.");
});
