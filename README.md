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

### JSONL Aggregate

Aggregate `reviews.jsonl` into an audit-friendly summary for manual review:

```bash
npm run review:aggregate -- reviews.jsonl
```

Output includes:

- summary: total / approve / needs_review / reject / failed
- failed rows with line numbers and parse errors
- extracted needs_review and reject candidates with artifactId/path/classification/reason

No NVIDIA API calls are executed.

### JSONL Report

Generate a human-reviewable Markdown report from `reviews.jsonl`:

```bash
npm run review:report -- --out review-report.md reviews.jsonl
```

The generated report includes:

- Summary: total / approve / needs_review / reject / failed
- Failed rows with line numbers and parse errors
- Needs Review and Reject candidate lists with artifactId/path/classification/reason

No NVIDIA API calls are executed.

### Apply Plan (Dry Run)

Generate a dry-run plan of only `approve` items for human confirmation:

```bash
npm run review:apply-plan -- reviews.jsonl
```

Optionally export the plan as Markdown:

```bash
npm run review:apply-plan -- --out apply-plan.md reviews.jsonl
```

Output includes:

- `artifactId`
- `path`
- `suggestedTitle`
- `labels`
- `reason`

No writes are performed; this is preview only and does not apply any file or record updates.
No NVIDIA API calls are executed.
`test/fixtures/nvidia-nim/reviews-apply-plan.jsonl` provides a fixed fixture input
for this verification path.

### Apply Bridge (Dry Run Payload)

Generate a dry-run payload that can be fed to a future `apply-approved-review` bridge:

```bash
npm run review:apply-bridge -- --json test/fixtures/nvidia-nim/reviews-apply-plan.jsonl
```

Export payload for integration workflows:

```bash
npm run review:apply-bridge -- --json --out apply-approved.json reviews.jsonl
```

Or export a human-friendly Markdown snapshot:

```bash
npm run review:apply-bridge -- --out apply-bridge.md reviews.jsonl
```

Payload fields:

- `artifactId`
- `path`
- `suggestedTitle`
- `labels`
- `reason`
- `summary.total`
- `summary.approved`
- `summary.failed`

No writes are performed; this is preview only and does not apply any file or
record updates.
No NVIDIA API calls are executed.

### Apply Dry-Run (Bridge Preview)

Validate which approved items would be targeted before wiring to `apply-approved-review`:

```bash
npm run review:apply-dry-run -- test/fixtures/nvidia-nim/reviews-apply-bridge.expected.json
```

Export preview as JSON for downstream tooling:

```bash
npm run review:apply-dry-run -- --json --out apply-dry-run.json reviews.jsonl
```

Export a Markdown plan for manual inspection:

```bash
npm run review:apply-dry-run -- --out apply-dry-run.md test/fixtures/nvidia-nim/reviews-apply-bridge.expected.json
```

Stable JSON output schema (`--json --out`):

- `schemaVersion`
- `generatedAt`
- `inputPath`
- `summary.total`
- `summary.approved`
- `summary.failed`
- `items[]`:
  - `artifactId`
  - `path`
  - `suggestedTitle`
  - `labels`
  - `reason`
- `failed[]`:
  - `line`
  - `error`
  - `raw` (nullable)

Output keeps:

- `artifactId`
- `path`
- `suggestedTitle`
- `labels`
- `reason`

Only approved items are included in the apply payload preview.
No records or source files are modified (dry-run only).
No NVIDIA API calls are executed.

### Apply Validate

Validate a dry-run payload before wiring to apply handling:

```bash
npm run review:apply-validate -- test/fixtures/nvidia-nim/reviews-apply-dry-run.expected.json
```

Validation checks:

- `schemaVersion === nvidia-nim-apply-dry-run/1.0`
- `summary.total / summary.approved / summary.failed`
- `items[]` required fields:
  - `artifactId`
  - `path`
  - `suggestedTitle`
  - `labels`
  - `reason`
- `failed[]` required fields:
  - `line`
  - `error`

On validation failure, it prints the cause and exits non-zero.

### Apply Receive (Preview)

Receive and preview a validated `review:apply-dry-run` payload for future
`apply-approved-review` handoff:

```bash
npm run review:apply-receive -- test/fixtures/nvidia-nim/reviews-apply-dry-run.expected.json
```

Output includes:

- payload validation summary
- candidate `artifactId`, `path`, `suggestedTitle`, `labels`, `reason`
- warning when failed rows exist

No `--write` mode, no records, and no source-note updates are performed in
this command.

### Apply Approved (Dry Run)

```bash
npm run review:apply-approved-dry-run -- --json --out apply-approved-plan.json test/fixtures/nvidia-nim/reviews-apply-dry-run.expected.json
```

Plan output (JSON) is schema-stabilized for downstream `apply-approved-review`
receivers:

```json
{
  "schemaVersion": "nvidia-nim-apply-approved-dry-run/1.0",
  "generatedAt": "2026-06-09T00:00:00.000Z",
  "inputPath": "/path/to/input.json",
  "summary": {
    "total": 8,
    "approved": 4,
    "warnings": 2
  },
  "items": [
    {
      "artifactId": "artifact-a",
      "path": "fixture-a.md",
      "suggestedTitle": "Artifact Alpha",
      "labels": ["gold", "high-confidence"],
      "reason": "Looks consistent with policy"
    }
  ],
  "warnings": [
    {
      "type": "failed-row",
      "line": 7,
      "message": "Unterminated string in JSON at position 15",
      "raw": "{\"bad-json-line"
    }
  ]
}
```

Connect a validated dry-run payload to the `apply-approved-review` plan phase
without applying any files:

```bash
npm run review:apply-approved-dry-run -- test/fixtures/nvidia-nim/reviews-apply-dry-run.expected.json
```

This command prints a dry-run plan containing only approved payload entries with:

- `artifactId`
- `path`
- `suggestedTitle`
- `labels`
- `reason`

Validation is executed first via `review:apply-validate` rules before plan output.
Failed rows are shown as warnings, and summary/plan output is shown on stdout.

No `--write` mode, no records, and no source-note updates are performed in this
command.

### Apply Approved Preview

Connect a validated apply-approved plan directly to an apply-preview flow:

```bash
npm run review:apply-approved-preview -- test/fixtures/nvidia-nim/reviews-apply-approved-plan.expected.json
```

Output includes:

- apply candidate summary
- `artifactId`, `path`, `suggestedTitle`, `labels`, `reason` for each valid item
- warnings list if `warnings[]` is present

No records, and no source-note updates are performed in this command (preview-only
execution before write-gate).

### Apply Approved Preview (Write Gated, Synthetic-Only)

In `v0.5.0`, `--write` is introduced as a gated synthetic preview export:

```bash
npm run review:apply-approved-preview -- --write --out apply-preview.md \
  --allowlist /path/to/synthetic-root \
  --expected-input-path /path/to/source.txt \
  --expected-input-hash <sha256> \
  --expected-plan-hash <sha256> \
  reviews-apply-approved-plan.expected.json
```

For `--write`, all checks must pass before the write output is produced:

- preflight checks:
  - `summary.approved` equals rendered approve candidates
  - `summary.warnings` equals rendered warnings count
  - warnings are zero
  - all item paths resolve under allowlist roots
- optional lineage checks:
  - `--expected-input-path`
  - `--expected-input-hash`
  - `--expected-plan-hash`

Failure behavior:

- On any preflight failure, output file is not written.
- Command exits non-zero.

Current behavior remains fixture/synthetic-oriented and does not apply to source
files or `records`; it is a structured write path only.

### Apply Approved Write Preflight (Gated)

Before passing a validated plan into any future write flow, run a dedicated
preflight check that enforces the gate conditions:

```bash
npm run review:apply-approved-preflight -- reviews-apply-approved-plan.expected.json

npm run review:apply-approved-preflight -- \
  --allowlist /path/to/vault/root \
  --expected-input-path /path/to/review-input.json \
  --expected-input-hash <sha256> \
  --expected-plan-hash <sha256> \
  reviews-apply-approved-plan.expected.json
```

Current preflight checks:

- `summary.approved === items.length`
- `summary.warnings === warnings.length`
- warnings must be zero (pending warnings block preflight)
- each item path resolves under allowlist roots
- failure output is emitted with bracketed codes for deterministic inspection:
  - `[SUMMARY_MISMATCH]`
  - `[SUMMARY_WARNING_MISMATCH]`
  - `[WARNINGS_BLOCKED]`
  - `[ALLOWLIST_INVALID_PATH]`
  - `[ALLOWLIST_TRAVERSAL]`
  - `[ALLOWLIST_VIOLATION]`
  - `[LINEAGE_INPUT_PATH_MISMATCH]`
  - `[LINEAGE_INPUT_READ_FAIL]`
  - `[LINEAGE_INPUT_HASH_MISMATCH]`
  - `[LINEAGE_PLAN_HASH_MISMATCH]`
- optional lineage checks:
  - planned input path equality (`--expected-input-path`)
  - input hash equality (`--expected-input-hash`)
  - full plan hash equality (`--expected-plan-hash`)

Like previous stages, no real write occurs in this step.

Example success output is now standardized as:

```text
Write preflight passed: apply-approved plan is write-ready.
Summary:
  inputPath: /path/to/input.json
  approvedCandidates: 2
  warnings: 0
  summaryApproved: 2
  summaryWarnings: 0
  planHash: <sha256>
```

`--write` remains unsupported in this phase and is rejected.

### Apply Approved Preflight Failure Interpretation Runbook

Use this runbook whenever `review:apply-approved-preflight` fails. The command is
pre-write gating only; no files are changed.

Failure code meaning and action:

- `[SUMMARY_MISMATCH]` / `[SUMMARY_WARNING_MISMATCH]`:
  - Meaning: metadata and rendered candidates/warnings disagree.
  - Confirm: regenerate plan from the same source and verify `summary.approved`,
    `summary.warnings` logic.
  - Action: fix the upstream plan generation logic, then rerun preflight.
  - Do not proceed to write-gate acceptance.

- `[WARNINGS_BLOCKED]`:
  - Meaning: there are pending warnings and write-gate is intentionally blocked.
  - Confirm: inspect each warning entry (`type`, `line`, `message`, and `raw` if
    present) in the plan JSON.
  - Required step: a human reviewer must clear or explicitly authorize skipping.
  - Do not proceed until warnings are cleared to zero.

- `[ALLOWLIST_INVALID_PATH]`:
  - Meaning: item path is missing/empty.
  - Confirm: remove or repair invalid items from upstream payload.
  - Do not proceed.

- `[ALLOWLIST_TRAVERSAL]`:
  - Meaning: path traversal token (`..`) detected.
  - Confirm: path normalization must remove traversal risk.
  - Do not proceed.

- `[ALLOWLIST_VIOLATION]`:
  - Meaning: resolved path is outside allowed roots.
  - Confirm: set correct `--allowlist` root or adjust payload paths.
  - Do not proceed until every candidate is under allowlist.

- `[LINEAGE_INPUT_PATH_MISMATCH]`:
  - Meaning: expected input path does not match plan `inputPath`.
  - Confirm: pass the exact intended `--expected-input-path` argument.
  - Do not proceed until path contract is fixed.

- `[LINEAGE_INPUT_READ_FAIL]`:
  - Meaning: input file could not be read for hash check.
  - Confirm: verify input path and file existence/permissions.
  - Do not proceed.

- `[LINEAGE_INPUT_HASH_MISMATCH]`:
  - Meaning: content hash of input differs from expected.
  - Confirm: either update expected hash to match canonical source or regenerate
    plan from the verified source file.
  - Do not proceed if input content cannot be authorized.

- `[LINEAGE_PLAN_HASH_MISMATCH]`:
  - Meaning: plan JSON content does not match expected hash.
  - Confirm: compare plan source (`--expected-plan-hash`) with the payload used in review.
  - Do not proceed unless the hash mismatch is explicitly approved in the runbook
    and recomputed plan is intentionally re-baselined.

Re-run policy:

- Re-run is allowed after fixing the underlying root cause (path, payload,
  or source input mismatch).
- Full stop and human review is required when any hash mismatch appears.
- Any failure with warnings or any allowlist mismatch requires explicit human
  acknowledgement before re-running with a stronger allowlist contract.

Warnings approval flow before `--write` (future stage):

1. Collect warning items from payload `warnings[]`.
2. Human reviewer confirms each item is acceptable, and records decision context.
3. Re-run preflight with the same allowlist and lineage parameters.
4. Proceed only when warnings are zero and all failures are resolved.

### Apply Approved Write Implementation Readiness Checklist (v0.4.5, docs-only)

Before introducing any actual write-capable `--write` path, all conditions below
must be satisfied in this order and documented in the change request:

1. **v0.4.x gate completion check**
   - `v0.4.0` acceptance criteria confirmed.
   - `v0.4.1` write guard hardening confirmed (`--write` rejected on apply-family commands).
   - `v0.4.2` preflight validator implemented and passing.
   - `v0.4.3` preflight failure/success output hardened and deterministic.
   - `v0.4.4` failure interpretation runbook established and followed.

2. **Preflight mandatory pass**
   - `npm run review:apply-approved-preflight -- ...` must succeed.
   - Failure code count must be zero.
   - If any failure code is emitted, write path is blocked until resolved.

3. **Warnings rule**
   - `warnings` in preflight input and plan summary must be zero.
   - warning-related payloads (`type`, `line`, `message`, `raw`) must be reviewed
    and signed off before any future write attempt.

4. **Allowlist rule**
   - All candidate paths must satisfy allowlist policy.
   - Any allowlist-related failure (`ALLOWLIST_*`) blocks write.

5. **Lineage rule**
   - `inputPath` contract check must pass (or be intentionally and explicitly updated).
   - `inputHash` and `planHash` checks must pass if required by the caller.
   - Any hash/input mismatch blocks write.

6. **No partial apply principle**
   - All-or-nothing semantics must remain the default when moving to write stage:
     any unresolved failure means the entire batch is rejected.

#### Go/No-go

- **Go**: all above checks pass and are recorded in the approval ticket.
- **No-go**: any one of the following is present:
  - preflight failure code
  - warning count > 0 (before explicit governance approval and resolution)
  - allowlist mismatch
  - lineage/path mismatch
  - checksum mismatch

This checklist is documentation-only for `v0.4.5`; no implementation changes,
record writes, or actual file writes are introduced in this step.

### Apply Approved Preview Runbook (Pre-apply checks)

Use this sequence before any `apply-approved-review` write integration work:

1. Validate preview input:

```bash
npm run review:apply-approved-preview -- test/fixtures/nvidia-nim/reviews-apply-approved-plan.expected.json
```

2. Confirm human-readable preview shape:

- Top summary lines are present (`Apply-approved preview`, `Total`, `Approved candidates`, `Warnings`)
- Each candidate lists:
  - `artifactId`
  - `path`
  - `suggestedTitle`
  - `labels`
  - `reason`
- Warnings are visible even when no candidates exist.

3. Confirm schema/metadata consistency:

- If printed, `summary.approved` and rendered candidate count match.
- If not matching, warning is shown and must be resolved before moving forward.
- If present, `summary.warnings` and warning count line up.

4. Confirm no write path is available:

```bash
npm run review:apply-approved-preview -- --write test/fixtures/nvidia-nim/reviews-apply-approved-plan.expected.json
```

Expected:

`Unknown option: --write` and usage output.

5. Confirm side effects:

- No changes to source notes or `records` should occur in preview mode.
- `--write` is intentionally unsupported in this stage.

6. Capture output snapshot for manual review in release notes or ticket:

```bash
npm run review:apply-approved-preview -- test/fixtures/nvidia-nim/reviews-apply-approved-plan.expected.json > preview.log
```

Record any warning count mismatches and warning item messages in review handoff.

### Apply Approved Write Acceptance Criteria (v0.4.0 precondition, docs only)

Before implementing `--write` for approved application, execution must satisfy
all acceptance criteria below. This section is documentation only and does not add
write-path implementation.

#### Mandatory pre-conditions

- `review:apply-approved-preview` runbook (v0.3.5) is completed.
- The input to write path is only a validated plan:
  - `npm run review:apply-approved-validate -- <apply-approved-plan.json>` must succeed.
  - `schemaVersion` must be exactly `nvidia-nim-apply-approved-dry-run/1.0`.
- Preview and plan outputs must be reconciled:
  - preview execution and plan content are re-run and compared for `artifactId`, `path`, `suggestedTitle`, `labels`, `reason`.
  - all rendered candidates must be present in both views in the same order or with a stable sort.

#### Gate conditions

- `summary.approved` must equal the rendered candidate count.
- Every warning in preview output must be reviewed by a human reviewer before write.
- `records` writes and source-note writes are still disallowed until `--write` is intentionally introduced in a later version.
- `--write` is not supported in this stage and must continue to return:

`Unknown option: --write`.

#### Safety envelope

- Path allowlist:
  - all apply targets must resolve under an approved vault root and must not
    contain `..`, symlink traversal, or absolute path escapes.
  - no target outside approved workspace prefixes is allowed.
- Input integrity:
  - checksum/lineage metadata of plan input is captured and compared to preview source before write.
  - if checksum or source path changes between preview and write gate, operation must abort.
- Partial apply prohibition:
  - any unresolved warning, warning-summary mismatch, checksum mismatch, or path-allowlist violation must abort the whole batch.
- Failure behavior:
  - failures are non-partial: either all items are applied or none are applied (all-or-nothing for this stage).
  - on any failure, no source note is modified and no records are written.

### Apply Approved Write Path Allowlist (v0.4.1 design hardening)

For a future `--write` implementation, candidate paths must be checked against
an allowlist before any side effect:

- Allowed roots are configured explicitly and must be validated at startup.
- Resolved candidate path must be inside one allowed root.
- Paths containing traversal segments (`..`) are rejected.
- Symlinked paths are rejected when they resolve outside allowed roots.
- Absolute paths are rejected unless they are already inside an allowed root.

The check must run before any attempt to read/write anything.

### Apply Approved Lineage / Checksum Contract (v0.4.1 design hardening)

Write-gated execution must verify lineage between preview and write:

- The exact file path and normalized content hash of the input plan used at preview
  time are persisted for comparison.
- Hash inputs include:
  - canonicalized JSON body of the preview plan
  - target `artifactId` and `path` pairs in their rendered order
- `summary` and `warnings` must be regenerated from the canonicalized input and
  re-compared before write.
- Any difference in plan hash/lineage causes immediate abort with no side effects.

### Write Guard Rules (v0.4.1 docs-only)

- `--write` remains unsupported until a dedicated change set enables it.
- Every apply-approved command (`validate` / `preview` / `approved-dry-run`) must
  return `Unknown option: --write` when passed `--write`.
- These rejections are now test-fixed and part of the acceptance gate.

### Apply Approved Plan Validation

Validate a schema-stabilized apply-approved plan JSON before passing to an
`apply-approved-review` write flow:

```bash
npm run review:apply-approved-validate -- test/fixtures/nvidia-nim/reviews-apply-approved-plan.expected.json
```

Validation checks:

- `schemaVersion === nvidia-nim-apply-approved-dry-run/1.0`
- `generatedAt` / `inputPath`
- `summary.total / summary.approved / summary.warnings`
- `items[]` required fields:
  - `artifactId`
  - `path`
  - `suggestedTitle`
  - `labels`
  - `reason`
- `warnings[]` required fields:
  - `type`
  - `line`
  - `message`
  - `raw` (optional)

On validation failure, it prints the error and exits non-zero.

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
