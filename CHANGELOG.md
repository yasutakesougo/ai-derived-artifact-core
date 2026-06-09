# Changelog

## v0.4.1 - NVIDIA NIM apply-approved write guard hardening (docs + tests, no-write)

### Added

- Added write-guard tests for apply-approved commands to keep `--write` rejected:
  - `review:apply-approved-dry-run`
  - `review:apply-approved-validate`
  - `review:apply-approved-preview`
- Added pre-write design hardening docs for:
  - path allowlist contract
  - lineage/checksum verification contract
  - explicit write guard ruleset for future `--write`

### Not Included

- 実装は行わない（`--write` 未実装のまま）。
- 実ファイル更新 / records 書き込みなし。

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.4.0 - NVIDIA NIM apply-approved write acceptance criteria (pre-write, docs-only)

### Added

- Added pre-write acceptance criteria for future `apply-approved` write integration:
  - required v0.3.5 preview runbook completion
  - validated plan requirement (`review:apply-approved-validate` success only)
  - preview and plan output reconciliation
  - summary/warning gate checks
  - path allowlist and checksum/lineage checks
  - partial-apply prohibition and all-or-nothing failure semantics

### Not Included

- 実装は行わない（`--write` 未実装のまま）。
- 実ファイル更新／records 書き込みなし。

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.3.5 - NVIDIA NIM apply-approved preview runbook

### Added

- Added a dedicated runbook for `review:apply-approved-preview` pre-apply checks:
  - mandatory output verification points
  - warning / summary-mismatch validation
  - side-effect guard confirmation (`--write` rejected)
  - safe capture guidance for audit/review handoff

### Not Included

- `--write` mode / real file updates.
- `records` updates / source-note writes.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.3.4 - NVIDIA NIM apply-approved preview hardening

### Added

- Hardened `review:apply-approved-preview` output for preview usability:
  - Added explicit candidate section header.
  - Preserved warning output even when no approved candidates are present.
  - Added warning when `summary.approved` does not match rendered item count.
- Added fixture-backed output hardening cases:
  - empty approved candidate payload (warnings-only preview),
  - preview command option guard (`--write` rejected),
  - summary mismatch warning behavior.

### Not Included

- `--write` mode / real file updates.
- records / real source-note updates.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.3.3 - NVIDIA NIM apply-approved preview connection

### Added

- Added `review:apply-approved-preview` CLI to connect validated apply-approved plan
  payloads to a preview phase before write path integration.
- Reused `review:apply-approved-validate` parsing to ensure schema compatibility.
- Added preview summary output and per-item display:
  - `artifactId`
  - `path`
  - `suggestedTitle`
  - `labels`
  - `reason`
- Added warning output when payload `warnings[]` contains entries.
- Added fixture-based tests for parse, successful preview rendering, warning output,
  and invalid schema failure.

### Not Included

- `--write` mode.
- records / real source-note updates.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.3.2 - NVIDIA NIM apply-approved-plan validation

### Added

- Added `review:apply-approved-validate` CLI to validate
  `review:apply-approved-dry-run --json --out` payloads.
- Added schema checks for:
  - `schemaVersion`
  - `generatedAt`, `inputPath`
  - `summary.total`, `summary.approved`, `summary.warnings`
  - `items[]` required fields:
    - `artifactId`
    - `path`
    - `suggestedTitle`
    - `labels`
    - `reason`
  - `warnings[]` required fields:
    - `type`, `line`, `message` (and optional `raw`)
- Added regression tests for valid plan schema and common invalid cases.

### Not Included

- `--write` mode.
- records / real source-note updates.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.3.1 - NVIDIA NIM apply-approved-dry-run plan schema

### Added

- Added `--json` / `--out` support to `review:apply-approved-dry-run`.
- Fixed output schema for downstream plan handoff:
  - `schemaVersion`
  - `generatedAt`
  - `inputPath`
  - `summary`
  - `items[]`
  - `warnings[]`
- Added fixture-based JSON snapshot assertion for plan file output.
- Kept no `--write` mode; output remains preview only.

### Not Included

- records / real source-note updates.
- `apply-approved-review` write mode.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.3.0 - NVIDIA NIM Review Apply Approved Dry-Run Bridge

### Added

- Added `review:apply-approved-dry-run` CLI to connect validated
  `apply-dry-run` payloads to a preview plan flow suitable for
  `apply-approved-review` handoff.
- Reused `review:apply-validate` payload parsing for strict compatibility
  checks (`schemaVersion`, `summary`, `items`, and `failed`).
- Added approved-only filtering for plan rendering when decision metadata is
  present in payload items.
- Added warning output for failed payload rows and summary/plan mismatch
  visibility.
- Added regression tests for:
  - path argument parsing
  - plan output from fixture payload
  - non-approved item filtering
  - invalid JSON handling

### Not Included

- `--write` mode.
- Records / real source-note updates.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.9 - NVIDIA NIM Review Apply Validation

### Added

- Added `review:apply-validate` CLI to validate `review:apply-dry-run` JSON payloads
  before downstream apply wiring.
- Added schema checks for:
  - `schemaVersion`
  - `summary`
  - `items[]`
  - `failed[]`
  - `items[*]` required fields: `artifactId`, `path`, `suggestedTitle`, `labels`,
    `reason`
  - `failed[*]` required fields: `line`, `error`
- Added fixture-based tests for success and common schema-invalid cases.

### Not Included

- `--write` mode.
- 実ファイル / records 反映。

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.10 - NVIDIA NIM Review Apply Receive

### Added

- Added `review:apply-receive` CLI to connect validated dry-run payloads to a
  lightweight receive flow.
- Reused `review:apply-validate`-style validation to accept only compatible
  payloads.
- Added stdout reporting of apply candidates (`artifactId`, `path`,
  `suggestedTitle`, `labels`, `reason`).
- Added warning output when `failed[]` rows are present.
- Did not add real write/apply behavior (no `--write` yet).

### Not Included

- records / real source-file updates.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.8 - NVIDIA NIM Review Apply Dry-Run (schema stabilization)

### Changed

- Stabilized `review:apply-dry-run` JSON schema by adding:
  - `schemaVersion`
  - `generatedAt`
  - fixed top-level `summary`, `items`, and `failed` shape
- Added fixture-based schema comparison for `--json --out` output.

### Not Included

- `--write` mode.
- apply to real files or records.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.7 - NVIDIA NIM Review Apply Dry-Run (bridge validation)

### Added

- Added `review:apply-dry-run` CLI to connect bridge payloads to
  `apply-approved-review`-style plan preview.
- Added support for both `apply-bridge` payload JSON and `reviews.jsonl` inputs.
- Added fixture-based dry-run coverage for approved-only extraction and missing-value
  stability.
- Added `--json` and `--out` outputs for downstream automation and human review.

### Not Included

- `--write` mode.
- `apply-approved-review.ts` direct invocation.
- Records persistence or real source-note updates.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.6 - NVIDIA NIM Review Apply Bridge (dry-run payload)

### Added

- Added `review:apply-bridge` CLI to generate dry-run bridge payloads from
  `reviews.jsonl`.
- Added `--json` mode and `--out` support for fixture-backed payload generation.
- Added payload shape including `artifactId`, `path`, `suggestedTitle`, `labels`,
  `reason`, and failure metadata for future `apply-approved-review` bridge wiring.
- Added fixture-driven tests for JSON and Markdown output snapshots.

### Not Included

- Runtime `apply` / `--write` mode.
- Direct integration with `apply-approved-review.ts`.
- records persistence or real source-note updates.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.5 - NVIDIA NIM Review Apply Plan (fixture validation)

### Added

- Added fixture-driven `NVIDIA NIM review apply-plan` regression coverage under
  `test/fixtures/nvidia-nim`.
- Added fixed mixed-decision JSONL fixture (`approve/needs_review/reject/failed`)
  covering missing `suggestedTitle`, `labels`, and `reason` cases.
- Added markdown snapshot-style assertion for `--out` report output.

### Not Included

- Runtime write mode.
- Production `apply`/`records` integration.
- Human review UI integration.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.4 - NVIDIA NIM Review Apply Plan (minimal)

### Added

- Added `review:apply-plan` CLI as a dry-run plan generator for approved review results.
- Added `--out` option to output the approved-only plan as Markdown.
- Added extraction of `artifactId`, `path`, `suggestedTitle`, `labels`, and `reason` from `reviews.jsonl` for each approved record.
- Added parsing and rendering helper coverage for argument handling and markdown output.

### Not Included

- `--write` mode.
- Records persistence integration.
- Human review UI integration.
- Real NVIDIA NIM API calls.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.3 - NVIDIA NIM Review Report (minimal)

### Added

- Added `review:report` CLI to generate Markdown reports from `reviews.jsonl`.
- Added report output with summary counts, failed rows, and needs_review/reject
  candidate tables.
- Added report generation regression coverage (argument parsing and file output).

### Not Included

- `apply-approved-review.ts` integration.
- JSONL filter CLI changes.
- Records persistence integration.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.2 - NVIDIA NIM Review Aggregate (minimal)

### Added

- Added `review:aggregate` CLI to produce audit-oriented summaries from
  `reviews.jsonl`.
- Added summary counts: total / approve / needs_review / reject / failed.
- Added failed-record listing including line number and parse error details.
- Added needs_review and reject candidate extraction with artifactId/path/classification/reason.
- Added regression coverage for aggregate parsing and output shape.

### Not Included

- Markdown report generation.
- Automatic apply flow.
- Records persistence integration.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.1 - NVIDIA NIM Review Import (JSONL)

### Added

- Added `review:import` CLI to read NVIDIA NIM `reviews.jsonl`.
- Added 1-line JSON parser with failure handling for invalid JSON rows.
- Added decision aggregation output (`approve`, `needs_review`, `reject`, `failed`).
- Added `--only` filter for `needs_review` and `reject` (and `approve`) extraction.
- Added regression coverage for parse/aggregate and filtered CLI output.

### Not Included

- Production `records/` integration.
- Automatic review apply flow.
- Human review UI or LLM re-scoring.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.2.0 - NVIDIA NIM Batch Review JSONL Export

### Added

- Added `--out` support to `review:nvidia:batch` for writing batch review
  results as JSONL.
- JSONL export writes one JSON object per line and includes both successful
  reviews and failed file results.
- Added regression coverage for `--out` argument parsing, JSONL formatting, and
  failed-result export without calling the NVIDIA NIM API.
- README usage notes for JSONL export.

### Not Included

- Markdown report export.
- Decision filter CLI.
- `apply-approved-review.ts` integration.
- Production `records/` integration or real data ingestion.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.1.1 - NVIDIA NIM Review Workflow Operations Fixes

### Fixed

- Fixed NVIDIA NIM batch review relative path handling so paths such as
  `test/fixtures/nvidia-nim/*.md` resolve from the current working directory
  instead of being misread as `/fixtures/...`.
- Aligned `suggestedTitle` documentation with the validator and prompts:
  the field is required, but the value may be an empty string when no storage
  title is suggested.

### Added

- Regression tests for NVIDIA NIM review path resolution.
- README notes for relative and absolute path support in batch review.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`

## v0.1.0 - NVIDIA NIM Review Workflow v0

This release marks the first stable baseline for the NVIDIA NIM artifact review
workflow and public repository safety posture.

### Added

- NVIDIA NIM artifact review probe for validating local API configuration before
  running review workflows.
- Single-file NVIDIA NIM review CLI for reviewing one artifact and returning a
  validated review decision.
- Batch NVIDIA NIM review CLI for processing multiple artifacts with controlled
  rate limiting and summary output.
- JSON validation module for extracting, validating, and normalizing NVIDIA NIM
  review responses before use.
- Unit tests and E2E tests covering validator behavior, single-file review, and
  batch review workflows.
- README usage guide for setup, single-file review, batch review, validation,
  testing, and security notes.
- GitHub Actions CI for dependency installation, safety checks, type checking,
  and tests.
- Public repository safety check to prevent tracked `.env` files, `records/`
  data, NVIDIA API key patterns, private keys, and related credential material
  from entering the public repository.

### Safety

- NVIDIA NIM API calls remain manual CLI operations and are not executed in CI.
- Runtime credentials are documented without committing real `.env` values.
- `records/` is ignored and removed from tracked files so local audit data can
  remain local.

### Verification

- `npm run check:safety`
- `npm run typecheck`
- `npm test`
