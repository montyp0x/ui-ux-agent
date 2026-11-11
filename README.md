# UI/UX Agent

A reusable agent runner for websites and browser-based applications. Give it a URL, a user goal, a persona and observable success checks. It plans from screenshots, selects bounded interactions and records evidence for review.

The architecture adapts the planner → action selector → verified outcome loop from [minecraft-agent](https://github.com/rmalde/minecraft-agent). Application routes, selectors and credentials live in suite configuration. It is a standalone project: it needs Node, a Playwright browser runtime and model API credentials, and nothing else. No application repository, cloud secret store or hosted service of ours is required.

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

Configure credentials (see [Credentials](#credentials)), then validate and run:

```sh
cp .env.example .env   # fill in keys
npm run run -- --suite suite.json --validate
npm run run -- --suite suite.json --video
```

## Credentials

Credentials are read from environment variables, never from suite files. The CLI loads `./.env` when present, or the file given with `--env-file PATH`. Variables already set in the shell take precedence. `.env` is gitignored. [.env.example](.env.example) lists every variable.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PLANNER_API_URL` | OpenAI-compatible Chat Completions endpoint for the screenshot planner | OpenRouter |
| `PLANNER_API_KEY` (or `OPENROUTER_API_KEY`) | Planner bearer token | required |
| `PLANNER_MODEL` | Planner model | `openai/gpt-6-astra` |
| `PLANNER_API_HEADERS` | Optional JSON object of extra headers for gateways | none |
| `SELECTOR_PROTOCOL` | `typesafe` (TypeSafe Jev choice API) or `chat` (any Chat Completions endpoint) | `typesafe` |
| `PLANNER_MAX_RPM`, `PLANNER_MAX_CONCURRENCY` | Client-side cap on planner requests per minute and in flight, shared by the whole process | `60`, `2` |
| `SELECTOR_MAX_RPM`, `SELECTOR_MAX_CONCURRENCY` | The same for the selector endpoint (one limiter per endpoint URL, so a shared `chat` endpoint has one budget) | `300`, `4` |
| `JEV_API_KEY` (or `TYPESAFE_API_KEY`) | Jev selector key, for `typesafe` | required for `typesafe` |
| `SELECTOR_API_URL`, `SELECTOR_API_KEY`, `SELECTOR_MODEL`, `SELECTOR_API_HEADERS` | Selector overrides; with `chat` each defaults to the planner's value | see left |

A model endpoint that answers 429 (or 503) is retried after its `Retry-After`, or an exponential backoff with jitter, as long as the step's time budget allows (up to 5 attempts). The endpoint pauses for that cooldown, its rate is halved after each 429 or 503 and recovers by one request per minute per success. The pause applies to every request on the endpoint, including ones already queued: each request rechecks the latest cooldown and pacing immediately before it is sent, and a later or longer cooldown always wins. A request whose start would fall past its step budget fails at once instead of sleeping, and an expired or cancelled request is never sent. A request holds its concurrency slot until its response is read or it fails, and gives it back on every exit path. When planner and selector share one URL, the first limits configured for it (the planner's) apply. Every wait is logged as a `model_wait` event with its reason, status, attempt and the endpoint's current rate, never the key or headers.

With `SELECTOR_PROTOCOL=chat`, one provider key runs everything. Point `SELECTOR_MODEL` at a smaller, faster model than the planner's. The chat selector constrains its output to the offered action ids plus `no_match` through `json_schema`. It asks for a probability per option and normalizes the distribution before the same validation the Jev selector gets.

The planner endpoint must support Chat Completions with images, `max_completion_tokens` and `json_schema` structured output. The schema sent carries only structure (types, properties, required fields). Value limits such as the six-concern cap are enforced when the response is parsed, and a completion truncated at the token limit is rejected. Some gateways do not enforce `json_schema`. A valid object wrapped in a single key is unwrapped, and any other invalid structured reply is requested once more before the journey reports an error. `model_call` events carry the attempt number. Example for an OpenAI-compatible gateway that needs an extra header, with one provider for both roles:

```sh
PLANNER_API_URL=https://llm-gateway.example/v1/chat/completions
PLANNER_API_KEY=<gateway token>
PLANNER_MODEL=<screenshot-capable planner model>
PLANNER_API_HEADERS='{"X-Gateway-Token-Type":"<value the gateway requires>"}'
SELECTOR_PROTOCOL=chat
SELECTOR_MODEL=<smaller, faster model>
```

Models receive viewport observations: visible text and control labels, dimensions, scroll availability and positions, URL and horizontal overflow. The planner also receives a viewport screenshot. Below-the-fold, clipped and covered content is excluded from model observations; the full accessibility snapshot stays in local evidence. Control labels retain accessible names, including associated labels. Use data permitted for processing by the configured providers. Keys remain in request headers and are not written to evidence.

`scrollRegions` identifies visible scroll containers by label, bounds, parent region, position and reachable up/down wheel points. The driver samples ten points per region and reports at most twelve regions. A direction can be unavailable even when content remains, for example when an overlay or a nested panel with scroll chaining disabled intercepts every sampled point. The model chooses a candidate ID; wheel coordinates come from the driver.

Viewport filtering uses DOM geometry, ancestor clipping, modal boundaries and sampled hit tests, including open shadow roots. It is approximate; canvas content, closed shadow roots and frame interiors remain available through the planner's screenshot. Text is capped at 12,000 characters and 100 controls after scanning at most 10,000 text nodes; `textTruncated` indicates an incomplete projection.

## Suite configuration

Use [examples/website.json](examples/website.json) as a template. [schemas/suite.schema.json](schemas/suite.schema.json) describes all fields. Keep suites for private applications outside this repository, or in the gitignored `suites/` directory; `--suite` accepts any path.

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

Locators support accessible roles/names, labels, placeholders, CSS selectors and test IDs. A site does not need test IDs. Configured actions support click, fill, select, check/uncheck and a bounded set of keys. On Chromium the agent is also offered **Go back** when the browser's session history has a previous entry inside the journey's scope, read from the browser's own navigation history so client-side routes count. Going back rechecks the current URL, history position and target entry before dispatch, and is rejected as stale if any changed. Values and selectors come from reviewed suite configuration, never generated model code.

```json
{
  "kind": "fill",
  "target": { "by": "label", "value": "Search documentation" },
  "description": "Search for installation instructions",
  "value": "installation"
}
```

Checks support route patterns, visible content, any visible match, text patterns and absence. `anyRendered` accepts any Playwright-visible match, including below the viewport; it proves layout presence, not that the user inspected it. Success requires every check. The agent cannot declare its own completion. Actions and visible-content checks use the current viewport, including ancestor clipping and modal boundaries. Before execution, selected controls are checked for identity, semantic state, availability and dialog context, and navigation must still match the observed URL. Unrelated page updates do not invalidate a selection. Each reachable region gets separate scroll directions, so an outer page can move independently of a nested feed. Scroll actions recheck their wheel recipient after moving the pointer, plus its position, viewport size and dialog context. Wheel gestures settle for 550ms before the next observation; waits tolerate page updates. Scrolling tracks the document, nested containers and open shadow roots.

### Setup

Apps keep state between runs: a calculator still shows its last result, and a page may remember a dismissed banner. `setup` lists up to ten interactions run once after `ready` and before the first observation:

```json
{ "setup": [{ "kind": "click", "target": { "by": "testId", "value": "AllClear" }, "description": "Clear the calculator" }] }
```

Each step must match the target of an action the driver offers, either a discovered control or a configured interaction, so it gets the same guards and blocklist as any action. Steps are logged as `setup` events, never shown to the models, and not counted as journey actions. A step that is not offered, or fails, ends the run as `blocked` with the step named.

### Detours

A journey can name pages that resemble its destination but are not it:

```json
{
  "detours": [
    { "pattern": "^/preview/", "description": "a preview page that resembles the item detail page but is not it" }
  ]
}
```

Up to ten path regexes. When the agent reaches a matching path, the runner records an observed `detour` finding with the screenshot and the reviewed description, plus the number of observed steps spent there. Each visit is logged as a `detour` event. Success checks are unchanged: a detour never counts as reaching the destination. The planner is not told about detours, so the finding reflects what a user without inside knowledge would do. Use it when look-alike pages are a usability question rather than a test bug.

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

GET, HEAD and OPTIONS are allowed. Other request methods are blocked unless configured explicitly. A blocked non-navigation request to one of the suite's own origins becomes an observed `policy-block` finding. The page under test may show errors caused by the harness rather than the application, so add genuine reads such as search POSTs to `readOnlyPosts`. Use reviewed endpoints and disposable test data for flows that write. GET endpoints can have application-specific side effects; request filtering is not a universal application sandbox. Request routing also does not intercept WebSocket traffic, so keep live journeys limited to reviewed flows.

## Authentication and browser selection

For applications behind a login, capture a session once:

```sh
npm run run -- --suite suite.json --login .auth/app.json
```

This opens a visible browser at the suite's `baseURL`. Sign in, then press Enter in the terminal. To convert an existing Playwright storage-state file instead, add `--from existing.json`. Either way, the saved file keeps only cookies and localStorage for the origins the suite declares: `baseURL`, `allowedOrigins`, `applicationOrigins`, and the origins in `allowedRequests` and `readOnlyPosts`. Other identities the login browser picked up, such as SSO-provider or personal Google cookies, are dropped. The file is written with mode 0600 under the gitignored `.auth/`, and the CLI prints the kept and dropped counts (never values). Then run with it:

```sh
npm run run -- --suite suite.json --storage-state .auth/app.json --video
```

Every run applies the same scoping when it loads a session, and logs a `storage_state_scoped` event with the kept and dropped counts. Foreign session material therefore never reaches the test browser or its traces, even from an unscoped file. The runner creates isolated contexts and never extracts a personal browser profile. A session expires on the application's schedule; capture it again when runs report `blocked`.

Override the target URL with `--url`, the engine with `--browser`, or use `--headed` for a visible test browser. Install the selected runtime with `npx playwright install firefox` or `npx playwright install webkit`. Browser integration tests and the bundled demo currently verify Chromium only; Firefox/WebKit are configurable but unverified in this checkout.

## macOS apps

The same engine tests native macOS apps through the accessibility API. Planner, selector, loop and stall handling, `--repeat`, usage accounting and reports work unchanged.

**Requirements:** macOS 14 or newer, and the Xcode Command Line Tools (`swiftc`); a small helper (`native/macos/ax-helper.swift`) is compiled into `.build/` on first use. The app that runs the CLI (Terminal, iTerm, …) needs **Accessibility** and **Screen Recording** permission (System Settings → Privacy & Security). The runner checks both and stops with a clear error if either is missing.

```json
{
  "name": "Calculator",
  "platform": "macos",
  "app": { "bundleId": "com.apple.calculator", "relaunch": true },
  "viewports": [{ "name": "window", "width": 320, "height": 480 }],
  "journeys": [
    {
      "id": "multiply",
      "goal": "Work out 7 multiplied by 6 and read the result",
      "persona": "Someone checking a quick sum",
      "ready": { "kind": "visible", "target": { "by": "testId", "value": "StandardInputView" } },
      "setup": [{ "kind": "click", "target": { "by": "testId", "value": "AllClear" }, "description": "Clear the calculator" }],
      "success": [{ "kind": "text", "target": { "by": "testId", "value": "StandardInputView" }, "pattern": "^42$" }]
    }
  ]
}
```

- **`app`:** `bundleId` (installed app) and/or `path` (an `.app` to launch). With `relaunch: true` the app is quit gracefully and launched fresh for a known starting state. It is off by default because quitting can lose unsaved work; an app that refuses to quit is reported, never force-killed.
- **`viewports`** are window sizes. Fixed-size windows log the refused resize and keep their size.
- **Targets:** `testId` matches the accessibility identifier (SwiftUI `.accessibilityIdentifier`, AppKit `identifier`). `role` with `name` uses the same role names as the web (`button`, `checkbox`, `tab`, `textbox`, …). `label` matches the accessibility description or title, and `placeholder` the placeholder. CSS targets are rejected.
- **Checks:** `path` matches `/` plus the window title. A `label` target also matches visible static text. `text` matches an element's text content (its value, else its descendants' text, like `innerText`). Visibility means the element lies inside the window and every enclosing scroll area.
- **Actions offered:** visible, enabled, named controls that support pressing (buttons, links, checkboxes, radios, tabs, menu items, pop-ups); rows of lists, tables and outlines (`Select row <text>`, role `option`, named by their text), which are selected rather than pressed, and are offered only when not already selected; configured `click`/`fill`/`check` interactions; page scrolling of scroll areas; and wait. The native page-scroll action is verified against the scroll bar; when a toolkit reports success without scrolling (SwiftUI does), the scroll bar is moved by about one page instead. No synthesized mouse or keyboard events are sent, and `press`/`select` interactions are not supported yet.

**Menu-bar commands** are opt-in per suite with `"menus": true`. The driver reads the menu bar through the accessibility API without opening any menu. Each enabled command becomes `Choose menu File › New`, up to 80 per step, and is pressed directly, so no menu is opened visibly; an open menu would block the app's accessibility while it tracks. Never offered:

- the Apple menu, and the whole Window and Help menus;
- anything under Services;
- commands matching the general blocklist (quit, close, delete, save, …), and the menu-only list: open/recent/import (they reveal your files), print/page setup, share, hide, minimize, zoom, full screen, revert, bring all to front, and system-provided items that act outside the app (dictation, emoji & symbols, AutoFill/passwords/contacts, Writing Tools, speech).

Parent menu names are checked only against the menu-only list, so a menu called "Format" is not blocked. Blocked commands are logged as `candidate_skipped` (role `menuitem`). Before a press, the driver re-reads the menu item and rejects it as stale if it was removed, renamed or disabled.

**Safety model** (instead of the web request policy):

- Controls whose names match `blockedControls` are never offered: delete, remove, trash, send, post, buy, pay, subscribe, quit, log/sign out, empty, reset, uninstall, discard, install, upgrade, stop, pause, disable, deactivate, disconnect, unlink, and file side effects (save, export, overwrite, replace, rename, duplicate, move to) by default; suites can add patterns. Blocked controls are logged as `candidate_skipped` with reason `blocked`. Interactions a suite configures explicitly are allowed.
- Title-bar buttons (close, minimize, zoom, full screen) are never offered.
- Before every press, the driver re-reads the exact accessibility element it offered, and rejects the action as stale if the element is gone or its role, name, identifier or enabled state changed.
- A journey leaves its scope (`blocked`) when an action brings a different app to the front (for example, a link that opens the browser), or when the target app quits or loses its window. Runs work in the background: accessibility actions target the app's elements directly and window captures do not need the window in front or on the current Space, so you can keep using the Mac while a suite runs.
- Use test data and accounts in apps that hold real data: the agent acts on the real app.

**Evidence:** screenshots of the app window (downscaled to point size) per step, and the final accessibility tree as `trace.json`, linked from the report. There is no video or Playwright trace.

`npm run demo:macos` builds a small SwiftUI fixture app (`native/macos/fixture/`) and runs a deterministic journey in two window sizes. `examples/macos-calculator.json` (Calculator) and `examples/macos-textedit.json` (TextEdit: write and center a title, with menu commands enabled) run with real models. Apps that open on a file browser, as TextEdit does, can expose your file and folder names. Use `setup` to leave that screen first: setup observations stay local and are never sent to the models. Close test documents yourself afterwards, since the agent cannot discard them.

Current macOS limits: accessibility quality varies by app (custom-drawn UI may expose little); keyboard shortcuts are not offered, menu commands are offered only with `menus: true`; only one window is observed (the focused, or else the first, window).

## Architecture

- `src/contracts.ts`: validated suite, action, model and result contracts.
- `src/runner.ts`: app-independent journey execution, budgets and outcomes.
- `src/drivers/types.ts`: browser-session interface.
- `src/drivers/playwright.ts` and `src/browser.ts`: browser setup, observations, candidates, scope and execution.
- `src/drivers/macos.ts` and `native/macos/ax-helper.swift`: the macOS accessibility driver and its helper; `src/drivers/macos-fixture.ts` builds the SwiftUI fixture app.
- `src/scroll.ts`: scroll-region discovery, wheel hit tests and chaining rules.
- `src/models.ts`: screenshot planner, TypeSafe and chat-completions selector adapters. The engine also accepts a custom `Models` implementation.
- `src/config.ts`: model configuration from environment variables.
- `src/auth.ts`: session (storage-state) parsing and origin scoping.
- `src/planning.ts`: semantic action signatures and bounded planner refresh rules.
- `src/report.ts`: local evidence report.

`runSuite(suite, models, options)` can be called from another TypeScript project. Supply a `UIDriver` in `options.driver` to replace the browser implementation while preserving the journey engine. This version supports websites, browser applications and macOS apps; other native platforms (Windows, mobile) are not implemented.

The planner refreshes when executable action opportunities change, on full-URL navigation (including query/hash), after action errors or no progress, after `no_match`, before revisiting an already-tried action state (see Loop detection), and at most five decision steps after its last refresh. Candidate IDs, ordering and wheel hit-point movement do not count as new opportunities; unrelated background text updates alone do not force a refresh. Newly revealed menu links therefore replace an obsolete expand-menu objective before another selection. The HTTP planner receives only candidate IDs/kinds/descriptions alongside the screenshot and viewport, not executable selectors or configured values. It also receives `refresh`: the refresh reasons and, for `revisited-state`, the action the selector was about to repeat. Custom `Models.plan` implementations get this context as an optional sixth argument. Drivers that implement `UISession.offeredControls()` (Playwright does) report the observed-control name of each offered action. Discovery computes that name with the same function the viewport projection uses, so the match is exact. The planner's visible controls are then marked `offered: true/false`, next to a constraint that controls with `offered: false` cannot be used. Without this, screenshot-aware planners tend to aim at visible links outside `allowedPaths`. The marking reduces this but does not eliminate it.

Custom `Models.plan` implementations can consume the optional fifth `actions` argument; existing implementations can ignore it. `plan` events include `refreshReasons`. More frequent actionable changes can increase planner calls; this is a relevance policy, not a measured cost or model-quality improvement. The selector chooses from offered actions and records its probability distribution. Model UX concerns are hypotheses for human review. These are synthetic task probes, not calibrated human personas or measured human usability scores.

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

The loop policy's browser regressions cover background changes, rebound candidate IDs, blocked and advancing wheels, reversible cycles, declared progress, wait completion and custom-driver capability errors.

## Candidate capture

Discovery reads links, configured interactions and discovered roles through element handles, and reads each link's name, `href` and `target` in one evaluation. A removed element therefore stays the same, now detached, object instead of shifting positional reads onto its neighbour. Discovered-role snapshots are read at the element's current position and checked against the same element. An element that is detached during discovery is withheld with a `candidate_skipped` event (`phase: "discovery"`, role, name when known, reason); one that is already invisible is simply not offered. Configured interaction lookups share the 1-second capture window below.

Every offered action is bound to a guard (element identity plus control state, or scroll recipient) before any model sees it. A candidate that changes during this capture is withdrawn rather than offered without a guard, and a `candidate_skipped` event (`phase: "capture"`) records the journey, URL, action description, kind, reason, current match count and the first line of any browser error. Reasons are `detached` (no longer present, or absent for the whole 1-second capture window), `ambiguous` (now matches more than one element), `replaced` (the locator now resolves to a different element) and `no_recipient` (no scroll recipient at the region point). Remaining actions are renumbered `a0…` after withdrawal. A capture failure on a control that is still present and unchanged is not classified as transient; it still aborts the journey as an error. Withdrawal never relaxes the dispatch guards: an action whose target disappears after it was offered is still rejected as stale.

## Evidence and outcomes

Each run uses a fresh private directory under `runs/`. `--out` can choose another new directory. Existing runs are never overwritten.

Model-driven journeys are stochastic, so one run is not a pass rate. `--repeat N` (1–50) runs each selected journey and viewport N times in sequence, each with its own evidence directory (`<journey>-<viewport>-<n>`). The CLI prints `passed/runs` with median actions and duration per journey/viewport. Every result records its `attempt` and its `usage`: per role (planner, selector), the call count, total latency, and input/output tokens. Usage is taken from `model_call` events, from `prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens`, and counts as zero when a provider omits it. Token counts are not converted to cost.

Once the suite, credentials and session are supplied, the CLI executes without interactive action prompts. Use `--headed --video` to watch the browser and keep a recording. Headed Chromium is pinned to device scale factor 1. Without that, on Retina/HiDPI displays each per-step screenshot briefly re-renders the window at the display's pixel ratio, a visible flicker every step. With the pin the window looks slightly softer; page `devicePixelRatio` and screenshots are unchanged. The CLI prints the live log path at startup; follow it in another terminal with `tail -f runs/<run>/events.jsonl`. Open `report.html` after completion for outcomes, screenshots, video and traces.

- `report.html`: a summary table per journey/viewport (pass rate, other outcomes, median actions and duration, model calls and tokens), then each run's outcome and evidence links.
- `summary.json`: the same summary as data.
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

Tests use real Chromium against local synthetic pages with deterministic model HTTP responses; none need credentials or network access beyond localhost. CI installs Chromium and runs these checks without model credentials. No run evidence is uploaded by CI.

Current limits: no Windows or mobile drivers, screenshot baseline comparison, complete accessibility audit, price-based cost accounting (tokens are counted) or live model-quality benchmark. Live pass rates depend on the models and the suite's scope; measure them per target. Browser behavior and application assumptions need validation on each target.

API references: [TypeSafe](https://docs.typesafe.ai/api), [OpenRouter](https://openrouter.ai/docs/api_reference/overview), [Playwright](https://playwright.dev/docs/intro).
