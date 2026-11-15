# heal — PASSED
| Field | Value |
|---|---|
| Application | Bulletproof React (react-vite app) (`bulletproof-react`) |
| URL | http://localhost:3000 |
| Objective | Register a new user who creates a new team and verify they land on the dashboard showing a welcome message |
| Execution mode | heal |
| Test | register-new-who-creates-new-team-they-land (v2) |
| Reused existing test | yes (test-id) |
| Total duration (measured) | 77.0s |
| Playwright execution (measured) | 10.4s |
| Agent time (measured) | 44.4s |
| AI invocations | 1 |
| Tokens (measured, SDK-reported) | 85077 total (in 83418, out 1659, cache read 79040) |
| Cost | not reported (getUsage() unavailable (feature_unavailable)); no estimate is made |
| Self-healing attempted | yes — repaired after 1 attempt(s) |
| Started | 2026-11-12T14:13:07.059Z |

## Self-healing
- Classification: locator-change
- Diagnosis: Registration still works; the primary submit control’s accessible name changed from "Register" to "Create account", so getByRole('button', { name: 'Register' }) never matched and the click timed out.
- Change: getByRole('button', { name: 'Register' }) -> getByRole('button', { name: 'Create account' })
- Original preserved for rollback: `_history\bulletproof-react.register-new-who-creates-new-team-they-land.v1.spec.ts`

## Agent invocations
| Kind | Status | Model | Duration | Session | Resumed | Tools | Tokens |
|---|---|---|---|---|---|---|---|
| repair-test | succeeded | composer-2.5 | 44.4s | `agent-8e78c0d7-ae09-492b-a864-6d4b4b715f2e` | true | explore_page×2, run_candidate_test×1, submit_repair×1 | 85077 |

## Notes
- Original failure before healing: TimeoutError: locator.click: Timeout 10000ms exceeded.
- Deterministic pre-classification: possible-ui-change
