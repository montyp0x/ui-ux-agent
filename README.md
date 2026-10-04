# UI/UX Agent

A reusable agent runner for websites and browser-based applications. Give it a URL, a user goal, a persona and observable success checks. It plans from screenshots, selects bounded interactions and records evidence for review.

The architecture adapts the planner → action selector → verified outcome loop from [minecraft-agent](https://github.com/rmalde/minecraft-agent). Application routes, selectors and credentials live in suite configuration. The engine has no dependency on example-app or another application repository.

## Quick start

Requires Node 22 or newer.

```sh
npm ci
npx playwright install chromium
npm run demo
```

The demo starts a disposable local documentation website, runs desktop and narrow-screen journeys, and produces `runs/demo-*/report.html` with screenshots, video and traces. It uses deterministic decisions and needs no credentials. It verifies browser execution and evidence capture; it does not measure model quality.

## Test a website

Create a starter suite:

```sh
npm run run -- --init suite.json \
  --url https://your-app.example \
  --success-path /pricing \
  --goal "Find the available pricing plans"
```

Review the generated configuration. Add intermediate paths the journey needs, and visible-content checks that prove the intended result. The starter's URL check alone proves arrival at a route, not correct content. The generated file is never overwritten.

Configure model credentials in the runner environment, then validate and run:

```sh
npm run run -- --suite suite.json --validate
npm run run -- --suite suite.json --video
```

`PLANNER_API_KEY` (or `OPENROUTER_API_KEY`) authenticates the screenshot-aware planner. `JEV_API_KEY` (or `TYPESAFE_API_KEY`) authenticates the Jev selector. Defaults are OpenRouter's `openai/gpt-6-astra` planner and TypeSafe's `jev-latest` selector. Override `PLANNER_MODEL`, `PLANNER_API_URL`, `SELECTOR_MODEL` and `SELECTOR_API_URL` as needed. The planner endpoint must support Chat Completions with images; the selector uses TypeSafe's v1 contract. No application-specific cloud secret lookup or protected env file is loaded.

Models receive page observations; the planner also receives screenshots. Use data permitted for processing by the configured providers. Keys remain in request headers and are not written to evidence.

## Suite configuration

Use [examples/website.json](examples/website.json) as a template. [schemas/suite.schema.json](schemas/suite.schema.json) describes all fields. [examples/example-app.json](examples/example-app.json) is one optional application example; it is never selected by default.

On October 4, 2026, three example-app staging journeys were exercised with an approved authenticated session at desktop and narrow widths. Five of six probes passed their independent checks. The narrow session probe failed when Jev selected `no_match` despite an available scroll action. These live runs used Codex in chat for screenshot planning and the real Jev HTTP selector; they do not verify the default OpenRouter planner on example-app. Interactive planning pauses are included in run durations, which are not usability timing measurements. Private evidence stays in ignored local run directories.

| Setting              | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `baseURL`            | Target website or browser application                                         |
| `browser`            | `chromium` (default), `firefox` or `webkit`                                   |
| `requiresAuth`       | Require an existing storage-state file; defaults to false                     |
| `viewports`          | Named widths/heights to run independently                                     |
| `allowedOrigins`     | Explicit additional origins the agent may navigate to                         |
| `applicationOrigins` | Backend origins whose 401 responses block the journey                         |
| `allowedRequests`    | Explicit method/origin/path rules for write requests in authorized test flows |
| `readOnlyPosts`      | Exact origin/path rules for POST-based read/search endpoints                  |
| `journeys`           | Goals, personas, starting paths, allowed paths, actions, checks and budgets   |

A journey offers visible links within its configured paths and origins. `"/"` permits the homepage only; `/docs` permits `/docs` and its descendants. Paths apply to all permitted navigation origins. Auth/logout routes, new tabs and popups are excluded. `discoverRoles` optionally enables discovery of visible, uniquely named buttons, tabs or menu items. It defaults to an empty list.

Locators support accessible roles/names, labels, placeholders, CSS selectors and test IDs. A site does not need test IDs. Configured actions support click, fill, select, check/uncheck and a bounded set of keys. Values and selectors come from reviewed suite configuration, never generated model code.

```json
{
  "kind": "fill",
  "target": { "by": "label", "value": "Search documentation" },
  "description": "Search for installation instructions",
  "value": "installation"
}
```

Checks support route patterns, visible content, any visible match, text patterns and absence. Success requires every check. The agent cannot declare its own completion. Actions and visible-content checks use the current viewport, and stale observations invalidate selections. Scrolling tracks both the document and nested containers.

GET, HEAD and OPTIONS are allowed. Other request methods are blocked unless configured explicitly. Use reviewed endpoints and disposable test data for flows that write. GET endpoints can have application-specific side effects; request filtering is not a universal application sandbox. Request routing also does not intercept WebSocket traffic, so keep live journeys limited to reviewed flows.

## Authentication and browser selection

For authenticated applications, pass an approved Playwright storage-state file for that application's origin:

```sh
npm run run -- --suite suite.json \
  --storage-state /absolute/path/to/session.json \
  --journey discover-destination --viewport desktop --video
```

The runner creates isolated contexts, reuses only the supplied session and never extracts a personal browser profile. Session material stays outside version control. Authentication capture and account setup are owned by the target application's workflow.

Override the target URL with `--url`, the engine with `--browser`, or use `--headed` for a visible test browser. Install the selected runtime with `npx playwright install firefox` or `npx playwright install webkit`. Browser integration tests and the bundled demo currently verify Chromium only; Firefox/WebKit are configurable but unverified in this checkout.

## Architecture

- `src/contracts.ts`: validated suite, action, model and result contracts.
- `src/runner.ts`: app-independent journey execution, budgets and outcomes.
- `src/drivers/types.ts`: browser-session interface.
- `src/drivers/playwright.ts` and `src/browser.ts`: browser setup, observations, candidates, scope and execution.
- `src/models.ts`: screenshot planner and TypeSafe selector adapters. The engine also accepts a custom `Models` implementation.
- `src/report.ts`: local evidence report.

`runSuite(suite, models, options)` can be called from another TypeScript project. Supply a `UIDriver` in `options.driver` to replace the browser implementation while preserving the journey engine. This version supports websites and browser applications; native desktop/mobile drivers are not implemented.

The planner refreshes on navigation, after no progress and every five steps. Jev selects from offered actions and records its probability distribution. Model UX concerns are hypotheses for human review. These are synthetic task probes, not calibrated human personas or measured human usability scores.

Two consecutive `no_match` decisions trigger a downward scroll from the offered actions, with at most two recovery attempts per journey. Recovery stops if the viewport does not advance and never selects a click or form action. Normal task and time budgets still apply. Recovery attempts appear as `selector-recovery` findings in the report and as `recovery` events in the log; their action results have `source: "recovery"`. A recovered pass still requires every independent success check and does not imply the selector succeeded unaided.

## Evidence and outcomes

Each run uses a fresh private directory under `runs/`. `--out` can choose another new directory. Existing runs are never overwritten.

Once the suite, credentials and session are supplied, the CLI executes without interactive action prompts. Use `--headed --video` to watch the browser and keep a recording. The CLI prints the live log path at startup; follow it in another terminal with `tail -f runs/<run>/events.jsonl`. Open `report.html` after completion for outcomes, screenshots, video and traces.

- `report.html`: task outcomes and evidence links.
- `events.jsonl`: observations, plans, model responses/timings, candidate probabilities, actions, console/network observations and request-policy blocks.
- `results.json`: checks, statuses and findings.
- Per journey/viewport: screenshots, Playwright trace and optional video.

Open traces locally with `npx playwright show-trace runs/<run>/<journey>-<viewport>/trace.zip`. Artifacts may contain private application data, session material and request bodies. They are ignored by Git and never automatically uploaded.

Missing auth, unauthorized responses or an unmet readiness check are `blocked`; repeated actions, no path forward or exhausted budgets are `failed`; model and infrastructure problems are `error`. A task can pass with visual or runtime findings still requiring review. Exit codes: **0** all asserted outcomes passed, **1** at least one non-passing journey, **2** configuration/startup error.

## Development

```sh
npm run typecheck
npm run schema
npm test
npm run demo
```

Tests use real Chromium against local synthetic pages with deterministic model HTTP responses. CI installs Chromium and runs these checks without model credentials. No run evidence is uploaded by CI.

Current limits: no native-app drivers, screenshot baseline comparison, complete accessibility audit, provider cost accounting or live model-quality benchmark. Browser behavior and application assumptions need validation on each target.

API references: [TypeSafe](https://docs.typesafe.ai/api), [OpenRouter](https://openrouter.ai/docs/api_reference/overview), [Playwright](https://playwright.dev/docs/intro).
