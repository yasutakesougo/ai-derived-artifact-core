import 'dotenv/config';
import fs from 'node:fs/promises';
import OpenAI from 'openai';
import {
  formatBatchReviewJsonl,
  parseBatchReviewArgs,
} from './nvidia-nim-batch-jsonl.mjs';
import { resolveReviewFilePath } from './nvidia-nim-paths.mjs';

// 環境変数の読み込み
const apiKey = process.env.NVIDIA_API_KEY;
const model = process.env.NVIDIA_MODEL;

if (!apiKey || apiKey.includes('your_nvidia_api_key_here')) {
  console.error('NVIDIA_API_KEY is missing. Edit your .env file.');
  process.exit(1);
}

if (!model || model.includes('copy_model_id_from_nvidia_build')) {
  console.error('NVIDIA_MODEL is missing. Edit your .env file.');
  process.exit(1);
}

const timeoutMs = Number(process.env.NVIDIA_TIMEOUT_MS ?? '180000');
const maxTokens = Number(process.env.NVIDIA_MAX_TOKENS ?? '600');
const maxInputChars = Number(process.env.NVIDIA_MAX_INPUT_CHARS ?? '12000');

// JSON抽出関数
function extractJson(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    throw new Error('No JSON found in output');
  }
  return text.substring(first, last + 1);
}

// バリデーション関数
function validateNimReviewObject(obj) {
  const decisions = ['approve', 'needs_review', 'reject'];
  const confidences = ['low', 'medium', 'high'];

  if (!decisions.includes(obj.decision)) {
    throw new Error(`Invalid decision: ${obj.decision}`);
  }
  if (typeof obj.reason !== 'string' || obj.reason.trim() === '') {
    throw new Error('Invalid reason: must be non-empty string');
  }
  if (typeof obj.suggestedTitle !== 'string') {
    throw new Error('Invalid suggestedTitle: must be string');
  }
  if (!Array.isArray(obj.riskNotes) || !obj.riskNotes.every((x) => typeof x === 'string')) {
    throw new Error('Invalid riskNotes: must be array of strings');
  }
  if (!confidences.includes(obj.confidence)) {
    throw new Error(`Invalid confidence: ${obj.confidence}`);
  }
}

const client = new OpenAI({
  apiKey,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: timeoutMs,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reviewFile(filePath, index, total) {
  try {
    const resolvedPath = resolveReviewFilePath(filePath);
    const content = await fs.readFile(resolvedPath, 'utf8');
    const reviewContent =
      content.length > maxInputChars
        ? `${content.slice(0, maxInputChars)}\n\n...[truncated: input exceeded ${maxInputChars} chars]`
        : content;

    const response = await client.chat.completions.create({
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
ファイルパス:
${resolvedPath}

内容:
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

    const output = response?.choices?.[0]?.message?.content ?? '';
    const jsonString = extractJson(output);
    const obj = JSON.parse(jsonString);
    validateNimReviewObject(obj);

    return {
      file: filePath,
      success: true,
      decision: obj.decision,
      reason: obj.reason,
      suggestedTitle: obj.suggestedTitle,
      riskNotes: obj.riskNotes,
      confidence: obj.confidence,
    };
  } catch (err) {
    return {
      file: filePath,
      success: false,
      error: err.message,
    };
  }
}

async function main() {
  let parsedArgs;
  try {
    parsedArgs = parseBatchReviewArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('Usage: npm run review:nvidia:batch -- [--out reviews.jsonl] file1.md file2.md ...');
    process.exit(1);
  }

  const { files, outPath } = parsedArgs;
  if (files.length === 0) {
    console.error('Usage: npm run review:nvidia:batch -- [--out reviews.jsonl] file1.md file2.md ...');
    process.exit(1);
  }

  console.log(`\n--- NVIDIA NIM batch review (${files.length} files) ---\n`);

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`Processing [${i + 1}/${files.length}] ${file}...`);

    // リクエスト間に短い待機を挟む（レート制限対策）
    if (i > 0) {
      await sleep(1000);
    }

    const review = await reviewFile(file, i + 1, files.length);
    results.push(review);

    // 各ファイルの結果を表示
    if (review.success) {
      console.log(`  ✓ ${review.decision} (confidence: ${review.confidence})`);
    } else {
      console.log(`  ✗ Error: ${review.error}`);
    }
  }

  console.log('\n--- Summary ---\n');

  // 結果を決定別に分類
  const approved = results.filter((r) => r.success && r.decision === 'approve').length;
  const needsReview = results.filter((r) => r.success && r.decision === 'needs_review').length;
  const rejected = results.filter((r) => r.success && r.decision === 'reject').length;
  const failed = results.filter((r) => !r.success).length;

  console.log(`Total: ${files.length}`);
  console.log(`  Approved: ${approved}`);
  console.log(`  Needs Review: ${needsReview}`);
  console.log(`  Rejected: ${rejected}`);
  console.log(`  Failed: ${failed}`);

  console.log('\n--- Detailed Results ---\n');
  console.log(JSON.stringify(results, null, 2));

  if (outPath) {
    await fs.writeFile(outPath, formatBatchReviewJsonl(results), 'utf8');
    console.log(`\nJSONL written: ${outPath}`);
  }

  // エラーがあったら終了コード1で終了
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
