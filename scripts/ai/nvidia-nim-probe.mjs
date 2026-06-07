import 'dotenv/config';
import OpenAI from 'openai';

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

const client = new OpenAI({
  apiKey,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

const sampleArtifact = {
  artifactId: 'sample-memory-mode-sharepoint-bypass',
  kind: 'design_pattern',
  summary:
    'memory mode では SharePoint API を呼ばず、外部依存を完全にバイパスすることで、ローカル検証とE2Eの安定性を高める設計パターン。',
  tags: [
    'memory-mode',
    'sharepoint-bypass',
    'test-stability',
    'external-dependency-isolation',
  ],
};

const response = await client.chat.completions.create({
  model,
  messages: [
    {
      role: 'system',
      content:
        'あなたはAI生成アーティファクトのレビュー補助です。入力された候補が、長期的に保存する価値のある知識かを慎重に判定してください。自動承認せず、人間レビュー前提で、短く構造化して返してください。',
    },
    {
      role: 'user',
      content: `
次のAI生成アーティファクト候補をレビューしてください。

${JSON.stringify(sampleArtifact, null, 2)}

出力はJSONのみで返してください。

{
  "decision": "approve" | "needs_review" | "reject",
  "reason": "短い理由",
  "suggestedTitle": "保存する場合のタイトル",
  "riskNotes": ["注意点"]
}
      `,
    },
  ],
  temperature: 0.2,
  top_p: 0.95,
  max_tokens: 1200,
});

console.log('\n--- NVIDIA NIM artifact review probe ---\n');
console.log(response.choices?.[0]?.message?.content ?? response);
