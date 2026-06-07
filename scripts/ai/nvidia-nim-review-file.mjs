import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';

const apiKey = process.env.NVIDIA_API_KEY;
const model = process.env.NVIDIA_MODEL;
const targetPath = process.argv[2];

const timeoutMs = Number(process.env.NVIDIA_TIMEOUT_MS ?? '180000');
const maxTokens = Number(process.env.NVIDIA_MAX_TOKENS ?? '600');
const maxInputChars = Number(process.env.NVIDIA_MAX_INPUT_CHARS ?? '12000');
const retryCount = Number(process.env.NVIDIA_RETRY_COUNT ?? '1');

if (!apiKey || apiKey.includes('your_nvidia_api_key_here')) {
  console.error('NVIDIA_API_KEY is missing. Edit your .env file.');
  process.exit(1);
}

if (!model || model.includes('copy_model_id_from_nvidia_build')) {
  console.error('NVIDIA_MODEL is missing. Edit your .env file.');
  process.exit(1);
}

if (!targetPath) {
  console.error('Usage: npm run review:nvidia -- <review-file-path>');
  process.exit(1);
}

const resolvedPath = path.resolve(targetPath);
const content = await fs.readFile(resolvedPath, 'utf8');
const reviewContent =
  content.length > maxInputChars
    ? `${content.slice(0, maxInputChars)}\n\n...[truncated: input exceeded ${maxInputChars} chars]`
    : content;

const client = new OpenAI({
  apiKey,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: timeoutMs,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createReview() {
  return client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'あなたはAI生成アーティファクトの二次レビュー補助です。入力ファイルの内容を読み、長期的に保存する価値があるかを判定してください。最終判断は人間が行うため、自動承認を前提にしないでください。出力はJSONのみです。',
      },
      {
        role: 'user',
        content: `
次のレビュー候補ファイルを判定してください。

File path:
${resolvedPath}

File content:
---
${reviewContent}
---

次のJSON形式のみで返してください。

{
  "decision": "approve" | "needs_review" | "reject",
  "reason": "短い理由",
  "suggestedTitle": "保存する場合のタイトル。不要なら空文字",
  "riskNotes": ["注意点"],
  "confidence": "low" | "medium" | "high"
}
        `,
      },
    ],
    temperature: 0.2,
    top_p: 0.95,
    max_tokens: maxTokens,
  });
}

let response;

for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
  try {
    response = await createReview();
    break;
  } catch (error) {
    const isLastAttempt = attempt > retryCount;

    if (!isLastAttempt) {
      console.error(
        `NVIDIA NIM request failed on attempt ${attempt}. Retrying...`
      );
      await sleep(3000 * attempt);
      continue;
    }

    console.error('\nNVIDIA NIM request failed.');
    console.error('name:', error?.name ?? 'UnknownError');
    console.error('message:', error?.message ?? String(error));

    if (error?.name === 'APIConnectionTimeoutError') {
      console.error(
        '\nHint: The NVIDIA hosted endpoint may be slow or temporarily busy. Retry later, increase NVIDIA_TIMEOUT_MS, reduce NVIDIA_MAX_TOKENS, or use a smaller model.'
      );
    }

    process.exit(1);
  }
}

const output = response?.choices?.[0]?.message?.content ?? '';

// Validate and parse JSON response
function validateReviewJSON(jsonString) {
  let parsed;
  
  // Try to extract JSON from the response
  try {
    // First, try direct parsing
    parsed = JSON.parse(jsonString);
  } catch {
    // Try to extract JSON object from the response
    const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in response');
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      throw new Error(`Invalid JSON format: ${e.message}`);
    }
  }

  // Validate required fields and types
  const errors = [];

  // Validate decision
  if (!parsed.decision || !['approve', 'needs_review', 'reject'].includes(parsed.decision)) {
    errors.push(
      `Invalid decision: expected "approve", "needs_review", or "reject", got "${parsed.decision}"`
    );
  }

  // Validate reason
  if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '') {
    errors.push('reason must be a non-empty string');
  }

  // Validate suggestedTitle
  if (typeof parsed.suggestedTitle !== 'string') {
    errors.push(`suggestedTitle must be a string, got ${typeof parsed.suggestedTitle}`);
  }

  // Validate riskNotes
  if (!Array.isArray(parsed.riskNotes) || !parsed.riskNotes.every((item) => typeof item === 'string')) {
    errors.push('riskNotes must be an array of strings');
  }

  // Validate confidence
  if (!parsed.confidence || !['low', 'medium', 'high'].includes(parsed.confidence)) {
    errors.push(
      `Invalid confidence: expected "low", "medium", or "high", got "${parsed.confidence}"`
    );
  }

  if (errors.length > 0) {
    throw new Error(`Validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return parsed;
}

try {
  const reviewJSON = validateReviewJSON(output);
  console.log('\n--- NVIDIA NIM file review (validated) ---\n');
  console.log(JSON.stringify(reviewJSON, null, 2));
} catch (error) {
  console.error('\n--- Review JSON validation failed ---\n');
  console.error(`Error: ${error.message}`);
  console.error('\nRaw response from NVIDIA NIM:');
  console.error(output);
  process.exit(1);
}
