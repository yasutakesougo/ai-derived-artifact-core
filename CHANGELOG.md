# Changelog

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
