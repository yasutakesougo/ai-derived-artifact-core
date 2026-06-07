#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

interface ReviewProposal {
  artifactId: string;
  sourceNoteIds: string[];
  previousClassification: string;
  ollamaClassification: string;
  confidence: number;
  labels: string[];
  summary: string;
  humanReviewRequired: boolean;
  humanReviewRequiredReasons?: string[] | undefined;
  hallucinatedTerms?: string[] | undefined;
  flags: Array<{
    type: string;
    reason: string;
    claim?: string;
  }>;
  evidenceQuotes: string[];
  rawModelOutput: string;
  model: {
    provider: string;
    name: string;
    digest: string | null;
  };
  generatedAt: string;
}

const REASON_LABELS: Record<string, string> = {
  classification_change: "分類変更が発生",
  low_confidence: "低信頼度 (Confidence < 0.8)",
  hallucinated_terms: "ハルシネーション（外部語・言い換え）検出",
  invalid_evidence_quote: "引用根拠の不一致",
  classification_label_mismatch: "プライマリ分類がラベルに含まれない",
  model_flagged: "モデル自身が要レビュー判定",
  unsupported_inference: "その他の過剰推論警告",
};

async function main(): Promise<void> {
  const input = resolve(
    readOption("--input") ?? "../real-vault/ai-review-ollama-v2",
  );
  const output = resolve(
    readOption("--output") ?? "../real-vault/ai-review-ollama-v2-md",
  );
  const names = (await readdir(input))
    .filter((name) => name.startsWith("draft_") && name.endsWith(".json"))
    .sort();
  const proposals = await Promise.all(
    names.map(async (name) => {
      const value = JSON.parse(
        await readFile(join(input, name), "utf8"),
      ) as ReviewProposal;
      return value;
    }),
  );

  await mkdir(output, { recursive: false });
  for (const proposal of proposals) {
    await writeFile(
      join(output, `${proposal.artifactId}.md`),
      renderProposal(proposal),
      { encoding: "utf8", flag: "wx" },
    );
  }
  const indexTitle = `Ollama ${basename(output).replace("-md", "").replace("ai-review-", "")} 再分類レビュー`;
  await writeFile(join(output, "README.md"), renderIndex(proposals, indexTitle), {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `Wrote ${proposals.length} review notes and README.md to ${output}\n`,
  );
}

function renderProposal(proposal: ReviewProposal): string {
  const sourceLinks = proposal.sourceNoteIds.map(
    (noteId) => `- [[source/${noteId}|${noteId}]]`,
  );
  const flags =
    proposal.flags.length === 0
      ? ["- なし"]
      : proposal.flags.map((flag) => {
          const claim = flag.claim ? `\n  - 対象: ${flag.claim}` : "";
          return `- **${flag.type}**: ${flag.reason}${claim}`;
        });
  const evidence = proposal.evidenceQuotes.map(
    (quote) => `> ${quote.replaceAll("\n", "\n> ")}`,
  );

  let reasonsText = "なし";
  if (proposal.humanReviewRequiredReasons && proposal.humanReviewRequiredReasons.length > 0) {
    reasonsText = proposal.humanReviewRequiredReasons
      .map((r) => REASON_LABELS[r] || r)
      .join(", ");
  } else if (proposal.humanReviewRequired) {
    reasonsText = "要確認フラグあり (詳細理由未定義)";
  }

  const hallucinatedSection =
    proposal.hallucinatedTerms && proposal.hallucinatedTerms.length > 0
      ? `\n### 検出されたハルシネーション（外部語・言い換え）\n\n${proposal.hallucinatedTerms
          .map((term) => `- \`${term}\``)
          .join("\n")}\n`
      : "";

  return `---
artifactId: ${proposal.artifactId}
status: proposal
reviewFormat: ollama-v5
previousClassification: ${proposal.previousClassification}
ollamaClassification: ${proposal.ollamaClassification}
confidence: ${proposal.confidence}
humanReviewRequired: ${proposal.humanReviewRequired}
generatedAt: ${proposal.generatedAt}
---

# 再分類レビュー

## Manual Review

- [ ] Approve proposal
- [ ] Reject proposal
- [ ] Hold / needs discussion

Correct classification:
- [ ] observation
- [ ] behavior
- [ ] sensory
- [ ] communication

Review memo:
> 

---

## 提案内容の分析

| 項目 | 詳細 |
| :--- | :--- |
| **分類遷移** | \`${proposal.previousClassification}\` ➔ \`${proposal.ollamaClassification}\` |
| **信頼度 (Confidence)** | \`${proposal.confidence.toFixed(2)}\` |
| **要レビュー判定の理由** | ${reasonsText} |
${hallucinatedSection}
### 要約 (Summary)

${proposal.summary}

### ラベル (Labels)

${proposal.labels.map((label) => `\`${label}\``).join(", ")}

---

## 根拠

### 入力メモ (Source Notes)

${sourceLinks.join("\n")}

### 根拠の引用 (Evidence Quotes)

${evidence.join("\n\n")}

### 警告/フラグ (Flags)

${flags.join("\n")}

---

## モデル情報

- **モデル名**: \`${proposal.model.provider}/${proposal.model.name}\`
- **ダイジェスト**: \`${proposal.model.digest ?? "unknown"}\`
- **アーティファクトID**: \`${proposal.artifactId}\`

<details>
<summary>Raw model output</summary>

\`\`\`json
${proposal.rawModelOutput}
\`\`\`

</details>
`;
}

function renderIndex(proposals: ReviewProposal[], title: string): string {
  const reviewRequired = proposals.filter(
    (proposal) => proposal.humanReviewRequired,
  );
  const ordinary = proposals.filter(
    (proposal) => !proposal.humanReviewRequired,
  );

  const classificationChanges: ReviewProposal[] = [];
  const hallucinatedDetected: ReviewProposal[] = [];
  const lowConfidence: ReviewProposal[] = [];
  const otherWarnings: ReviewProposal[] = [];

  for (const proposal of reviewRequired) {
    const reasons = proposal.humanReviewRequiredReasons || [];
    let matched = false;

    if (
      reasons.includes("classification_change") ||
      proposal.previousClassification !== proposal.ollamaClassification
    ) {
      classificationChanges.push(proposal);
      matched = true;
    }
    if (reasons.includes("hallucinated_terms")) {
      hallucinatedDetected.push(proposal);
      matched = true;
    }
    if (reasons.includes("low_confidence") || proposal.confidence < 0.8) {
      lowConfidence.push(proposal);
      matched = true;
    }

    const isOther =
      reasons.some((r) =>
        [
          "invalid_evidence_quote",
          "classification_label_mismatch",
          "model_flagged",
          "unsupported_inference",
        ].includes(r),
      ) || !matched;

    if (isOther) {
      otherWarnings.push(proposal);
    }
  }

  const line = (proposal: ReviewProposal) => {
    const reasonsList = proposal.humanReviewRequiredReasons || [];
    const reasonDetail = reasonsList.length > 0
      ? ` [理由: ${reasonsList.map(r => REASON_LABELS[r] || r).join(", ")}]`
      : "";
    const termsDetail = proposal.hallucinatedTerms && proposal.hallucinatedTerms.length > 0
      ? ` (検出語: ${proposal.hallucinatedTerms.map(t => `"${t}"`).join(", ")})`
      : "";
    return `- [ ] [[${proposal.artifactId}|${proposal.sourceNoteIds.join(", ")}]]: \`${proposal.previousClassification}\` → \`${proposal.ollamaClassification}\` (${proposal.confidence.toFixed(2)})${reasonDetail}${termsDetail}`;
  };

  return `# ${title}

全${proposals.length}件。これは人間レビュー用の提案であり、自動確定されません。

## 優先レビュー (${reviewRequired.length})

### ⚠️ 分類変更が発生した提案 (${classificationChanges.length})

${classificationChanges.map(line).join("\n") || "- なし"}

### 🔍 ハルシネーション（外部語・言い換え）が検出された提案 (${hallucinatedDetected.length})

${hallucinatedDetected.map(line).join("\n") || "- なし"}

### 📉 低信頼度の提案 (Confidence < 0.8) (${lowConfidence.length})

${lowConfidence.map(line).join("\n") || "- なし"}

### 🏷️ その他の警告（引用崩れ・ラベル不一致等） (${otherWarnings.length})

${otherWarnings.map(line).join("\n") || "- なし"}

## その他 (要確認なし) (${ordinary.length})

${ordinary.map(line).join("\n") || "- なし"}

## レビュー方法

1. 各ノートを開き、入力メモと根拠を確認する。
2. 判定を1つ、正解分類を1つチェックする。
3. 却下または保留の場合はレビューメモへ理由を書く。
`;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
