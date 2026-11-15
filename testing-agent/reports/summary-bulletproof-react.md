# Agentic testing summary — Bulletproof React (react-vite app)

Generated 2026-11-12T14:53:22.063Z. All numbers are measured from persisted records.

## Tests
| Test | Version | Kind | Status | Requirements | Last run |
|---|---|---|---|---|---|
| register-new-who-creates-new-team-they-land | v2 | exploratory | active | - | passed @ 2026-11-12T14:15:04.143Z |
| req-001-only-team-administrators-may-start-new | v1 | business | business-defect | REQ-001 | failed @ 2026-11-12T14:20:54.415Z |
| req-001-only-team-administrators-may-start-new-mwdngip5 | v1 | business | needs-attention | REQ-001 | failed @ 2026-11-12T14:40:13.218Z |
| req-001-only-team-administrators-may-start-new-mwdnvqqx | v1 | business | active | REQ-001 | passed @ 2026-11-12T14:53:18.797Z |

## Executions by mode
| Mode | Runs | Passed | AI invocations |
|---|---|---|---|
| generate | 1 | 1 | 1 |
| reuse | 5 | 3 | 0 |
| heal | 1 | 1 | 1 |
| business-generate | 3 | 1 | 3 |

Agent sessions recorded: 5; total tokens (SDK-reported): 1341137.

## Healing attempts
- 2026-11-12T14:14:23.980Z register-new-who-creates-new-team-they-land attempt 1: **repaired** (locator-change) v1 → v2

## Requirement traceability
| Requirement | Acceptance criteria | Test | Result | Evaluated |
|---|---|---|---|---|
| REQ-001 | AC-1, AC-2 | req-001-only-team-administrators-may-start-new (`bulletproof-react/req-001-only-team-administrators-may-start-new.spec.ts`) | violated | 2026-11-12T14:20:54.432Z |
| REQ-001 | AC-1, AC-2 | req-001-only-team-administrators-may-start-new-mwdngip5 (`bulletproof-react/req-001-only-team-administrators-may-start-new-mwdngip5.spec.ts`) | inconclusive | 2026-11-12T14:40:13.234Z |
| REQ-001 | AC-1, AC-2 | req-001-only-team-administrators-may-start-new-mwdnvqqx (`bulletproof-react/req-001-only-team-administrators-may-start-new-mwdnvqqx.spec.ts`) | satisfied | 2026-11-12T14:53:18.807Z |
