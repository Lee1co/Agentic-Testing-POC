# Agentic UI Testing POC

A generic, self-learning, business-aware agentic UI testing framework built on the official
[Cursor SDK](https://www.npmjs.com/package/@cursor/sdk) (`@cursor/sdk` 1.3.1, local runtime) and Playwright.

- An AI agent explores a web application through framework-owned tools and writes a Playwright test for an objective
  or a business requirement.
- The test is stored, versioned and **re-executed without AI** on every later request.
- When a UI change breaks a previously passing test, the agent repairs it under guardrails (bounded attempts,
  assertions preserved, verified by a real run, original archived). Regressions and business defects are reported, not "healed".
- Business requirements are injected as untrusted context and traced to tests (`satisfied` / `violated` / `inconclusive`).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [POC_RESULTS.md](POC_RESULTS.md) for the measured results of the live runs.

## Repository layout

```
Agentic-Testing-POC/
├── testing-agent/            the framework (TypeScript, Node)
│   ├── src/                  agents, orchestrator, browser, generator, healing, knowledge, business-knowledge, reporting, config, cli.ts
│   ├── app-profiles/         per-application profile (description, test-data strategy)
│   ├── business-context/     per-application requirements (JSON) and domain notes (Markdown)
│   ├── generated-tests/      generated Playwright tests (+ _history/ archived versions, _candidates/ healing candidates)
│   ├── knowledge/            per-application JSON knowledge (tests, executions, healing, sessions, traceability)
│   ├── reports/              per-command JSON/Markdown reports and summaries
│   └── tests/                unit and integration tests (Vitest)
├── target-app/               application under test: vendored alan2207/bulletproof-react (pinned commit on main)
├── ARCHITECTURE.md
└── POC_RESULTS.md
```

## Target application

[alan2207/bulletproof-react](https://github.com/alan2207/bulletproof-react) (MIT), app `apps/react-vite`, commit
`9506629ed003a561c6627735480cce4994244bb4`. Chosen because it is a widely used open-source React app with real flows
(registration, roles, discussions, comments, admin-only pages) and an in-browser mock API (MSW), so it runs fully locally,
needs no credentials and every browser context starts with an empty database.

## Setup

Prerequisites: Node.js 20+ (tested with 24.19), git, a Cursor API key.

```powershell
# 1. Target application
git clone https://github.com/alan2207/bulletproof-react target-app
git -C target-app checkout 9506629ed003a561c6627735480cce4994244bb4
cd target-app/apps/react-vite
copy .env.example .env            # mock API enabled, no secrets
npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --replace-registry-host=always --registry=https://registry.npmjs.org/
npx vite --port 3000 --strictPort # keep running

# 2. Framework
cd ../../../testing-agent
npm install
npm run browsers                  # playwright install chromium
copy .env.example .env            # then set CURSOR_API_KEY in .env (never commit it)
npm run agent -- doctor           # validates config, redacts the key, checks the app is reachable
```

The upstream project uses Yarn; in this environment Yarn failed on a TLS-intercepting proxy and the upstream `yarn.lock`
pins one package to `registry.npmmirror.com`, so dependencies were installed with npm against the public registry
(`--replace-registry-host=always`). Application source and behaviour are unchanged by this.

## CLI

All commands: `npm run agent -- <command> [options]` (global option `--app <appId>`, default from `APP_ID`).

| Command | Purpose |
|---|---|
| `explore --url <url> --task "<objective>"` | Discover the app with the agent and generate a test for the objective (reuses an existing match unless `--force`). |
| `generate --task "<objective>"` / `generate --requirement REQ-001` | Generate a test (exploratory or business-aware). |
| `run --task "<objective>"` / `--test <id>` / `--requirement <id>` / `--all` | Reuse-first execution; heals on locator-type failures unless `--no-heal`. |
| `heal --test <id>` | Run the test and, if it fails, attempt a guarded repair. |
| `report` | Aggregated summary from persisted knowledge (`reports/summary-<appId>.json/.md`). |
| `requirements [--requirement <id> \| --task <text>]` | Show business context the provider returns. |
| `models` | List models available to the API key. |
| `doctor` | Show the effective (redacted) configuration and check the target app. |

Exit codes: `0` passed, `1` failed, business defect or other error, `2` invalid configuration.

## Quality checks

```powershell
cd testing-agent
npm run typecheck   # framework + generated tests (separate tsconfig for Playwright-style imports)
npm run lint
npm test            # unit + integration (integration tests start a local fixture app and a real Chromium; no AI calls)
```

Integration tests use a scripted `AgentProvider` test double, so they are deterministic and never call the Cursor API.
The live AI runs are documented in [POC_RESULTS.md](POC_RESULTS.md).

## Configuration (`testing-agent/.env`)

| Variable | Default | Meaning |
|---|---|---|
| `CURSOR_API_KEY` | - | Required for `explore`/`generate`/`heal`. Never logged. |
| `AGENT_PROVIDER` | `cursor` | `cursor` or `external` (prepared, not implemented). |
| `AGENT_MODEL` | `composer-2.5` | Model id (see `models`). |
| `AGENT_TIMEOUT_MS` / `AGENT_MAX_RETRIES` / `MAX_AGENT_INVOCATIONS` | 600000 / 1 / 4 | Bounds per agent run and per command. |
| `APP_ID` / `TARGET_APP_URL` / `ALLOWED_HOSTS` | `bulletproof-react` / `http://localhost:3000` / `localhost,127.0.0.1` | Target and host allowlist (the URL must be in the allowlist). |
| `MAX_HEALING_ATTEMPTS` | 2 | Repair attempts per heal. |
| `TEST_TIMEOUT_MS` / `HEADLESS` | 60000 / true | Playwright settings. |

## Adding another application

1. Add `testing-agent/app-profiles/<appId>.json` (name, description, test-data strategy).
2. Optionally add `testing-agent/business-context/<appId>/requirements.json` and Markdown notes.
3. Set `APP_ID`, `TARGET_APP_URL` and `ALLOWED_HOSTS`. No framework code is application-specific.
