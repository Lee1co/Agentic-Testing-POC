# generate — PASSED
| Field | Value |
|---|---|
| Application | Bulletproof React (react-vite app) (`bulletproof-react`) |
| URL | http://localhost:3000 |
| Objective | Register a new user who creates a new team and verify they land on the dashboard showing a welcome message |
| Execution mode | generate |
| Test | register-new-who-creates-new-team-they-land (v1) |
| Reused existing test | no |
| Total duration (measured) | 129.8s |
| Playwright execution (measured) | 10.2s |
| Agent time (measured) | 117.6s |
| AI invocations | 1 |
| Tokens (measured, SDK-reported) | 122841 total (in 119785, out 3056, cache read 91200) |
| Cost | not reported (getUsage() unavailable (feature_unavailable)); no estimate is made |
| Self-healing attempted | no |
| Started | 2026-11-12T14:06:46.649Z |

## Agent invocations
| Kind | Status | Model | Duration | Session | Resumed | Tools | Tokens |
|---|---|---|---|---|---|---|---|
| generate-test | succeeded | composer-2.5 | 117.6s | `agent-8e78c0d7-ae09-492b-a864-6d4b4b715f2e` | false | explore_page×12, run_candidate_test×1, submit_test×1 | 122841 |

## Notes
- Related business requirements injected for awareness: REQ-001, REQ-002
- Agent rationale: Exploration showed registration at /auth/register with labeled fields and a Team Name field when not joining an existing team (Join Existing Team switch off by default). Successful registration navigates to /app with headings Dashboard, Welcome {firstName} {lastName}, and ADMIN role. The test generates unique email and team name, completes registration, and asserts URL plus welcome and admin role headings to prove the objective.
