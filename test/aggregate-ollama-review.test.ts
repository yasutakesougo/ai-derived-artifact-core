import { describe, expect, it } from "vitest";
import { parseReviewMarkdown } from "../src/aggregate-ollama-review.js";

describe("parseReviewMarkdown", () => {
  const baseMarkdown = `---
artifactId: draft_classification_13527f68e7b1b6f6965a
status: proposal
reviewFormat: ollama-v5
previousClassification: observation
ollamaClassification: observation
confidence: 0.95
humanReviewRequired: true
generatedAt: 2026-06-07T02:07:57.287Z
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
`;

  it("parses unreviewed markdown correctly", () => {
    const parsed = parseReviewMarkdown(baseMarkdown);
    expect(parsed.outcome).toBe("unreviewed");
    expect(parsed.correctClassification).toBeUndefined();
    expect(parsed.reviewMemo).toBe("");
    expect(parsed.reviewTimeSeconds).toBeUndefined();
  });

  it("parses approved markdown with review memo and reviewTime", () => {
    const md = baseMarkdown
      .replace("- [ ] Approve proposal", "- [x] Approve proposal")
      .replace("Review memo:\n> ", "Review memo:\n> Looks good.\n> Agreed.");
    
    // Add reviewTime to frontmatter
    const mdWithTime = md.replace(
      "generatedAt: 2026-06-07T02:07:57.287Z",
      "generatedAt: 2026-06-07T02:07:57.287Z\nreviewTimeSeconds: 45"
    );

    const parsed = parseReviewMarkdown(mdWithTime);
    expect(parsed.outcome).toBe("approved");
    expect(parsed.correctClassification).toBeUndefined();
    expect(parsed.reviewMemo).toBe("Looks good.\nAgreed.");
    expect(parsed.reviewTimeSeconds).toBe(45);
  });

  it("parses rejected markdown with correct classification override", () => {
    const md = baseMarkdown
      .replace("- [ ] Reject proposal", "- [x] Reject proposal")
      .replace("- [ ] sensory", "- [X] sensory")
      .replace("Review memo:\n> ", "Review memo:\n> Should be sensory.");

    const parsed = parseReviewMarkdown(md);
    expect(parsed.outcome).toBe("rejected");
    expect(parsed.correctClassification).toBe("sensory");
    expect(parsed.reviewMemo).toBe("Should be sensory.");
  });

  it("throws error if multiple outcomes checked", () => {
    const md = baseMarkdown
      .replace("- [ ] Approve proposal", "- [x] Approve proposal")
      .replace("- [ ] Reject proposal", "- [x] Reject proposal");

    expect(() => parseReviewMarkdown(md)).toThrow("Multiple review outcomes checked");
  });

  it("throws error if multiple classifications checked", () => {
    const md = baseMarkdown
      .replace("- [ ] Approve proposal", "- [x] Approve proposal")
      .replace("- [ ] observation", "- [x] observation")
      .replace("- [ ] behavior", "- [x] behavior");

    expect(() => parseReviewMarkdown(md)).toThrow("Multiple correct classifications checked");
  });

  it("parses alternative reviewTime frontmatter field", () => {
    const md = baseMarkdown.replace(
      "generatedAt: 2026-06-07T02:07:57.287Z",
      "generatedAt: 2026-06-07T02:07:57.287Z\nreviewTime: 120"
    );
    const parsed = parseReviewMarkdown(md);
    expect(parsed.reviewTimeSeconds).toBe(120);
  });

  it("throws error on missing frontmatter fields", () => {
    const md = `---
artifactId: draft_classification_13527f68e7b1b6f6965a
status: proposal
---
# Test`;
    expect(() => parseReviewMarkdown(md)).toThrow();
  });
});
