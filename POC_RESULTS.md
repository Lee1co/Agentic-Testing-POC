# POC Results

All numbers below are copied from reports produced by the framework (`testing-agent/reports/`) during live runs on
2026-11-12 against `bulletproof-react` (`apps/react-vite`, commit `9506629`) on `http://localhost:3000`, using
`@cursor/sdk` 1.3.1 (local runtime) with model `composer-2.5`. Nothing was estimated or edited by hand.

**Cost:** `agent.getUsage()` returns `feature_unavailable` for local agents, so billed cost is **not reported** in any run.
Token counts are the SDK-reported `usage` from `run.wait()`.

## Summary

| Scenario | Command | Result | AI calls | Agent time | Playwright time | Tokens (total / cache read) |
|---|---|---|---|---|---|---|
| A. Discovery + generation | `explore --url http://localhost:3000 --task "Register a new user who creates a new team and verify they land on the dashboard showing a welcome message"` | PASSED, test v1 created | 1 | 117.6 s | 10.2 s | 122,841 / 91,200 |
| B. Reuse | `run --task "<same objective>"` | PASSED, reused (exact objective) | **0** | 0 ms | 12.8 s | none |
| C1. UI change breaks test | `run --test register-new-who-creates-new-team-they-land --no-heal` | FAILED (locator timeout) | 0 | 0 ms | 20.9 s | none |
| C2. Self-healing | `heal --test register-new-who-creates-new-team-they-land` | PASSED, repaired v1 -> v2 (locator-change, 1 attempt, resumed session) | 1 | 44.4 s | 10.4 s | 85,077 / 79,040 |
| C3. Re-run healed test | `run --test register-new-who-creates-new-team-they-land` | PASSED v2 | **0** | 0 ms | 8.7 s | none |
| D1. Business-aware (first try) | `generate --requirement REQ-001` | reported BUSINESS-DEFECT, **false positive** (see below) | 1 | 263.6 s | 22.1 s | 414,074 / 380,864 |
| D2. Business-aware (guard added) | `generate --requirement REQ-001 --force` | FAILED, requirement INCONCLUSIVE (false defect rejected by the new guard) | 1 | 282.2 s | 22.9 s | 378,058 / 339,136 |
| D3. Business-aware (explorer fixed) | `generate --requirement REQ-001 --force` | PASSED, REQ-001 **SATISFIED** (AC-1, AC-2) | 1 | 249.0 s | 21.7 s | 341,087 / 317,888 |
| D4. Business reuse | `run --requirement REQ-001` | PASSED, reused (requirement id), REQ-001 SATISFIED | **0** | 0 ms | 14.9 s | none |

Totals from `reports/summary-bulletproof-react.md`: 5 agent sessions, 1,341,137 SDK-reported tokens; 5 reuse executions with 0 AI calls.

Quality gates (final state): `npm run typecheck` pass, `npm run lint` pass, `npm test` 61/61 tests in 11 files pass.

## Scenario A: discovery and generation

The agent (no shell or file tools, only `explore_page`, `run_candidate_test`, `submit_test`) made 12 explorations and 1 candidate run,
then submitted a test. The framework validated it statically, wrote it to
`testing-agent/generated-tests/bulletproof-react/register-new-who-creates-new-team-they-land.spec.ts` and executed it
independently: it passed. It uses role/label locators only, unique data (`Date.now()` suffix) and 4 assertions
(Dashboard heading, URL `/app`, `Welcome Test Founder`, `Your role is : ADMIN`).

## Scenario B: reuse without AI

The same objective was matched deterministically (`exact-objective`) in `knowledge/bulletproof-react/tests.json` and the stored
spec was executed directly: 0 AI invocations, 0 tokens, 14.0 s total versus 129.8 s for generation.

## Scenario C: controlled UI change and self-healing

**Change made to the target app** (`apps/react-vite/src/features/auth/components/register-form.tsx`): the submit button label
`Register` -> `Create account`. Behaviour is unchanged; only the accessible name differs. This change is still present
in `target-app` (revert with `git -C target-app checkout -- apps/react-vite/src/features/auth/components/register-form.tsx`;
the v2 test then needs healing back, which is the expected behaviour).

1. C1: the stored v1 test failed with `TimeoutError: locator.click: Timeout 10000ms exceeded` on
   `getByRole('button', { name: 'Register' })`.
2. C2: `heal` re-ran the test, pre-classified the failure as `possible-ui-change` (locator wait + timeout signals), then resumed the generating agent session (`Agent.resume`, session `agent-8e78c0d7-...`), the agent
   explored twice, ran 1 candidate, classified the failure `locator-change` and submitted a repair. The candidate passed the
   assertion-preservation guard and a real run; v1 was archived to
   `generated-tests/_history/bulletproof-react.register-new-who-creates-new-team-they-land.v1.spec.ts`.
3. The complete code diff between v1 and v2 (besides the header version/provenance lines) is one line:

   ```diff
   -    await page.getByRole('button', { name: 'Register' }).click();
   +    await page.getByRole('button', { name: 'Create account' }).click();
   ```

   All 4 assertions are byte-for-byte identical.
4. C3: v2 re-executed with 0 AI calls and passed.

The regression path (a functional break must not be healed) was exercised in integration tests against a local fixture app
(`tests/integration/reuse-and-healing.test.ts`): the test is left untouched and marked `needs-attention`.

## Scenario D: business-aware test (REQ-001)

REQ-001 (`business-context/bulletproof-react/requirements.json`): only team admins may create discussions.
AC-1: a USER member sees Discussions without a "Create Discussion" action. AC-2: the ADMIN sees it.

### D1: a false business defect (and what was changed)

The first run reported **REQ-001 violated**. Investigation showed the application was right and the test was wrong:

- The agent's test registered the "member" with the *Join Existing Team* switch on but typed the team name into the
  *Team Name* textbox. In this app, switching on *Join Existing Team* replaces that textbox with a *Team* combobox
  once the team list has loaded (the mock API adds a 300-1000 ms delay). Without a `teamId` the mock API creates a new team,
  so the "member" became an ADMIN and the setup assertion `Your role is : USER` failed.
- The agent concluded that "join-registration assigns ADMIN", and the framework accepted that verdict because the
  test failed and the agent said behaviour contradicted the requirement.

Root causes in the framework, both fixed:

1. **Explorer snapshot taken too early.** `networkidle` does not account for responses served by the MSW service worker, so the
   agent's snapshot after toggling the switch still showed the textbox. `PageExplorer` now re-reads the accessibility snapshot
   until it is unchanged for 1.5 s (max 6 s). Verified with a probe: the snapshot now shows `combobox "Team"`.
2. **Defect verdicts were not evidence-checked.** A business defect is now accepted only if the independent run fails inside a
   `test.step` whose title names an acceptance criterion (`AC-n`). Failures in setup steps yield `inconclusive` and
   `needs-attention`. Unit tests cover this (`tests/unit/test-code.test.ts`). The prompt also tells the agent this rule.

D2 (guard only) showed the guard working: the agent again claimed a defect from a setup failure; the framework rejected it and
recorded REQ-001 as `inconclusive`. D3 (explorer fix) produced a correct test: the member joins via the Team combobox, the
USER role is asserted, then AC-1 (`Create Discussion` not visible for USER) and AC-2 (visible for ADMIN) are asserted
exactly as written. It passed and REQ-001 was recorded `satisfied`; D4 reused it with 0 AI calls.

The D1 and D2 tests and their traceability rows are kept as evidence (statuses `business-defect` and `needs-attention`).
The test matcher prefers the active test, so `run --requirement REQ-001` uses the D3 test. The correct-defect path
(behaviour really diverging from the requirement inside an AC step) is covered by
`tests/integration/business-aware-generation.test.ts`.

## Reuse: what is and is not reused

| Kind | Observed in this POC |
|---|---|
| Test reuse | B, C3 and D4: stored specs executed with 0 AI calls and 0 tokens. |
| Metadata reuse | Verified locators, page observations, execution/healing history and traceability persisted in `knowledge/bulletproof-react/*.json`; used for lookups and healing context. |
| Conversation context | C2 resumed the session that generated the test (`Resumed: true` for session `agent-8e78c0d7-...` in the heal report). |
| LLM prompt caching | Provider-side; visible only as `cacheReadTokens` (e.g. 79,040 of 85,077 tokens in C2). Not controlled by the framework and not the same as test reuse. |

## Limitations and deviations

- Billed cost unavailable from the local SDK runtime (`getUsage()` -> `feature_unavailable`); no estimate is made.
- No native structured output in the SDK; a Zod-validated submit tool is used instead.
- Business-aware generation is expensive here (~250-280 s and 340-414k tokens per attempt), mostly exploration of multi-persona flows.
- `--force` creates a new test id instead of replacing the old test; there is no command to retire superseded tests yet.
- The target app's dependencies were installed with npm instead of Yarn because of the TLS proxy and an `npmmirror` entry in the
  upstream lockfile (`yarn.lock` shows as modified from the failed Yarn attempt; application source is untouched apart from the
  Scenario C label change).
- One model (`composer-2.5`) and one application were exercised live; `ExternalModelProvider` is an interface stub only.
- The REQ-001 test relies on the Team combobox's default selection, which is valid because each test's browser context
  starts with an empty mock database containing only the admin's team.
