# AI Derived Artifact Core

Pure TypeScript implementation of the lifecycle defined by
`ai-derived-artifact-v1.1`.

```text
proposed -> approved -> stale
         -> rejected
         -> deferred
         -> obsolete
```

The domain core contains only types and deterministic lifecycle functions. The
same package also contains filesystem adapters and CLI orchestration that
depend on the core. The core modules do not depend on Obsidian, Qdrant, Ollama,
storage, clocks, or ID generators.

## MVP Usage Boundary

This core:

- does not run AI models;
- does not edit source notes;
- does not treat Qdrant or any search index as a source of truth;
- handles only domain validation, status transitions, and audit events.

Callers are responsible for storage, authentication, authorization, source-note
access, model execution, search indexing, clocks, and ID generation.

The core must remain usable and fully testable without Obsidian, Qdrant, Ollama,
or network access.

## Integration Order

Integrations should be added outside this package in the following order:

1. JSON storage adapter
2. CLI dry-run
3. Read-only Obsidian Vault adapter
4. AI proposal-note writer
5. Qdrant and Ollama adapters

Each adapter must depend on the core. The core must not depend on an adapter.

## Commands

```bash
npm run cli -- freshness --dry-run
npm run cli -- proposals --dry-run \
  --vault /path/to/Vault \
  --records /path/to/records \
  --generated-at 2026-06-06T22:00:00+09:00
npm run cli -- review-export --dry-run \
  --vault /path/to/Vault \
  --records /path/to/records
npm run cli -- review-import --dry-run \
  --vault /path/to/Vault \
  --records /path/to/records \
  --decided-by reviewer-id \
  --reason "Evidence checked" \
  --decided-at 2026-06-06T23:00:00+09:00
npm test
npm run typecheck
npm audit
```

The CLI reads `./records` by default. Use another audit directory with:

```bash
npm run cli -- freshness --dry-run --records /path/to/records
```

Current dependency versions can be supplied explicitly:

```bash
npm run cli -- freshness --dry-run \
  --model-provider ollama \
  --model-name qwen3 \
  --model-version model-v2 \
  --rule-version rule-v2 \
  --review-criteria-version review-v2
```

The dry-run prints `stale` and `obsolete` candidates but never writes records.
Candidates do not cause a non-zero exit code; invalid input and execution
errors do.

Proposal generation uses a deterministic stub generator. It requires Vault
`noteId` and body hash to match the latest stored `SourceNote`. Dry-run writes
nothing; `--write` stores only proposed drafts under `records/artifacts/`.

## Main API

- `evaluateArtifactFreshness()`
- `transitionArtifactStatus()`
- `createReviewDecision()`
- `createStalenessEvent()`
- `createObsolescenceEvent()`
- `applyFreshnessEvaluation()`
- `regenerateArtifact()`
- `JsonAuditStore`
- `scanObsidianVault()`
- `generateProposalDrafts()`
- `exportReviewMarkdown()`
- `importManualReviewDecisions()`

Event IDs, timestamps, and evaluator identities are supplied by the caller so
that all core functions remain deterministic and testable.

## JSON Storage Adapter

`JsonAuditStore` persists the audit model without Obsidian, Qdrant, Ollama, or
network access:

```text
records/
  source-notes/
  artifacts/
  reviews/
  events/
```

Source-note versions, review decisions, and lifecycle events are append-only.
Artifact content is append-only after creation; only its status projection may
be updated through `applyReviewDecision()` or `applyLifecycleEvent()`.

`reconstructState()` derives current artifact status from decisions and events
instead of trusting the stored status projection.

## Read-Only Obsidian Vault Adapter

`scanObsidianVault()` reads Markdown from `source/` or a configured
Vault-relative folder:

```ts
const report = await scanObsidianVault("/path/to/Vault", {
  sourceFolder: "04_Observations",
});
```

It reads `noteId` from YAML frontmatter and calculates a SHA-256 hash from the
canonicalized Markdown body. Frontmatter, including AI-managed fields, is
excluded from the hash. Notes without `noteId` are reported as
`missing_note_id`; the adapter never generates or writes an ID.

Absolute source-folder paths, traversal segments, and symlink traversal are not
allowed. The adapter does not write to the Vault.

## Stub Proposal Generator

The stub generator creates:

- one `classification` draft for each eligible source note;
- one `related_candidate` draft for each eligible note pair.

Every draft has evidence, separated retrieval/reasoning/overall confidence,
`interpretation` knowledge type, and `proposed` status. It never edits Markdown
or writes reviews and events.

## Review Markdown Export

`exportReviewMarkdown()` renders proposed, stale, and obsolete proposal
artifacts into a dedicated Vault-relative folder, `ai-review/` by default.
Each note displays artifact identity, sources, evidence, confidence, model,
policy versions, and display-only approve/reject/defer checkboxes.

Dry-run returns the complete Markdown plan without creating a directory.
Traversal, absolute output paths, source-folder overlap, and symlink output
paths are rejected. The exporter never writes under the configured source
folder.

## Manual Review Import

`importManualReviewDecisions()` reads the three checkboxes in each
`ai-review/*.md` file. Exactly one checked outcome is accepted; unchecked notes
are skipped and multiple checks are rejected.

The importer verifies `artifactId`, filename, and `artifactHash` against the
audit store. Dry-run plans decisions without writes. Write mode creates an
append-only `ReviewDecision` and changes artifact status only through
`JsonAuditStore.applyReviewDecision()`. Reviewer identity, reason, and decision
time are mandatory. Source Markdown is never modified.

## NVIDIA NIM Review Workflow

The NVIDIA NIM review workflow provides safe, reliable artifact review using
NVIDIA's OpenAI-compatible API. It validates all JSON responses before use,
enabling integration with external AI providers.

### Setup

1. Create a local `.env` file with credentials. Do not commit this file:
   ```text
   Set NVIDIA_API_KEY to your NVIDIA API key.
   Set NVIDIA_MODEL to the NVIDIA model id, for example nvidia/meta-llama-3.1-405b-instruct.
   ```

2. Verify type safety and tests:
   ```bash
   npm run typecheck
   npm test
   ```

### Single-File Review

Review a single artifact and display the NVIDIA NIM decision:

```bash
npm run review:nvidia -- /path/to/artifact.md
```

Output includes decision (approve/needs_review/reject), confidence level, and
validation details.

### Batch Review

Process multiple artifacts with rate-limiting (1 second between API calls):

```bash
npm run review:nvidia:batch -- file1.md file2.md file3.md
```

Relative paths are resolved from the current working directory. Absolute paths
are also supported.

Save batch results as JSONL for downstream aggregation or filtering:

```bash
npm run review:nvidia:batch -- --out reviews.jsonl test/fixtures/nvidia-nim/*.md
```

Each JSONL line is one review result. Both successful reviews and failed file
reviews are written so follow-up tooling can account for every input.

Output includes:
- Per-file decisions with confidence levels
- Summary statistics (total/approved/needs_review/rejected/failed)
- Detailed JSON results for downstream processing
- Optional JSONL export via `--out`

### JSONL Import

Read `reviews.jsonl` and aggregate decisions for downstream tooling:

```bash
npm run review:import -- reviews.jsonl
```

Filter by decision for minimal follow-up processing:

```bash
npm run review:import -- --only needs_review reviews.jsonl
npm run review:import -- --only reject reviews.jsonl
```

Output includes summary counts and failure handling. Broken JSON lines are
treated as failed review records so they are visible during import.

### Validation

The validator (`src/nvidia-nim-validator.ts`) ensures NVIDIA NIM responses are
safe before use:

- Extracts valid JSON from API response text
- Validates required fields: `decision`, `reason`, `suggestedTitle`,
  `riskNotes[]`, `confidence`
- Type-checks field values:
  - `decision`: one of `approve` | `needs_review` | `reject`
  - `confidence`: one of `low` | `medium` | `high`
  - `reason`: non-empty string
  - `suggestedTitle`: string; may be empty when no storage title is suggested
  - `riskNotes`: string array (required for `needs_review` decisions)
- Throws descriptive errors on validation failure

### Testing

- Unit tests: 37 tests covering all validator functions and edge cases
- E2E tests: 9 tests validating batch review workflow with mock data

```bash
npm test
```

### Security

- `.env` is ignored in `.gitignore`; credentials are never committed
- Validator functions are pure (no side effects)
- Error messages do not leak sensitive data
- Batch processing respects API rate limits

### Notes

- NVIDIA NIM integration is a manual CLI workflow; not required in CI/CD
- Suitable for code reviewer guidance and artifact validation
- All validation occurs before output to prevent partial data exposure

## Source Documents

- `../ai-derived-artifact.schema.md`
- `../ai-derived-artifact.state-transition-tests.md`
