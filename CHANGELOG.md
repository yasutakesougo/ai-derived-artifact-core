# Changelog

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
