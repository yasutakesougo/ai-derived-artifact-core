# NVIDIA NIM Apply Bridge Payload

Input: INPUT_PATH_PLACEHOLDER

## Summary
- Total: 8
- Approved: 4
- Failed: 2

## Apply Payload Items

| artifactId | path | suggestedTitle | labels | reason |
| --- | --- | --- | --- | --- |
| artifact-a | fixture-a.md | Artifact Alpha | gold, high-confidence | Looks consistent with policy |
| artifact-c | fixture-c.md |  | safe | Auto-approved by model |
| artifact-d | fixture-d.md |  |  | No title suggestion |
| artifact-g | fixture-g.md |  |  |  |

## Failed lines
- line 5: Unknown parse failure
- line 7: Unterminated string in JSON at position 15
  - raw: {"bad-json-line
