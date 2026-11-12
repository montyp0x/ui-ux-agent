# UI/UX Agent

A reusable agent runner for websites and browser-based applications. Give it a URL, a user goal, a persona and observable success checks. It plans from screenshots, selects bounded interactions and records evidence for review.

The architecture adapts the planner → action selector → verified outcome loop from [minecraft-agent](https://github.com/rmalde/minecraft-agent). Application routes, selectors and credentials live in suite configuration. It is a standalone project: it needs Node, a Playwright browser runtime and model API credentials, and nothing else. No application repository, cloud secret store or hosted service of ours is required.

## Quick start

Requires Node 22 or newer.

```sh
npm ci
npx playwright install chromium
npm run demo
npm run demo:states
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
| `browserChannel`     | Chromium only: an installed build (`chrome`, `chrome-beta`, `msedge`)         |
| `browserExecutable`  | Chromium only: absolute path to another Chromium-based browser's executable   |
| `requiresAuth`       | Require a storage-state file or a dedicated `--profile`; defaults to false    |
| `viewports`          | Named widths/heights to run independently                                     |
| `allowedOrigins`     | Explicit additional origins the agent may navigate to                         |
| `applicationOrigins` | Backend origins whose 401 responses block the journey                         |
| `allowedRequests`    | Explicit method/origin rules for write requests in authorized test flows, each with an exact `path` or a `pathPattern` (regex on the URL path) |
| `readOnlyPosts`      | Exact origin/path rules for POST-based read/search endpoints                  |
| `dataLifecycle`      | Reset, setup and cleanup hooks on a local fixture service for write flows (see [Write flows and test data](#write-flows-and-test-data)) |
| `journeys`           | Goals, personas, starting paths, allowed paths, actions, checks and budgets   |

A journey offers visible links within its configured paths and origins. `"/"` permits the homepage only; `/docs` permits `/docs` and its descendants. Paths apply to all permitted navigation origins. Auth/logout routes, new tabs and popups are excluded. `discoverRoles` optionally enables discovery of visible, uniquely named buttons, tabs or menu items. It defaults to an empty list.

Locators support accessible roles/names, labels, placeholders, CSS selectors and test IDs. A site does not need test IDs. Configured actions support click, fill, select, check/uncheck and a bounded set of keys. On Chromium the agent is also offered **Go back** when the browser's session history has a previous entry inside the journey's scope, read from the browser's own navigation history so client-side routes count. Going back rechecks the current URL, history position and target entry before dispatch, and is rejected as stale if any changed. Values and selectors come from reviewed suite configuration, never generated model code. A `fill` takes either a literal `value` or `valueEnv`, the name of an environment variable read when the field is filled, so a test password never sits in a suite file: actions, decisions, results and the run's `suite.json` carry only the variable name, and a run fails before it starts, naming every unset variable. Every `valueEnv` variable is also treated as a declared secret (as if listed in `evidence.redactEnv`): its value is redacted from all text evidence, the accessibility snapshots in `observation` events included; the suite counts as sensitive, so traces and video are not captured under `auto` and `trace`/`video: "local"` is refused; and on the web the filled field is masked in every screenshot (macOS window captures cannot be masked, so a macOS suite with `valueEnv` keeps screenshots from the planner). Values shorter than 4 characters are not redacted as text; the CLI warns about them when it loads the suite and every result lists them (see [Evidence protection](#evidence-protection)). `{{marker}}` anywhere in a journey (typed values, check patterns) is replaced by a value unique to each run, recorded as the result's `marker`, so a run can find its own effects.

```json
{
  "kind": "fill",
  "target": { "by": "label", "value": "Search documentation" },
  "description": "Search for installation instructions",
  "value": "installation"
}
```

Checks support route patterns, visible content, any visible match, text patterns, absence and, on the web, keyboard focus (`{ "kind": "focused", "target": …, "within": true }`: the target has focus, or with `within` focus is inside it, such as inside a dialog). `anyRendered` accepts any Playwright-visible match, including below the viewport; it proves layout presence, not that the user inspected it. Success requires every check. The agent cannot declare its own completion. Actions and visible-content checks use the current viewport, including ancestor clipping and modal boundaries. Before execution, selected controls are checked for identity, semantic state, availability and dialog context, and navigation must still match the observed URL. Unrelated page updates do not invalidate a selection. Each reachable region gets separate scroll directions, so an outer page can move independently of a nested feed. Scroll actions recheck their wheel recipient after moving the pointer, plus its position, viewport size and dialog context. Wheel gestures settle for 550ms before the next observation; waits tolerate page updates. Scrolling tracks the document, nested containers and open shadow roots.

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

### Task friction

Every run's result carries `friction`: a summary of how the agent's run went, computed only from the run's own events in `events.jsonl` (`src/friction`), so it can be recomputed from the log and reconciles with it exactly (`eventLogRuns` and `computeFriction` do that for a consumer). It counts and links; it judges nothing, gates nothing and never changes the outcome or the quality verdict.

- **Actions:** `product` (actions the selector chose on the product, waits excluded), `waits`, and `recovery` (the runner's no-match recovery scrolls). `overhead` keeps planner and runner work apart from product actions: planner refreshes with their reasons, `no_match` decisions, replans before revisiting a tried state, and recovery actions.
- **Items**, each linked to its `events.jsonl` line, the observation step, its URL and the screenshots of that state and the next one:
  - `backtrack`: a browser-history **Go back**, or a navigation to a page (URL without fragment) observed earlier in the run;
  - `repeat`: an action dispatched again in a state where it was already tried (the loop check's second or third visit);
  - `recovery`: a runner recovery after two `no_match` decisions;
  - `detour`: an observed step on a configured [detour](#detours);
  - `failed_attempt`: an action whose dispatch failed (`stale:` when a guard rejected it, else `error:`);
  - `no_effect`: an action after which the observed state did not change (waits excluded).
- **Review rubric:** four fixed questions for a human reviewer (`discoverability`, `feedback`, `clarity`, `recovery`), each with the run's counts that bear on it. No dimension is scored; every one is `review: "pending"`, and `no_signals` means nothing was counted, not that the dimension is good. Model concerns stay `hypothesis` findings; `friction.hypotheses` points at the plan events that raised them.

A journey can list up to five reviewed `referencePaths`, alternate valid routes to its goal:

```json
{
  "referencePaths": [
    {
      "name": "via-docs",
      "waypoints": [
        { "kind": "page", "pattern": "^/docs$" },
        { "kind": "action", "action": "link", "to": "^/docs/install$" }
      ],
      "expectedActions": 2
    },
    {
      "name": "via-search",
      "ordered": false,
      "waypoints": [{ "kind": "page", "pattern": "^/search$" }, { "kind": "page", "pattern": "^/docs/install$" }],
      "allow": [{ "description": "cookies" }]
    }
  ]
}
```

A `page` waypoint matches an observed page path (regex); an `action` waypoint matches an agent action that did not fail by `action` kind, a `description` regex and, for links and history back, a `to` regex on the destination path (at least one of the three). Waypoints are matched in order unless `ordered` is false; an unmatched waypoint is reported and does not block later ones. `expectedActions` (default: the number of action waypoints) is compared with the run's product actions minus those matching an `allow` entry (a cookie banner, say); the difference is `extraActions`. Each run is compared with every path and names the `closest` (most waypoints matched, then fewest extra actions). Reference paths are not sent to the HTTP model adapters, which read only the goal and persona.

Across repeated runs (`--repeat`), `summary.json` adds a `friction` aggregate per journey/viewport: `runs` (runs with a friction summary), `withoutFriction` (results recorded before friction existed, not counted as zero), per count kind (`backtracks`, `repeats`, `recoveries`, `detours`, `failedAttempts`, `noEffect`) the `total` items and the `runs` with at least one, and `reference` (runs compared with reference paths and how many followed their closest path, `null` when none was). Like the per-run summary it is descriptive only and never gates.

What this does not establish: these are counts from an automated agent's run. Agent actions, agent duration and synthetic success rates are not human task time, success rate or satisfaction, and extra actions alone do not establish poor usability: a route the reference paths do not list may be just as valid. Read the linked steps before drawing a conclusion. Friction text comes from the redacted event log and the result is redacted again, like other evidence.

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

### State coverage

A declared journey state can carry its own `expect` checks, evaluated once at the first observed state where its `when` holds, independently of the journey's `success` checks. A loading, empty, error or success state is then verified on its own terms (the error state offers a retry, the empty state explains itself) whatever the journey's outcome:

```json
{
  "audits": { "checks": [{ "id": "journey.state-checks" }] },
  "journeys": [
    {
      "states": [
        {
          "name": "error",
          "when": { "kind": "visible", "target": { "by": "testId", "value": "error" } },
          "expect": [
            { "kind": "visible", "target": { "by": "css", "value": "[data-testid=error] [role=alert]" } },
            { "kind": "visible", "target": { "by": "role", "role": "button", "name": "Retry" } }
          ]
        }
      ]
    }
  ]
}
```

The `journey.state-checks` audit (runs at `states` only; `severity`, default `serious`) reports each failed expectation as a `state-expectation` violation tagged `state:<name>`; an expectation that throws makes the run `incomplete`; a state never reached is listed in `audits.notReached`. A journey with `expect` checks needs the audit configured. It uses only the driver's checks, so it runs on the web and on macOS. [examples/states.json](examples/states.json) covers form validation, loading/empty/error/success states, a dialog, a menu, a paginated table and a three-step flow against the local fixture in [examples/state-fixture.ts](examples/state-fixture.ts); `npm run demo:states` runs it with scripted decisions (no model calls), and `npm run demo:states -- --defects` turns on one deliberate defect per page to show the state checks failing while the journeys still pass.

### Keyboard-only journeys

A web journey with `"input": "keyboard"` is operated with the keyboard alone. At every state it is offered key presses on whatever has focus (`Tab`, `Shift+Tab`, `Enter`, `Space`, `Escape`, the arrow keys, `Home`, `End`, `PageUp`, `PageDown`; each description says where focus is), its configured `fill` and `press` interactions once keys have focused their target, and a wait. Links, clicks, scrolling and history are never offered, and the driver refuses any other action, so a keyboard journey cannot fall back to the pointer; keys are pressed through the browser's own keyboard input, never by focusing elements programmatically. `click`, `select` and `check` interactions and `discoverRoles` are rejected for keyboard journeys, and macOS suites reject them (the native driver never synthesizes input). The focused element is part of the observed state, so a key that only moves focus counts as a change.

```json
{
  "input": "keyboard",
  "keyboard": {
    "focusOrder": [{ "by": "label", "value": "Display name" }, { "by": "role", "role": "button", "name": "Save profile" }],
    "dialogs": { "closeOnEscape": true, "restoreFocus": true }
  }
}
```

The `keyboard.focus` audit (default checkpoint `completion`; `states` is also allowed; `ready` is refused, because before the journey's first key press there is no focus transition to measure) reads the focus transition each key press recorded: what had focus before and after it, whether the newly focused element's computed style changed when it received focus, and which modal dialog was open. It presses no key itself. Rules:

- `focus-visible` (`serious` violation, WCAG 2.4.7): focus moved to an element whose computed outline, box shadow, border, background, colour, text decoration or shadow, opacity, transform or filter (on the element, its `::before`/`::after`, or its parent's outline, shadow, background or border colour) did not change; a `moderate` `needs_review` when the element appeared with the key press and could not be compared.
- `focus-not-shown` (`serious`, WCAG 2.4.11): focus moved to an element outside the viewport or not rendered visibly.
- `dialog-initial-focus` and `dialog-focus-trap` (`serious`, WCAG 2.4.3): a modal dialog (`<dialog>` opened modally, or `aria-modal="true"`) opened without focus moving into it, or `Tab`/`Shift+Tab` moved focus out of an open one.
- Explicit expectations only, from the journey's `keyboard` block: `dialog-escape` (`moderate`) when `Escape` leaves a modal open (`closeOnEscape`); `dialog-focus-restore` (`moderate`; `needs_review` when the opener could not be identified) when closing a modal does not return focus to the control that had focus when it opened (`restoreFocus`); and `focus-order` (`serious`) when a run of `Tab` presses reaches the `focusOrder` targets out of order (unlisted controls may sit between them; a wrap inside a modal starts a new run).
- `focus-lost` (`moderate`) and `focus-stuck` (`serious`), both `needs_review`: a key removed the focused element and focus fell back to the document; `Tab` left focus on the same element while no modal dialog was open.

Each finding points at the state after the key press. The audit only measures what the journey's own key presses reached: on a pointer journey it is `incomplete`, and a keyboard journey that pressed no key is `incomplete`, never clean. Indicator contrast and size, focus obscured by other content, and frames are not measured; each run lists these limitations. When `keyboard.focus` is configured, the `keyboard.focus` unsupported gap is dropped from the quality verdict. [examples/keyboard.json](examples/keyboard.json) is a keyboard-only journey through the fixture's dialog.

### Write flows and test data

Journeys that write need reviewed `allowedRequests`, and their data needs a lifecycle. `dataLifecycle` points the runner at an isolated **local** fixture service (an `http(s)` origin on `127.0.0.1`, `localhost` or `[::1]`; web only) and its hooks:

```json
{
  "allowedRequests": [{ "origin": "http://127.0.0.1:4174", "path": "/api/notes", "method": "POST" }],
  "dataLifecycle": {
    "service": "http://127.0.0.1:4174",
    "reset": { "method": "POST", "path": "/__fixture/reset" },
    "setup": { "method": "POST", "path": "/__fixture/setup" },
    "cleanup": { "method": "POST", "path": "/__fixture/cleanup" },
    "verify": { "path": "/__fixture/verify" },
    "timeoutMs": 5000
  },
  "journeys": [{ "startPath": "/notes?owner={{data.owner}}" }]
}
```

- `reset` (optional) runs once before the suite's first run, to clear what an interrupted earlier run left.
- `setup` (optional) runs before each run with `{"run": "<marker>"}` and may answer `{"values": {"owner": "…"}}`: disposable values, such as a test identity, that replace `{{data.<key>}}` anywhere in the journey. Only the keys are recorded. A failed reset or setup, or a `{{data.*}}` value setup did not return, ends the run as `blocked` (`data_setup_failed`) before the journey starts.
- `cleanup` (required) runs after every run, after the browser session closed, whatever ended it, with `{"run": "<marker>", "trigger": "passed|failed|blocked|timeout|cancelled|error"}`.
- `verify` (optional) is a `GET` with `?run=<marker>` answering `{"remaining": N}`; any remaining record is a cleanup failure.
- `publicValues` (optional, default `[]`): setup value keys that are **not** secret. Every other setup value is a secret, like a `valueEnv` value: once setup returns it, it is redacted as `[REDACTED:data:<key>]` from all text evidence (the event log, its accessibility snapshots and URLs, results, the summary, the report, files drivers and audits write, model payloads) and masked in every screenshot where it is visible as page text or an input value; a fill whose value reads it has its field masked; and a suite whose journeys use it counts as sensitive, so traces and video are not captured under `auto` and `trace`/`video: "local"` is refused at load. The result's `evidence.redactedData` lists the keys redacted in that run. A test identity a reviewer needs to read in the evidence, and that is safe to keep there, goes in `publicValues`. Values shorter than 4 characters cannot be redacted as text (see [Evidence protection](#evidence-protection)).

Each hook is bounded by `timeoutMs`, never follows redirects and parses its answer strictly. A cleanup that fails, times out, answers invalid output or leaves records keeps the functional outcome but is reported prominently: `dataLifecycle.clean` is `false` on the result, a `data-cleanup` finding is added, the report opens with a **CLEANUP FAILED** banner naming the runs, the CLI prints a `CLEANUP FAILED` line and exits 1. Nothing else changes: the quality verdict and its checks are those of the same run with a clean cleanup. Hook calls are logged as `data_reset`, `data_setup` and `data_cleanup` events. Ctrl-C cancels a CLI run: the current run stops at its next stage (`run_cancelled`), its cleanup still runs, and no further run starts; a second Ctrl-C exits at once. Library callers pass `signal` to `runSuite`. [examples/notes.json](examples/notes.json) with [examples/notes-fixture.ts](examples/notes-fixture.ts) is the reference flow, also run by `npm run demo:states`.

Uploads and downloads, frames, multi-tab flows and drag-and-drop are deliberately not supported yet; each needs its own capability and security design.

### Audits and checkpoints

Audits are objective checks of the UI, run only at checkpoints the suite configures, never after every action:

```json
{
  "audits": {
    "checks": [{ "id": "layout.horizontal-overflow", "at": ["ready", "states", "completion"] }],
    "failOn": "serious",
    "timeoutMs": 15000
  },
  "journeys": [
    {
      "states": [{ "name": "results-shown", "when": { "kind": "visible", "target": { "by": "testId", "value": "results" } } }]
    }
  ]
}
```

- `ready`: the first observed state after the `ready` assertion and `setup`.
- `states`: each of the journey's declared `states` (up to ten), once, at the first observed state where its `when` check holds. A journey that declares states needs an audit at `states`.
- `completion`: the final state when the journey ends, whatever its outcome, after `final.png` is captured. Skipped when no state was ever observed.

Without an `audits` block a suite runs `layout.horizontal-overflow` at `completion`; `"checks": []` turns audits off. Each audit runs once per reached checkpoint and records a run with status `clean` (no violations), `findings` (at least one violation), `incomplete` (the audit could not cover the whole state), `unsupported` (the driver does not support it; not run) or `error` (the audit itself failed: an analyzer exception, a configured scope that matched nothing, a timeout past `timeoutMs`, or output that fails the contract). An error or unsupported run says nothing about the UI and is never counted as clean. An audit never stops the journey: one that fails at a checkpoint, including a declared state whose `when` check itself throws, is recorded as an `error` run and the journey continues to its outcome (the quality verdict is then not `pass`). Configured checkpoints that were not reached are listed in `audits.notReached`. Each run is logged as an `audit_run` event.

Each audit finding carries its audit id, source and analyzer (name and version), rule id, severity (`minor`, `moderate`, `serious`, `critical`, or null when the analyzer gives none), certainty (`violation`, or `needs_review` for items the analyzer could not decide), description, guidance URL, standards tags, the affected-element count with a sample of targets (description, selector with frames joined by ` >>> ` and shadow roots by ` >> `, the analyzer's `reason`, snippet), evidence (screenshot and files) and reproduction context (journey, viewport size, checkpoint, step, URL). A finding reported again at a later checkpoint in the same page state (same audit, rule, certainty, severity, description and sampled targets, at the same URL and observed-state fingerprint; typically the last declared state and then `completion` when the journey ends there) is kept once: its `checkpoints` lists every checkpoint that saw it, the later run lists its index, and the `audit_run` event counts it as `repeated`. Runs list the analyzer's `limitations` and the `exemptions` it skipped under a configured exception (rule, target, reason); exemptions are never findings. Each audit entry can set its own `timeoutMs`, overriding `audits.timeoutMs`. `failOn` is one threshold for the whole suite and every audit in it; an audit entry cannot set its own (a per-audit `failOn` is rejected at load). Violations at or above `failOn` (default `serious`; `none` never fails) fail the quality verdict; a violation whose analyzer gave no severity cannot be shown to be below the threshold, so it fails at every `failOn` except `none`; `needs_review` findings are shown separately and never do. Each run records its `durationMs`, shown in the report next to its status with the total audit time; audit time counts against the journey deadline (`maxDurationMs`), and a run that exhausted its budget says how much of it the audits took.

Built-in audits:

- `journey.state-checks`: each declared state's own `expect` checks; see [State coverage](#state-coverage).
- `keyboard.focus`: focus behaviour of keyboard-only journeys; see [Keyboard-only journeys](#keyboard-only-journeys).
- `layout.horizontal-overflow`: the document is wider than the viewport in a state observed since the audit's previous checkpoint (severity `serious`). Playwright only; unsupported on macOS.
- `accessibility.axe`: an opt-in automated axe-core scan of web pages; see [Accessibility scan](#accessibility-scan-axe-core).
- `visual.baseline`: an opt-in screenshot comparison with reviewed baselines; see [Visual baselines](#visual-baselines).
- `layout.responsive` (opt-in; default checkpoints `ready` and `completion`): deterministic layout measurement at the session's viewport, then at each extra `matrix.breakpoints` entry and a reflow case, resized in place and restored (viewport and scroll position) before the journey continues. Rules (`rules`, default all three):
  - `clipping`: text or a control cut off by an `overflow: hidden`/`clip` ancestor, by more than `clipping.tolerancePx` (default 1). Severity `serious` when a control is cut, `moderate` for text. Visually hidden (1px) and collapsed containers are skipped. Declared truncation (`text-overflow: ellipsis`, `-webkit-line-clamp`) is a `needs_review` item, never a violation.
  - `occlusion`: a control scrolled into view (block and inline centre) is hit-tested at a 3x3 grid; another element covering its centre or at least `occlusion.minCoveredFraction` (default 0.3) of the points is a violation, smaller overlaps are `needs_review`. Its own labels and descendants do not count; controls behind an open modal are skipped. Checks the `requiredControls` targets (severity `serious`; a target that matches nothing makes the run `incomplete`), or every rendered interactive control when none are configured (`moderate`). Elements with `pointer-events: none` are transparent to hit testing and are not reported.
  - `target-size`: pointer targets smaller than `targetSize.minimum` CSS px (default 24, WCAG 2.2 SC 2.5.8, `moderate`; 44 for SC 2.5.5, `minor`). The 2.5.8 inline (a link in a sentence), spacing (a `minimum`-diameter circle touches no other target; on by default up to 24px, `targetSize.spacingExemption`) and labelled checkbox/radio exceptions are applied and noted in the run's limitations.
  - The matrix: `matrix.breakpoints` (`name`, `width`, `height`, optional `deviceScaleFactor`) plus `matrix.reflow` (default `{ "baseWidth": 1280, "baseHeight": 1024, "zoom": 4 }`: the 320x256 CSS viewport that 400% zoom produces, WCAG 2.2 SC 1.4.10; `false` turns it off). Reflow is emulated through the viewport, not browser UI zoom. A live page cannot change its device pixel ratio, so a breakpoint asking for another ratio is skipped and the run is `incomplete`. A breakpoint named like the session's viewport is that viewport, measured once. Extra breakpoints also report `document-wider-than-viewport` (`serious`); the session's own viewport is left to `layout.horizontal-overflow`, so the same overflow is not reported twice. Breakpoints are skipped (`incomplete`) once 60% of the audit's `timeoutMs` is spent, leaving time to restore the viewport.
  - `exceptions`: intentional layouts, each one `rule`, one CSS `selector` matched against the reported element or an ancestor (for occlusion also the covering element, e.g. decorative art), a `reason`, and optionally `breakpoints` (suite viewport or matrix names). Exempted items are listed in the run's `exemptions` with the measurement they suppressed; an exception that matched nothing is noted in `limitations`; an invalid selector is an `error` run.
  - Each finding's description starts with `[breakpoint WIDTHxHEIGHT]` and its tags include `breakpoint:<name>` (and `reflow`); the reproduction viewport is the session's. Boxes and measured values for every breakpoint, the exemptions and the exception ledger are written to `layout-<checkpoint>-step<N>.json` in the run directory and listed in the findings' evidence files. See `examples/responsive-layout.json`. Playwright only; unsupported on macOS.

Audits are registered in `src/audits/registry.ts` and declare the drivers that support them. Core audits read the states the runner already observed; session audits (`inspect`) use only the session's driver-neutral checks; driver audits run through the session's `runAudit` (for Playwright, `src/drivers/playwright-audits.ts`), which receives the audit config, checkpoint, the session's viewport, the run directory and the timeout, and only runs fixed engine code in the page. The report says which automated audits ran; an automated scan does not establish accessibility or standards conformance.

### Accessibility scan (axe-core)

`accessibility.axe` is an opt-in driver audit that runs [axe-core](https://github.com/dequelabs/axe-core) (through `@axe-core/playwright`) on the page at its checkpoints. It is web-only: on macOS it is reported as `unsupported`, never as clean. [examples/website-accessibility.json](examples/website-accessibility.json) shows it in a suite:

```json
"audits": {
  "checks": [
    { "id": "layout.horizontal-overflow" },
    { "id": "accessibility.axe", "at": ["ready", "completion"], "exclude": ["#support-chat"] }
  ],
  "failOn": "serious"
}
```

| Option      | Purpose                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `at`        | Checkpoints: `ready`, `states` and `completion`; default ready and completion                              |
| `include`   | CSS selectors of the regions to scan; empty scans the page. A selector that matches nothing is an audit `error`, not a clean region |
| `exclude`   | CSS selectors of regions to leave out, such as a third-party widget                                        |
| `tags`      | axe rule tags to run; default `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, `best-practice`       |
| `timeoutMs` | Bound on one scan, overriding `audits.timeoutMs`                                                           |

An axe violation becomes a `violation` finding with axe's impact as its severity; an axe *incomplete* result, a check axe could not decide (for example text contrast over a background image), becomes a `needs_review` finding. Each finding keeps the rule's help text, guidance link and tags (including WCAG criteria such as `wcag412`), the affected-element count and a sample of up to 25 elements: the element as `description`, its selector, axe's explanation as `reason` and an HTML snippet of at most 300 characters. An analyzer exception, a scope that matched nothing, a timeout or unreadable analyzer output is an `error` run whose detail names the kind (`scope_not_found`, `analyzer_exception`, `timeout`, `invalid_output`).

What a scan does not establish (each run's `limitations` repeats the coverage limits):

- An automated scan detects only a subset of accessibility issues. A run without violations does not establish WCAG conformance or any accessibility certification, and is not a substitute for a manual accessibility audit.
- `needs_review` findings are undecided, not passes.
- Keyboard operation and focus order are not tested by the scan; see [Keyboard-only journeys](#keyboard-only-journeys) and the `keyboard.focus` audit.
- Cross-origin frames are not scanned. The scan runs in the page itself, so it opens no second page in the browser context.
- HTML snippets are excerpts of the page under test and can contain its data; treat results like other run evidence.

### Visual baselines

`visual.baseline` is an opt-in driver audit that captures each configured checkpoint (default `ready`, the state before any agent action; `states` gives one named capture per declared journey state) and compares it with an approved baseline from a local directory you supply. A run never writes a baseline: captures stay in the run directory until you review them and approve them explicitly.

```json
"audits": {
  "checks": [
    { "id": "visual.baseline", "at": ["ready", "states"], "mask": ["#last-synced", "[data-testid=avatar]"] }
  ]
}
```

```sh
mkdir -p ~/ui-baselines            # outside Git (or a Git-ignored path such as .baselines/)
npm run run -- --suite suite.json --baselines ~/ui-baselines
# review visual-<checkpoint>-current.png in the run directory or report.html, then:
npm run baseline -- approve --run runs/<run> --baselines ~/ui-baselines --journey ID [--viewport NAME] [--checkpoint ready]
npm run baseline -- approve --run runs/<run> --baselines ~/ui-baselines --all          # after reviewing every capture
npm run baseline -- approve --run runs/<later run> --baselines ~/ui-baselines --checkpoint ready --replace   # an intended change
npm run baseline -- list --baselines ~/ui-baselines
```

| Option          | Purpose                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `at`            | Checkpoints: `ready`, `states`, `completion`; default `ready`                                                    |
| `mask`          | CSS selectors of dynamic regions (clocks, avatars, ads), painted over in every capture and not compared          |
| `fullPage`      | Capture the whole scrollable page instead of the viewport; default false                                        |
| `threshold`     | Per-pixel colour distance (pixelmatch, 0–1) below which a pixel is unchanged; default 0.1                       |
| `maxDiffPixels` | Changed pixels allowed; default 0                                                                                |
| `maxDiffRatio`  | Changed pixels allowed as a fraction of the compared pixels; default 0                                           |
| `severity`      | Severity of a mismatch finding, gating at or above `failOn`; default `serious`                                   |
| `maxCaptures`   | Screenshots taken, at most, until two consecutive ones are identical; default 5                                 |
| `networkIdleMs` | Best-effort wait for network idle before capture; 0 skips it; default 2000                                      |

Capture: after a best-effort network-idle wait and a wait for web fonts and images, screenshots are taken with CSS animations and transitions disabled (finite ones finished, infinite ones reset), the caret hidden and CSS-pixel scale, until two consecutive images are identical. Every capture goes through `protectedScreenshot` (`src/drivers/playwright-evidence.ts`) with the session's screenshot protection, so redacted text and evidence masks are painted before the image is rendered and never reach a baseline. The run's evidence protection (see [Evidence protection](#evidence-protection)) applies to these captures as to every other screenshot, so `capture.protected` is true in the environment of every capture in a run, on top of the audit's own `mask` selectors. Masked areas are solid `#FF00FF`; the boxes of every masked element, in the baseline and in the current capture, are left out of the comparison, and everything outside them is compared. A mask hides only what it covers: a masked element that grows and pushes other content still shows as a change there, so mask a fixed-size container when content around it moves. A mask selector that matches nothing is listed in the run's limitations.

Each run records a `visual` comparison with one status:

- `match`: compared with the approved baseline for this environment and within tolerance (run `clean`).
- `mismatch`: over tolerance, or the image size changed (run `findings`; one `visual.mismatch` finding whose targets are the changed regions and whose evidence files are the current, baseline and diff images).
- `missing`: no approved baseline for this suite, journey, checkpoint and viewport, or no `--baselines` directory was given (run `incomplete`).
- `incompatible`: baselines exist for the checkpoint and viewport, but none from this rendering environment; the report lists each differing field (run `incomplete`).
- `unstable`: the page never rendered the same image twice in `maxCaptures` (run `incomplete`); mask or wait for the changing part.

Only `match` passes: `missing`, `incompatible` and `unstable` make the check `inconclusive` and the verdict `not_evaluated`. The report shows baseline, current and diff images (red: changed, blue: darker now), the aggregate changed pixels against the tolerance, the changed regions (connected areas on a 16px grid, largest first) and the environment.

The compatibility environment is part of every baseline: viewport size, browser name, version, build (bundled, channel or executable) and headless mode, OS platform, architecture and major release, device scale factor, locale, timezone, colour scheme, reduced motion and the capture settings (`fullPage`, masks, whether evidence protection applied). Its hash names the baseline file: `<dir>/<suite slug>/<journey>/<checkpoint>/<viewport>/<environment id>.png` with a `.json` beside it holding the environment, the image checksum, the masked boxes, when it was approved and from which run. A baseline whose image no longer matches its checksum is an audit `error`.

Approval: `approve` reads the run's `results.json`, checks each selected capture against the checksum the run recorded and writes it as the baseline for the environment it was rendered in. `results.json` is redacted text, so when the suite's redaction rewrote a recorded path (a secret value that is part of the run directory's path, for example), the capture is found inside the run directory by that checksum; a suite name the suite's own patterns redacted is skipped, since its baseline location is unknown. Without `--journey`/`--viewport`/`--checkpoint` it requires `--all`. A capture that differs from an approved baseline is approved only with `--replace`; captures that already match or did not settle are skipped; captures from runs whose functional outcome did not pass need `--allow-failed-runs`. The run's `--baselines` directory must exist; `approve` creates it. Either refuses a directory inside a Git work tree unless Git ignores it (`.baselines/` is ignored in this repository), and a directory inside a run directory, which `--prune-runs` would delete with the run; pruning never deletes a baseline directory, which carries no run manifest. Baselines and diff images are run evidence and are never committed; shared storage needs an approved destination and privacy policy.

Calibration (`test/visual-baseline.test.ts`, local Chromium, prints its numbers as test diagnostics): five fresh captures of each fixture page (gradients, shadows, SVG, a raster image, a focused field, a CSS transition and an infinite animation) differ by 0 pixels; seeded changes differ by about 700 pixels (one word on a button), 3,900 (an accent colour) and 7,600 (a 2px move). The default tolerance is therefore 0 changed pixels at colour threshold 0.1: comparisons are only made within one rendering environment, where rendering was deterministic. Raise `maxDiffPixels` per suite if a target shows nondeterministic rendering, after measuring it. Web only: unsupported on macOS.

## Authentication and browser selection

For applications behind a login, capture a session once:

```sh
npm run run -- --suite suite.json --login .auth/app.json
```

This opens a visible browser at the suite's `baseURL`. Sign in, then press Enter in the terminal. To convert an existing Playwright storage-state file instead, add `--from existing.json`. Either way, the saved file keeps only cookies and localStorage for the origins the suite declares: `baseURL`, `allowedOrigins`, `applicationOrigins`, and the origins in `allowedRequests` and `readOnlyPosts`. Other identities the login browser picked up, such as SSO-provider or personal Google cookies, are dropped. The file is written with mode 0600 under the gitignored `.auth/`, and the CLI prints the kept and dropped counts (never values). Then run with it:

```sh
npm run run -- --suite suite.json --storage-state .auth/app.json --video
```

Every run applies the same scoping when it loads a session, and logs a `storage_state_scoped` event with the kept and dropped counts. Foreign session material therefore never reaches the test browser or its traces, even from an unscoped file. A session expires on the application's schedule; capture it again when runs report `blocked`.

For applications whose sign-in does not survive a storage-state file (device binding, IndexedDB, service checks), use a dedicated persistent test profile instead. Sign in once, then pass the same `--profile` to every run:

```sh
npm run run -- --suite suite.json --profile .auth/profiles/app --sign-in
npm run run -- --suite suite.json --profile .auth/profiles/app
```

The runner creates the directory (mode 0700) and marks it as its own. It refuses a directory inside a browser's data location (`~/Library/Application Support`, `~/Library/Containers`, `~/.config`, `~/.mozilla`, …) and any existing non-empty directory it did not create, so a personal or copied browser profile is never opened. A profile holds the whole browser state, not only the suite's origins, so sign in only to the application under test. `--profile` cannot be combined with `--storage-state` or `--login`.

The runner never extracts a personal browser profile: there is no option to read cookies or sessions from an installed browser, and unknown options are rejected. Runs use isolated contexts, or the dedicated profile above.

Override the target URL with `--url`, the engine with `--browser`, or use `--headed` for a visible test browser. Install the selected runtime with `npx playwright install firefox` or `npx playwright install webkit`. Browser integration tests and the bundled demo currently verify Chromium only; Firefox/WebKit are configurable but unverified in this checkout.

## macOS apps

The same engine tests native macOS apps through the accessibility API. Planner, selector, loop and stall handling, `--repeat`, usage accounting and reports work unchanged.

**Requirements:** macOS 14 or newer, and the Xcode Command Line Tools (`swiftc`; full Xcode is not needed); a small helper (`native/macos/ax-helper.swift`) is compiled into `.build/` on first use. The app that runs the CLI (Terminal, iTerm, …) needs **Accessibility** and **Screen Recording** permission (System Settings → Privacy & Security). The runner checks both and stops with a clear error if either is missing.

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
- **Actions offered:** visible, enabled, named controls that support pressing (buttons, links, checkboxes, radios, tabs, menu items, pop-ups); rows of lists, tables and outlines (`Select row <text>`, role `option`, named by their text), which are selected rather than pressed, and are offered only when not already selected; configured `click`/`fill`/`check` interactions; page scrolling of scroll areas; and wait. The native page-scroll action is verified against the scroll bar; when a toolkit reports success without scrolling (SwiftUI does), the scroll bar is moved by about one page instead.
- **No synthesized input:** every action is an accessibility action on an element the driver offered (press, select, set value, scroll bar value). No mouse or keyboard events are sent. A control that offers no `AXPress`, such as a view that reacts only to the mouse, is not offered, even as a configured `click` or `check`; it is logged as `candidate_skipped` with reason `no_accessibility_action`. `press` interactions are rejected when the suite is parsed, and `select` interactions are not supported yet.
- **Electron and Chromium apps** build their accessibility tree only when an assistive client asks. When a window shows fewer than 30 elements, the driver sets `AXManualAccessibility` once; only if the app accepts it does the driver wait for the tree (and then also try `AXEnhancedUserInterface`). Apps that reject the attribute are not asked again or waited on. Both steps are logged (`accessibility_enabled`, `accessibility_tree`).

**Menu-bar commands** are opt-in per suite with `"menus": true`. The driver reads the menu bar through the accessibility API without opening any menu. Each enabled command becomes `Choose menu File › New`, up to 80 per step, and is pressed directly, so no menu is opened visibly; an open menu would block the app's accessibility while it tracks. Never offered:

- the Apple menu, and the whole Window and Help menus;
- anything under Services;
- commands matching the general blocklist (quit, close, delete, save, …), and the menu-only list: open/recent/import (they reveal your files), print/page setup, share, hide, minimize, zoom, full screen, revert, bring all to front, and system-provided items that act outside the app (dictation, emoji & symbols, AutoFill/passwords/contacts, Writing Tools, speech).

Parent menu names are checked only against the menu-only list, so a menu called "Format" is not blocked. Blocked commands are logged as `candidate_skipped` (role `menuitem`). Before a press, the driver re-reads the menu item and rejects it as stale if it was removed, renamed or disabled.

**Safety model** (instead of the web request policy):

- Controls whose names match `blockedControls` are never offered: delete, remove, trash, send, post, buy, pay, subscribe, quit, log/sign out, empty, reset, uninstall, discard, install, upgrade, stop, pause, disable, deactivate, disconnect, unlink, and file side effects (save, export, overwrite, replace, rename, duplicate, move to) by default; suites can add patterns. Blocked controls are logged as `candidate_skipped` with reason `blocked`. Interactions a suite configures explicitly are allowed.
- Title-bar buttons (close, minimize, zoom, full screen) are never offered.
- Before every press, the driver re-reads the exact accessibility element it offered, and rejects the action as stale if the element is gone or its role, name, identifier or enabled state changed.
- A journey leaves its scope (`blocked`) when an action brings a different app to the front (for example, a link that opens the browser), or when the target app quits or loses its window. A window counts as present when accessibility lists it, or when the window server shows an on-screen window of the app while accessibility briefly lists none (during a title change or under load). Each probe that waited, fell back or failed is logged as `scope_probe`. Runs work in the background: accessibility actions target the app's elements directly and window captures do not need the window in front or on the current Space, so you can keep using the Mac while a suite runs.
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
- `src/friction/`: task-friction summaries computed from a run's event stream, reference-path comparison and the review rubric.
- `src/identity.ts`, `src/compare.ts`, `src/gate.ts`, `src/compare-files.ts`, `src/compare-report.ts`, `src/compare-cli.ts`: run identity, finding identity, compatible-run comparison, gates and `npm run compare`.

`runSuite(suite, models, options)` can be called from another TypeScript project. Supply a `UIDriver` in `options.driver` to replace the browser implementation while preserving the journey engine. This version supports websites, browser applications and macOS apps; other native platforms (Windows, mobile) are not implemented.

The planner refreshes when executable action opportunities change, on full-URL navigation (including query/hash), after action errors or no progress, after `no_match`, before revisiting an already-tried action state (see Loop detection), and at most five decision steps after its last refresh. Candidate IDs, ordering and wheel hit-point movement do not count as new opportunities; unrelated background text updates alone do not force a refresh. Newly revealed menu links therefore replace an obsolete expand-menu objective before another selection. The HTTP planner receives only candidate IDs/kinds/descriptions alongside the screenshot and viewport, not executable selectors or configured values. It also receives `refresh`: the refresh reasons and, for `revisited-state`, the action the selector was about to repeat. Custom `Models.plan` implementations get this context as an optional sixth argument. Drivers that implement `UISession.offeredControls()` (Playwright does) report the observed-control name of each offered action. Discovery computes that name with the same function the viewport projection uses, so the match is exact. The planner's visible controls are then marked `offered: true/false`, next to a constraint that controls with `offered: false` cannot be used. Without this, screenshot-aware planners tend to aim at visible links outside `allowedPaths`. The marking reduces this but does not eliminate it.

Custom `Models.plan` implementations can consume the optional fifth `actions` argument; existing implementations can ignore it. `plan` and `choose` also receive an optional seventh `signal` argument, the journey's deadline signal; an implementation should stop waiting when it aborts. `plan` events include `refreshReasons`. More frequent actionable changes can increase planner calls; this is a relevance policy, not a measured cost or model-quality improvement. The selector chooses from offered actions and records its probability distribution. Model UX concerns are hypotheses for human review. These are synthetic task probes, not calibrated human personas or measured human usability scores.

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

Each run uses a fresh private directory under `runs/`: every file in it is mode 0600 and every directory 0700, including what Playwright and `screencapture` write (screenshots are written by the runner with 0600; traces, videos and their directories are restricted when the journey ends). `--out` can choose another new directory. Existing runs are never overwritten: a run refuses a directory that already exists. Each run directory starts with a `run.json` manifest (creation time, `deleteAfter` from `evidence.retentionDays`, `uploaded: false`). The runner never uploads or deletes evidence on its own; `npm run run -- --prune-runs runs [--dry-run]` deletes the run directories whose retention has passed, and only directories carrying a valid manifest (other directories, files and symlinks are skipped).

Model-driven journeys are stochastic, so one run is not a pass rate. `--repeat N` (1–50) runs each selected journey and viewport N times in sequence, each with its own evidence directory (`<journey>-<viewport>-<n>`). The CLI prints `passed/runs` with median actions and duration per journey/viewport. Every result records its `attempt` and its `usage`: per role (planner, selector), the call count, total latency, and input/output tokens. Usage is taken from `model_call` events, from `prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens`, and counts as zero when a provider omits it. Token counts are not converted to cost.

For a pinned, repeated comparison across a small reviewed set of suites, with required ceilings on model requests, tokens and wall time, use the opt-in live-model benchmark (`npm run benchmark`, see [docs/benchmark.md](docs/benchmark.md)). It reports completion with sample size and a 95% interval, separates model quality from harness correctness, and records missing usage as unknown.

Once the suite, credentials and session are supplied, the CLI executes without interactive action prompts. Use `--headed --video` to watch the browser and keep a recording. Headed Chromium is pinned to device scale factor 1. Without that, on Retina/HiDPI displays each per-step screenshot briefly re-renders the window at the display's pixel ratio, a visible flicker every step. With the pin the window looks slightly softer; page `devicePixelRatio` and screenshots are unchanged. The CLI prints the live log path at startup; follow it in another terminal with `tail -f runs/<run>/events.jsonl`. Open `report.html` after completion for outcomes, screenshots, video and traces.

- `report.html`: a summary table per journey/viewport (pass rate, other outcomes by category and reason, quality verdicts, median agent actions and agent duration, model calls and tokens), then each run's functional outcome, its quality verdict and coverage, its audit runs with violations and needs-review items listed apart, its [task friction](#task-friction) with links to the observed steps, and evidence links. Results are redacted text, so a recorded path can contain `[REDACTED:<label>]` when a secret is part of it; the report still links the file without printing the secret: a path whose secret is only in the run (or baseline) directory's own location is linked relative to the run directory, and a path redacted below it is matched to the one file it names and linked through `evidence-links/<content sha256, 16 hex>.<ext>` in the run directory (a hard link to a file inside the run, a private copy of one outside it, such as an approved baseline). A redacted path that names no file or several is not guessed: it links to the in-page anchor `#evidence-path-redacted`.
- `summary.json`: the same summary as data.
- `events.jsonl`: observations, plans, model responses/timings, candidate probabilities, actions, console/network observations and request-policy blocks.
- `results.json` (and each run's `result.json`): checks, statuses, outcome codes, quality verdicts, findings and audits. The contract is `resultVersion: 4`, published as `schemas/result.schema.json` and parsed by `parseResults` in `src/results.ts`. Version 2 kept every version-1 field (`status`, `reason`, `checks`, `findings`, …) and added `resultVersion`, `outcome` and `quality`. Version 3 adds `audits` (`contractVersion: 1`: configured audits, runs per checkpoint, audit findings, checkpoints not reached); the horizontal overflow check moved from an `overflow` finding to an audit finding, and quality checks gained `source: "audit"` with an `audit` field indexing `audits.runs` and the gating `audits.findings`. Version 4 adds `evidence` (each evidence format's status, protection and destination, the redacted environment names and setup value keys, and the protection's limitations for the run, see [Evidence protection](#evidence-protection)) and makes `trace` nullable: `null` when no trace was captured; its audits use `contractVersion: 2`, which adds a `visual` record (the baseline comparison of a `visual.baseline` run, `null` for every other audit) to audit runs. Version 4 also adds `dataLifecycle` (present only with a configured lifecycle: service, run, reset/setup/cleanup records with durations and details, the cleanup trigger and remaining records, the setup value keys and `clean`), the `data_setup_failed` and `run_cancelled` codes and the `cancelled` category, the optional `friction` summary (see [Task friction](#task-friction); absent in results written before it), and an optional `identity`: what the run measured, used to compare runs (see [Comparing runs](#comparing-runs)); results without it are still version 4 but cannot be compared.
- Per journey/viewport: screenshots, Playwright trace and optional video, when the evidence policy allows them.

Open traces locally with `npx playwright show-trace runs/<run>/<journey>-<viewport>/trace.zip`. Artifacts may contain private application data, session material and request bodies. They are ignored by Git and never automatically uploaded.

### Evidence protection

`evidence` in the suite (strict; every field optional) decides what leaves the machine, what stays local, and how each format is protected:

```json
"evidence": {
  "redact": [{ "pattern": "ACME-CASE-\\d{6}", "label": "case-id" }],
  "redactEnv": ["APP_PASSWORD"],
  "masks": [{ "by": "testId", "value": "account-number" }],
  "providerScreenshots": true,
  "trace": "auto",
  "video": "auto",
  "retentionDays": 30
}
```

**Provider-visible** (sent to the planner and selector endpoints, after redaction): the journey goal and persona, the current URL, visible viewport text and control names and values, offered action descriptions and link destination paths, recent action history, the planner's objective, and the masked viewport screenshot (planner only; `providerScreenshots: false` withholds it). **Local-only** (the run directory): everything else, including the accessibility snapshot, selectors and configured values, the event log, results, the report, screenshots, audit findings and files, traces and videos.

- **Text redaction** applies to model payloads, `events.jsonl`, `suite.json`, results, the summary, the report, CLI error output, and every text file a driver or audit writes in the run directory (a final sweep). It replaces matches with `[REDACTED:<label>]`: the suite's `redact` patterns (JavaScript regular expressions; a pattern that matches empty text is refused), the values of the variables in `redactEnv` (and of every fill `valueEnv`), every secret `dataLifecycle` setup value once setup returns it (`[REDACTED:data:<key>]`; see `publicValues`), the values of every environment variable whose name marks it as a credential (`…_KEY`, `…_TOKEN`, `…_SECRET`, `…_PASSWORD`, … at least 8 characters, model gateway header values included), and built-in credential shapes (bearer tokens, JWTs, `sk-`/GitHub/AWS/Slack/Google keys, private key blocks, URL user info, credential-like URL parameters and `password=`-style assignments). String values under credential-named keys (`authorization`, `cookie`, `password`, …) are replaced whole. **Short secrets** are not redacted: a declared value (a `redactEnv` or `valueEnv` variable, a gateway header value, a secret setup value) shorter than 4 characters is left in text, because a 1–3 character string occurs throughout ordinary evidence (step counts, ports, timestamps, selectors) and replacing every occurrence would corrupt the evidence while the pattern of replacements would itself point at the value. The gap is made visible instead: the CLI prints a `Warning:` line naming the variable when it loads the suite (`--validate` included), and every result lists it in `evidence.limitations`, shown at the top of the report's evidence section (setup values only on the runs that returned them); the name is given, never the value or its length. A masked fill field is still masked. Use test values of at least 4 characters. Discovered credential-named variables shorter than 8 characters are skipped without a warning. Patterns and secret values are never written to evidence; results record only their counts and, in `evidence.redactedEnv`, the names of the variables whose values were redacted (declared in `redactEnv` or discovered by their credential-like name), so a reviewer can see which environment values a run treated as secret.
- **Screenshot masks** are applied before capture (Playwright `mask`): the configured `masks` targets, elements whose text matches a redaction pattern or secret value, and input fields whose value matches are covered with solid magenta while the image is rendered, so the written file and the image sent to the planner never contain them. Masks cannot reach text drawn into images or canvases, or content in cross-origin frames. macOS window captures cannot be masked: `masks` is refused for macOS suites, their screenshots are reported `not_sanitized`, and a macOS suite that declares `redact` or `redactEnv` does not send screenshots to the planner.
- **Traces and videos** cannot be sanitized (a Playwright trace holds DOM snapshots, network traffic including cookies and bodies, and unmasked screenshots; a recording cannot be masked). With `auto` (the default), a suite that declares sensitive content (`redact`, `redactEnv` or `masks`, a fill `valueEnv`, or a journey using a secret `dataLifecycle` setup value) captures neither, even with `--video`, and an authenticated run (`--profile` or `--storage-state`) captures no trace. `off` never captures; `local` captures unsanitized and is refused for a suite that declares sensitive content. The macOS accessibility-tree `trace.json` is text and is redacted.

Every result's `evidence` lists each format (`model_payloads`, `provider_screenshots`, `screenshots`, `trace`, `video`, `event_log`, `results`, `report`, `audit_files`) as enabled or disabled, with its protection (`redacted`, `masked`, `not_sanitized`), its destination (`provider` or `local`) and the reason; the report shows the same, and the run's first event is `evidence_policy`.

**Redaction is not a guarantee.** It removes the patterns, values and elements it is given and well-known credential shapes; it cannot recognize arbitrary unknown sensitive content (names, addresses, free text, images). Declare what a suite's application shows, prefer test accounts and synthetic data, and keep run directories local.

Missing auth, unauthorized responses or an unmet readiness check are `blocked`; repeated actions, no path forward or exhausted budgets are `failed`; model and infrastructure problems are `error`. A task can pass with visual or runtime findings still requiring review. Exit codes: **0** all asserted outcomes passed, **1** at least one non-passing journey or a failed data cleanup, **2** configuration/startup error. Exit codes follow the functional outcome (and data cleanup) only; the quality verdict is reported beside it and does not change the exit code. With `--compare BASE_RUN`, a failed comparison gate is also **1**, and **3** means the runs are incompatible (see [Comparing runs](#comparing-runs)).

### Outcome codes

Every result's `outcome` names why the journey ended with a stable `code`, its `category` and its `source`. Each code fixes its status, category and source, so the same failure always classifies the same way:

| Status | Code | Category | Source |
| --- | --- | --- | --- |
| passed | `assertions_passed` | passed | assertion |
| failed | `content_readiness_timeout` | assertion_failure | assertion |
| failed | `repeated_action` | agent_loop | agent |
| failed | `selector_no_path`, `recovery_scroll_stalled` | agent_no_path | agent |
| failed | `budget_max_steps`, `budget_deadline`, `budget_deadline_before_stage`, `budget_stage_timeout`, `budget_deadline_abort` | budget_exhausted | unknown |
| failed | `budget_model_rate_limit` | budget_exhausted | model |
| blocked | `ready_not_reached`, `setup_not_offered`, `setup_action_failed` | precondition_failure | unknown |
| blocked | `data_setup_failed` | precondition_failure | environment |
| blocked | `setup_stale_action` | stale_action | harness |
| blocked | `scope_exit` | policy_block | harness |
| blocked | `unauthorized_response` | auth_failure | environment |
| error | `model_call_failed`, `model_invalid_output` | model_error | model |
| error | `driver_capability_missing` | infrastructure_error | harness |
| error | `driver_error`, `evidence_capture_failed`, `session_cleanup_failed` | infrastructure_error | unknown |
| error | `run_cancelled` | cancelled | harness |
| error | `journey_not_finished`, `unclassified_error` | unknown | unknown |

Only `source: "assertion"` is evidence about the application: an independent outcome assertion was evaluated. A loop, a missing path or an exhausted budget describes the agent's run, not a product defect, and causes the tests cannot tell apart stay `unknown`. A content wait cut short by the journey deadline is `budget_deadline`, not `content_readiness_timeout`. The outcome also records the deciding `stage` and `step`, a `detail` (first error line), and `evidence`: the deciding screenshot, the `events.jsonl` event names that record the decision, and the indices of `checks` that were false. `signals` counts stale actions, action errors, request-policy blocks and browser errors during the run; they may explain an outcome without being its cause.

### Quality verdict

`quality` is judged separately from the functional outcome and never changes it: a journey can be `passed` with quality `fail`. The verdict is `pass` only when at least one check executed, every executed check passed, and every configured audit ran and is supported; any failed check is `fail`; no executed check, an `inconclusive`/`errored` check without a failure, or a configured audit that was unsupported or never ran, is `not_evaluated`, which is not a pass. Each configured audit is one check (`source: "audit"`): `failed` with a violation at or above `failOn`, else `errored` with an error run, else `inconclusive` with an incomplete run, else `passed`. `executed` lists each check with its status, the number of observed states it measured and the findings it produced; `skipped` lists applicable checks that did not run (for example when no state was observed); `unsupported` lists checks this platform or engine version does not perform.

Besides the configured audits (see [Audits and checkpoints](#audits-and-checkpoints)), a built-in check covers the whole web run:

- `runtime.browser-errors`: uncaught page errors or HTTP 5xx responses. `inconclusive` when the test's request policy blocked requests to the suite's own origins, which can cause such errors; `errored` when evidence capture failed before they were recorded.

The macOS driver supports neither the overflow audit nor this check, so native results are `not_evaluated`, with the audit listed as unsupported. Keyboard/focus checks are listed as unsupported unless the [`keyboard.focus`](#keyboard-only-journeys) audit is configured. `visual.baseline` is listed as unsupported unless the opt-in [visual baseline](#visual-baselines) audit is configured. `accessibility.audit` is listed as unsupported unless the opt-in [`accessibility.axe`](#accessibility-scan-axe-core) audit is configured; that scan is automated and partial, and its runs list what it does not cover. Model concerns (`hypothesis` findings), detours, loops and policy-block findings never affect the verdict.

The journey deadline (`maxDurationMs`) is enforced between stages as well as inside them. Planner, selector and action dispatch never start after it has passed. A Playwright or model `TimeoutError` raised at or after the deadline is reported as `failed` with the stage it cut off (for example `Task budget exhausted before the outcome was observed (choose timed out at the deadline)`), not as `error`. Each journey passes one `AbortSignal` to every planner and selector call, aborted at the deadline with a `TimeoutError` reason, so a queued or in-flight model request stops there. A model call that ends at the deadline is `budget_deadline_abort`, whether the journey signal, the request's own timeout or the limiter's slot wait fired first; an abort before the deadline stays `error`. A `budget_exhausted` event records the step, stage, cause (`deadline_before_stage`, `timeout`, `deadline_abort`, or `rate_limit` when the model limiter refuses a request whose cooldown would end past the deadline), the first error line and the overrun. An action whose dispatch timed out at the deadline is not filed as an `action-error` finding. Timeouts before the deadline and non-timeout failures at any time remain `error`. Interactive planning time counts against the deadline, so a late answer ends the journey as a budget failure.

## Comparing runs

A comparison answers what changed between a **base** run (for example the last release) and a **candidate** run (the build under review) of the same suite: which findings are new, which persist, which are resolved and which the candidate could not assess, and whether the candidate passes a configurable gate.

```sh
npm run run -- --suite suite.json --build 4f1c2e9 --out runs/base
npm run run -- --suite suite.json --url https://preview.example --build 9a7b3d1 --out runs/candidate
npm run compare -- runs/base runs/candidate [--gate gate.json] [--out NEW_DIRECTORY]
# or in one step, comparing the new run with an earlier one:
npm run run -- --suite suite.json --build 9a7b3d1 --compare runs/base [--gate gate.json]
```

`npm run compare` writes `comparison.json` (contract: [schemas/comparison.schema.json](schemas/comparison.schema.json)) and `comparison.html` into `--out` (a new directory; default `comparison-<time>` inside the candidate run, so `--prune-runs` removes it with the run), and prints the counts, warnings and gate failures. `--compare` writes the same files into the new run's `comparison/` directory. Nothing is uploaded; evidence links point into the local run directories.

| Exit code | `npm run compare` | `npm run run -- --compare` |
| --- | --- | --- |
| 0 | compatible runs, gate passed | every journey passed and the gate passed |
| 1 | compatible runs, gate failed | a journey did not pass, a data cleanup failed, or the gate failed |
| 2 | usage or input error: missing or corrupt `results.json`, invalid gate file, the same run twice, an existing `--out` | configuration or input error (the gate file and the base run are checked before the run starts) |
| 3 | the runs are incompatible: the comparison is invalid | the same |

**Run identity.** Every result records `identity`: the build (`--build ID`, else the `UIUX_BUILD` variable, else `null`; it is never guessed from Git or the deployment), the suite (its name, a SHA-256 of the normalized suite configuration after redaction, without `baseURL` and `evidence.retentionDays`, so secret values never feed it and a new preview host is the same suite; the tested `target` origin; and the selected journeys, viewports and repeat count), the engine (`package.json` version, result and audit contract versions), the environment (platform, driver, browser name, version, build and headless mode, OS platform, architecture and major release, Node.js) and the model configuration (planner and selector protocol, endpoint origin and path, and model name; never keys, headers, user info or query strings; `null` for a custom `Models` implementation such as the scripted demos). The identity goes through the run's redaction like the rest of the result.

**Compatibility.** Two runs are compared only when they measured the same thing: the same identity and contract versions, engine version, suite hash, platform, driver, browser (name, build, version, headless), OS platform and architecture, and model configuration. Otherwise the comparison is invalid (exit 3): `compatible` is false, `incompatibilities` lists each differing field with both values and why it matters, and no finding is classified. A run without `identity`, or with another `resultVersion`, is incompatible too. Unknown builds, the same build on both sides, a different OS release or Node.js version, another target origin and a different journey/viewport selection are `warnings`.

**Finding identity.** Each finding gets a stable `id` that leaves out what changes between runs of the same UI: steps, timestamps, screenshots and evidence paths, the run's `{{marker}}`, URL origins, queries and fragments, candidate ids, and digits in descriptions (pixel sizes, counts, ports). An audit finding is identified by journey, viewport, audit, rule, its first checkpoint, the URL path it was measured on, its tags and **each sampled target** (the selector, or the description without digits when there is none), so one more element breaking a known rule is new while the known elements persist; `groupId` ties the targets of one finding together. A runner finding (detour, policy block, action error, browser error, loop, selector recovery, data cleanup, model hypothesis) is identified by journey, viewport, kind, category and its description without digits. Repeats of a journey/viewport are merged: a finding seen in any attempt counts.

**Classification.**

- `new`: only the candidate reports it.
- `persisting`: both report it. `escalated` when it gates in the candidate but did not in the base (a higher severity, or `needs_review` that became a violation).
- `resolved`: only the base reports it, **and** the candidate assessed the same audit at the same checkpoint (`clean` or `findings`), on the same page when the finding was measured at its checkpoint's page, and did not sample other elements of the same still-failing rule.
- `unassessed`: only the base reports it and the candidate cannot show it is gone, with a `reason`: `run_missing` (the candidate did not run the journey/viewport), `not_run`, `not_reached` (checkpoint configured but never reached), `unsupported`, `error`, `incomplete` (for example a visual check with no approved baseline, `missing`), `path_not_assessed` (the checkpoint was reached on another page) or `sampled`. A missing check, baseline or errored audit is never an improvement.

`checks` lists every audit checkpoint either run configured or recorded with its state on each side (`assessed`, `incomplete`, `error`, `unsupported`, `not_reached`, `not_run`); `coverageLost` marks the ones the base assessed and the candidate did not, so a check that stopped running cannot pass as "no new findings". `outcomes` compares the functional pass counts per journey/viewport.

**Gates.** The gate is a JSON file ([schemas/gate.schema.json](schemas/gate.schema.json)), validated when it is loaded; every field is optional:

```json
{
  "failOn": "serious",
  "persisting": false,
  "unassessed": "fail",
  "outcomes": "regressions",
  "needsReview": false,
  "hypotheses": false,
  "observed": false,
  "rules": [
    { "id": "accessibility.axe/color-contrast", "failOn": "moderate" },
    { "id": "layout.responsive/*", "gate": "never" }
  ]
}
```

| Field | Default | Fails the gate on |
| --- | --- | --- |
| `failOn` | the suite's `audits.failOn` | new or escalated violations at or above this severity (`none`: no severity gates); a violation with no severity gates at every level except `none` |
| `persisting` | `false` | also gating findings present in both runs |
| `unassessed` | `fail` | gating base findings the candidate could not assess, checks that lost coverage and journeys/viewports the candidate did not run; `report` lists them without failing |
| `outcomes` | `regressions` | a journey/viewport that passed in every base run and not in every candidate run; `any`: any non-passing candidate run; `ignore` |
| `needsReview` | `false` | also `needs_review` items |
| `hypotheses` | `false` | also model hypotheses (unreviewed model output) |
| `observed` | `false` | also the runner's own findings (detours, policy blocks, action and browser errors …), which have no severity |
| `rules` | none | per rule: `id` is `<audit id>/<rule id>`, `<audit id>/*`, `finding/<category>` or `finding/*` (an exact id wins); `gate: "never"`, `gate: "always"` or a `failOn` of its own. Unknown audit ids are rejected |

Each failure in `gate.failures` has a `code` (`new_finding`, `escalated_finding`, `persisting_finding`, `unassessed_finding`, `coverage_lost`, `run_missing`, `outcome_regression`, `outcome_not_passed`), a message and the finding id. The gate is separate from each run's quality verdict and functional outcome, which it does not change: a candidate whose journeys all pass fails the gate on a new serious violation.

Comparison output is redacted with the environment's credential values and both runs' declared `redact` patterns and `redactEnv` variables (read from their `suite.json`), on top of the redaction the runs already applied. Limits: identities rely on the analyzer's selectors, so generated ids or classes in selectors (for example framework-generated `:r1:` ids) make a finding look new; a finding whose page path contains a per-run value other than the `{{marker}}` (for example a `{{data.*}}` value) does too. Comparing two single runs of a model-driven journey compares one path each; use `--repeat` on both sides when paths vary.

## Development

```sh
npm run typecheck
npm run schema
npm test
npm run demo
```

Tests use real Chromium against local synthetic pages with deterministic model HTTP responses; none need credentials or network access beyond localhost. CI installs Chromium and runs these checks without model credentials. No run evidence is uploaded by CI.

Current limits: redaction covers declared patterns, credential environment values and known credential shapes only (see [Evidence protection](#evidence-protection)); no Windows or mobile drivers, shared baseline storage (visual baselines are local only), complete accessibility audit (the axe-core scan is automated and partial), price-based cost accounting (tokens are counted) or a live model-quality baseline (the opt-in [benchmark harness](docs/benchmark.md) exists; no live results or release thresholds yet). Live pass rates depend on the models and the suite's scope; measure them per target. Browser behavior and application assumptions need validation on each target.

API references: [TypeSafe](https://docs.typesafe.ai/api), [OpenRouter](https://openrouter.ai/docs/api_reference/overview), [Playwright](https://playwright.dev/docs/intro).
