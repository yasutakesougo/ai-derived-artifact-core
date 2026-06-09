# Changelog

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
