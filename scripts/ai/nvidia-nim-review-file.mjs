import 'dotenv/config';
import fs from 'node:fs/promises';
import OpenAI from 'openai';
import { resolveReviewFilePath } from './nvidia-nim-paths.mjs';

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

const resolvedPath = resolveReviewFilePath(targetPath);
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

/**
 * Validates the NVIDIA NIM review JSON output against the expected schema.
 * @param {string} jsonString - The JSON string to validate
 * @returns {{success: boolean, data?: object, error?: string}}
 */
function validateNimReviewOutput(jsonString) {
  try {
    // Extract JSON from the output (in case there's surrounding text)
    const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        success: false,
        error: 'Failed to extract JSON from NVIDIA NIM output. Output does not contain valid JSON.',
      };
    }

    const data = JSON.parse(jsonMatch[0]);

    // Validate required fields
    const errors = [];

    // Validate decision
    if (!['approve', 'needs_review', 'reject'].includes(data.decision)) {
      errors.push(
        `'decision' must be one of ['approve', 'needs_review', 'reject'], got: ${JSON.stringify(data.decision)}`
      );
    }

    // Validate reason
    if (typeof data.reason !== 'string' || data.reason.trim() === '') {
      errors.push(
        `'reason' must be a non-empty string, got: ${JSON.stringify(data.reason)}`
      );
    }

    // Validate suggestedTitle
    if (typeof data.suggestedTitle !== 'string') {
      errors.push(
        `'suggestedTitle' must be a string, got: ${JSON.stringify(data.suggestedTitle)}`
      );
    }

    // Validate riskNotes
    if (!Array.isArray(data.riskNotes)) {
      errors.push(
        `'riskNotes' must be an array, got: ${JSON.stringify(data.riskNotes)}`
      );
    } else if (!data.riskNotes.every((item) => typeof item === 'string')) {
      errors.push(
        `'riskNotes' must be an array of strings, got: ${JSON.stringify(data.riskNotes)}`
      );
    }

    // Validate confidence
    if (!['low', 'medium', 'high'].includes(data.confidence)) {
      errors.push(
        `'confidence' must be one of ['low', 'medium', 'high'], got: ${JSON.stringify(data.confidence)}`
      );
    }

    if (errors.length > 0) {
      return {
        success: false,
        error: `Validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
      };
    }

    return {
      success: true,
      data,
    };
  } catch (parseError) {
    return {
      success: false,
      error: `JSON parse error: ${parseError.message}\n\nNIM output was:\n${jsonString}`,
    };
  }
}

// Validate the output
const validation = validateNimReviewOutput(output);

console.log('\n--- NVIDIA NIM file review ---\n');

if (validation.success) {
  console.log('✓ Validation successful');
  console.log('\nParsed review data:');
  console.log(JSON.stringify(validation.data, null, 2));
} else {
  console.error('✗ Validation failed');
  console.error(validation.error);
  process.exit(1);
}
