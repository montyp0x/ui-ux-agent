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

Models receive viewport observations: visible text and control labels, dimensions, scroll availability and positions, URL and horizontal overflow. The planner also receives a viewport screenshot. Below-the-fold, clipped and covered content is excluded from model observations; the full accessibility snapshot stays in local evidence. Control labels retain accessible names, including associated labels. Use data permitted for processing by the configured providers. Keys remain in request headers and are not written to evidence.

`scrollRegions` identifies visible scroll containers by label, bounds, parent region, position and reachable up/down wheel points. The driver samples ten points per region and reports at most twelve regions. A direction can be unavailable even when content remains, for example when an overlay or a nested panel with scroll chaining disabled intercepts every sampled point. The model chooses a candidate ID; wheel coordinates come from the driver.

Viewport filtering uses DOM geometry, ancestor clipping, modal boundaries and sampled hit tests, including open shadow roots. It is approximate; canvas content, closed shadow roots and frame interiors remain available through the planner's screenshot. Text is capped at 12,000 characters and 100 controls after scanning at most 10,000 text nodes; `textTruncated` indicates an incomplete projection.

## Suite configuration

Use [examples/website.json](examples/website.json) as a template. [schemas/suite.schema.json](schemas/suite.schema.json) describes all fields. [examples/example-app.json](examples/example-app.json) is one optional application example; it is never selected by default.

On October 4, 2026, three example-app staging journeys were exercised with an approved authenticated session at desktop and narrow widths. Five of six probes passed their independent checks. The narrow session probe failed when Jev selected `no_match` despite an available scroll action. These live runs used Codex in chat for screenshot planning and the real Jev HTTP selector; they do not verify the default OpenRouter planner on example-app. Interactive planning pauses are included in run durations, which are not usability timing measurements. Private evidence stays in ignored local run directories. Those earlier arrival-only session passes did not prove loaded content. A later narrow-session replay with explicit content readiness passed all six checks in seven actions: tabs and a captured instruction were visible in the final screenshot and recording. It still recorded a timeline HTTP 503, so an asserted content outcome is not a backend-health verdict. The updated local browser tests separately cover persistent loading, accepted empty states, unavailable content, deadline limits, unauthorized responses and loading-induced layout shifts.

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

Checks support route patterns, visible content, any visible match, text patterns and absence. `anyRendered` accepts any Playwright-visible match, including below the viewport; it proves layout presence, not that the user inspected it. Success requires every check. The agent cannot declare its own completion. Actions and visible-content checks use the current viewport, including ancestor clipping and modal boundaries. Before execution, selected controls are checked for identity, semantic state, availability and dialog context, and navigation must still match the observed URL. Unrelated page updates do not invalidate a selection. Each reachable region gets separate scroll directions, so an outer page can move independently of a nested feed. Scroll actions recheck their wheel recipient after moving the pointer, plus its position, viewport size and dialog context. Wheel gestures settle for 550ms before the next observation; waits tolerate page updates. Scrolling tracks the document, nested containers and open shadow roots.

### Content readiness

Route/page-shell checks prove arrival, not loaded content. Optionally add `contentReady` to a journey:

```json
{
  "contentReady": {
    "timeoutMs": 10000,
    "checks": [
      { "kind": "anyRendered", "target": { "by": "css", "value": ".result, .accepted-empty-state" } },
      { "kind": "notVisible", "target": { "by": "css", "value": ".loading, .error" } }
    ]
  }
}
```

After every `success` assertion passes, the runner polls content checks every 200ms, without planner calls or additional actions. Waiting is capped by `timeoutMs` (default 10s, maximum 60s) and the remaining journey duration, including after the last allowed action. A failed content deadline ends the journey rather than resuming navigation. Once content loads, the runner refreshes its observation and rechecks arrival assertions; if a layout shift moved required controls off-screen, normal navigation can continue within the remaining action/time budgets. Choose explicit positive content and scoped blockers; empty/error states are accepted only if your checks allow them. Use viewport checks when inspection matters, and `anyRendered` only for loaded-content presence. No product vocabulary or automatic loading detection is built into the engine.

`content_readiness` events record poll outcomes, elapsed time, the limiting budget and failed check definitions. Result checks list `success` followed by `contentReady.checks` once content waiting begins. Without `contentReady`, arrival-only journeys retain their narrower contract. Final screenshot capture and cleanup run after the task deadline with a separate bounded screenshot timeout; total reported duration includes them.

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
- `src/scroll.ts`: scroll-region discovery, wheel hit tests and chaining rules.
- `src/models.ts`: screenshot planner and TypeSafe selector adapters. The engine also accepts a custom `Models` implementation.
- `src/planning.ts`: semantic action signatures and bounded planner refresh rules.
- `src/report.ts`: local evidence report.

`runSuite(suite, models, options)` can be called from another TypeScript project. Supply a `UIDriver` in `options.driver` to replace the browser implementation while preserving the journey engine. This version supports websites and browser applications; native desktop/mobile drivers are not implemented.

The planner refreshes when executable action opportunities change, on full-URL navigation (including query/hash), after action errors or no progress, after `no_match`, before revisiting an already-tried action state (see Loop detection), and at most five decision steps after its last refresh. Candidate IDs, ordering and wheel hit-point movement do not count as new opportunities; unrelated background text updates alone do not force a refresh. Newly revealed menu links therefore replace an obsolete expand-menu objective before another selection. The HTTP planner receives only candidate IDs/kinds/descriptions alongside the screenshot and viewport, not executable selectors or configured values. Custom `Models.plan` implementations can consume the optional fifth `actions` argument; existing implementations can ignore it. `plan` events include `refreshReasons`. More frequent actionable changes can increase planner calls; this is a relevance policy, not a measured cost or model-quality improvement. Jev selects from offered actions and records its probability distribution. Model UX concerns are hypotheses for human review. These are synthetic task probes, not calibrated human personas or measured human usability scores.

An October 4 narrow example-app replay of the refresh policy passed six outcome/content checks in eight actions, with eight interactive Codex plans and eight real Jev selections. Sidebar and People expansion each occurred once; no action errors or scroll recovery occurred. This verifies observed refresh mechanics, not an autonomous HTTP planner or a controlled efficiency improvement. The run still recorded backend HTTP 503 findings.

Two consecutive `no_match` decisions trigger a downward scroll from the offered actions, with at most two recovery attempts per journey. Recovery stops if the viewport does not advance and never selects a click or form action. Normal task and time budgets still apply. Recovery attempts appear as `selector-recovery` findings in the report and as `recovery` events in the log; their action results have `source: "recovery"`. A recovered pass still requires every independent success check and does not imply the selector succeeded unaided.

## Loop detection

Playwright counts visits to the same action meaning and selected recipient state, including URL, control accessibility/value state or scroll position/dimensions, dialog names and current outcome-check results. Candidate IDs, object-field/candidate-array ordering and wheel hit points do not define action meaning. The third visit is rejected before another dispatch (two prior attempts in that state). Before the second visit to a state is dispatched, the runner asks the planner once more for that state (refresh reason `revisited-state`) and selects again. A toggle can change the page without changing the offered actions, for example a group that expands only out-of-scope links, so this is how the planner learns that its objective led back to a state it already tried. The replan uses one decision step and one planner call per revisited state. If the selector repeats the action anyway, it is dispatched and the third visit is still rejected. Recovery scrolls after `no_match` do not trigger it. Actions that make progress (distinct scroll positions, declared progress) never revisit and cost nothing extra. This is a bounded repetition policy, not a claim that all page changes were irrelevant. Whole-page fingerprints remain available for observations/history, but unrelated background text cannot reset recipient-based loop detection.

If a repeatable control's progress appears elsewhere—for example a Next button with an unchanged label—declare narrow progress regions in the journey:

```json
{
  "loopProgressTargets": [
    { "by": "testId", "value": "current-page-status" }
  ]
}
```

Up to ten targets are allowed. Each must match at most one element. A rendered target's accessibility snapshot (capped at 20,000 characters) participates in loop identity; missing/hidden state is recorded without text. Progress may be below the viewport. These detector snapshots stay local and are not added to HTTP model payloads; ordinary visible content remains in viewport observations. Ambiguous targets are configuration errors. Choose real progress regions, not clocks/loading animations; unconfigured external progress cannot reliably be inferred. Changed control state, changed scroll position and declared external progress distinguish legitimate repeated actions. Reversible cycles are still bounded if they revisit the same state repeatedly.

Wait actions are exempt from repetition rejection and remain limited by the normal decision/time budgets. `loop_check` events record the hashed key, visit count, limit, outcome (`dispatch`, `replan` or `rejected`), state source and number of progress targets, not raw recipient/progress snapshots. Custom drivers may implement `UISession.repeatState(action)`; return null to skip a loop check for that action. Drivers without it use the page fingerprint plus normalized action meaning, so background-noise resistance is not guaranteed. Such drivers must implement the method before accepting `loopProgressTargets`; unsupported configured progress is reported as an error rather than discarded.

The loop policy's browser regressions cover background changes, rebound candidate IDs, blocked and advancing wheels, reversible cycles, declared progress, wait completion and custom-driver capability errors. An October 4 focused example-app replay starting at Sessions passed six checks in five actions (four interactive Codex plans, five real Jev calls), with loaded instruction content inspected in screenshot/video. A separate Home replay failed when an unselected Teams link disappeared during candidate binding; see Candidate capture below. Backend 503 findings were retained. These probes are not a controlled model-quality or backend-health benchmark.

## Candidate capture

Discovery reads links, configured interactions and discovered roles through element handles, and reads each link's name, `href` and `target` in one evaluation. A removed element therefore stays the same, now detached, object instead of shifting positional reads onto its neighbour. Discovered-role snapshots are read at the element's current position and checked against the same element. An element that is detached during discovery is withheld with a `candidate_skipped` event (`phase: "discovery"`, role, name when known, reason); one that is already invisible is simply not offered. Configured interaction lookups share the 1-second capture window below.

Every offered action is bound to a guard (element identity plus control state, or scroll recipient) before any model sees it. A candidate that changes during this capture is withdrawn rather than offered without a guard, and a `candidate_skipped` event (`phase: "capture"`) records the journey, URL, action description, kind, reason, current match count and the first line of any browser error. Reasons are `detached` (no longer present, or absent for the whole 1-second capture window), `ambiguous` (now matches more than one element), `replaced` (the locator now resolves to a different element) and `no_recipient` (no scroll recipient at the region point). Remaining actions are renumbered `a0…` after withdrawal. A capture failure on a control that is still present and unchanged is not classified as transient; it still aborts the journey as an error. Withdrawal never relaxes the dispatch guards: an action whose target disappears after it was offered is still rejected as stale.

An October 4 full narrow example-app replay from Home passed all six outcome/content checks in eight actions (eight interactive Codex plans, eight real Jev selections), with loaded instruction content inspected in the final screenshot and recording. On the navigation into Sessions, the sidebar closed during capture: `Open Sessions` was withdrawn as `detached` after the 1-second window and a collapsed group button by the pre-capture count, and the journey continued. One scroll was rejected as stale while the page loaded, and a backend HTTP 503 finding was retained. This verifies the withdrawal path on one live transition, not a controlled reliability or model-quality benchmark. A later full Home replay on the handle-based discovery commit passed all six checks in seven actions with no withdrawals, revisit replans or action errors. The navigation overlay stayed open after opening Sessions this time and needed one `no_match` replan. A backend HTTP 503 finding was retained.

## Evidence and outcomes

Each run uses a fresh private directory under `runs/`. `--out` can choose another new directory. Existing runs are never overwritten.

Once the suite, credentials and session are supplied, the CLI executes without interactive action prompts. Use `--headed --video` to watch the browser and keep a recording. The CLI prints the live log path at startup; follow it in another terminal with `tail -f runs/<run>/events.jsonl`. Open `report.html` after completion for outcomes, screenshots, video and traces.

- `report.html`: task outcomes and evidence links.
- `events.jsonl`: observations, plans, model responses/timings, candidate probabilities, actions, console/network observations and request-policy blocks.
- `results.json`: checks, statuses and findings.
- Per journey/viewport: screenshots, Playwright trace and optional video.

Open traces locally with `npx playwright show-trace runs/<run>/<journey>-<viewport>/trace.zip`. Artifacts may contain private application data, session material and request bodies. They are ignored by Git and never automatically uploaded.

Missing auth, unauthorized responses or an unmet readiness check are `blocked`; repeated actions, no path forward or exhausted budgets are `failed`; model and infrastructure problems are `error`. A task can pass with visual or runtime findings still requiring review. Exit codes: **0** all asserted outcomes passed, **1** at least one non-passing journey, **2** configuration/startup error.

The journey deadline (`maxDurationMs`) is enforced between stages as well as inside them. Planner, selector and action dispatch never start after it has passed. A Playwright or model `TimeoutError` raised at or after the deadline is reported as `failed` with the stage it cut off (for example `Task budget exhausted before the outcome was observed (choose timed out at the deadline)`), not as `error`. A `budget_exhausted` event records the step, stage, cause (`deadline_before_stage` or `timeout`), the first error line and the overrun. An action whose dispatch timed out at the deadline is not filed as an `action-error` finding. Timeouts before the deadline and non-timeout failures at any time remain `error`. Interactive planning time counts against the deadline, so a late answer ends the journey as a budget failure.

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
