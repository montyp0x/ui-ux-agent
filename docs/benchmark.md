# Live-model benchmark

The benchmark measures how the configured planner and selector models do on a small, reviewed set of suites, with a pinned model configuration, repeated runs and hard ceilings on model requests, tokens and wall time. It reuses the normal runner and its `--repeat` support; every target produces an ordinary run directory (`results.json`, `events.jsonl`, `report.html`, evidence) next to the benchmark's own report.

**Status:** the harness exists and is covered by the deterministic suite against a local fake model server. No live benchmark has been run yet, so there are no live results and no release thresholds.

## Opt-in and what never runs it

A live benchmark makes paid model calls. It starts only when **both** are present:

- the `--live` flag, and
- `UIUX_LIVE_BENCHMARK=1` in the shell environment (an `--env-file` is read only after this check, so the opt-in cannot come from a credentials file).

It is refused whenever `NODE_TEST_CONTEXT` is set, so `npm test` (Node's test runner) can never start one, whatever the environment says. The tests use `mode: "fixture"`, which only talks to loopback model endpoints and labels its report "not a live model measurement". The CLI has no fixture mode.

Credentials come from the shell environment or an explicit `--env-file PATH`; unlike `npm run run`, the benchmark does not read `./.env` on its own. Keys never go in the benchmark config: endpoint URLs with credentials, a query string or a fragment are refused.

## Commands

```sh
# 1. Check the config, its targets (with their sha256) and its bounds. No model call, no opt-in needed.
npm run benchmark -- --config examples/benchmark.json --validate

# 2. Run it live (paid model calls, bounded by the ceilings below).
UIUX_LIVE_BENCHMARK=1 npm run benchmark -- --config examples/benchmark.json --live \
  --env-file .env.benchmark --out runs/benchmark-2026-11-12

# 3. Later, after reviewing findings: rebuild the report with reviewer labels. No model call.
npm run benchmark -- --report runs/benchmark-2026-11-12 --labels labels.json
```

`--headed` shows the browser. Ctrl-C cancels: the run in progress stops, its data cleanup runs, no further run starts and the report is still written (stop reason `cancelled`). The command exits 0 once a report is written (a benchmark measures; it does not gate), and 2 on a refused config, missing opt-in or startup error.

Before a real run, copy `examples/benchmark.json`, replace the reviewer, point `suite` at your reviewed suite, set `sha256` to the value `--validate` prints, and pin exact model ids (an alias such as `jev-latest` can change between runs).

## Configuration

```json
{
  "benchmarkVersion": 1,
  "name": "Documentation discovery, pinned planner and selector",
  "targets": [
    {
      "id": "docs-install-desktop",
      "suite": "website.json",
      "sha256": "<printed by --validate>",
      "journey": "find-installation",
      "viewport": "desktop",
      "reviewed": { "by": "Reviewer Name", "on": "2026-11-11" }
    }
  ],
  "model": {
    "plannerURL": "https://openrouter.ai/api/v1/chat/completions",
    "plannerModel": "openai/gpt-6-astra",
    "selectorProtocol": "typesafe",
    "selectorURL": "https://api.typesafe.ai/v1/systemone",
    "selectorModel": "jev-latest",
    "plannerRateLimit": { "rpm": 60, "concurrency": 2 },
    "selectorRateLimit": { "rpm": 300, "concurrency": 4 }
  },
  "repeat": 5,
  "ceilings": {
    "maxModelCalls": 150,
    "maxTokens": 1500000,
    "maxWallTimeMs": 900000,
    "unknownUsage": "stop"
  }
}
```

- `targets` (1–10): each names a suite file (relative to the config), optionally one journey and/or viewport, an optional `sha256` pin of the suite file (a mismatch is refused), an optional dedicated `profile` or approved `storageState` for suites that require auth, and who reviewed it (`reviewed`, required). Target ids name the run directories.
- `model`: the pinned configuration. These values override any `PLANNER_*`/`SELECTOR_*` endpoint, model, protocol and rate-limit variables in the environment (the report lists the variables it overrode); keys and headers still come from the environment, as in [Credentials](../README.md#credentials). An unpinned rate limit uses the engine default, not the environment's.
- `repeat` (2–50): runs per journey/viewport. One run is not a pass rate.
- `ceilings`: all four are required; a config without any of them is refused before anything starts.

## What the ceilings bound

| Ceiling | Enforcement |
| --- | --- |
| `maxModelCalls` | Counts every HTTP request to the planner and selector endpoints, retries and 429/503 attempts included. Each request is checked right before it is sent; the request that would exceed the ceiling is never sent. Requests sent ≤ `maxModelCalls`, always. |
| `maxTokens` | Input + output tokens the providers reported. Checked after each response and before each request, so the total can pass the ceiling by at most the one response that reached it (a planner response is capped at 1,200 output tokens; its input includes the screenshot). |
| `maxWallTimeMs` | From the start of the benchmark. At the ceiling it aborts in-flight model requests, sends no more, cancels the run in progress (its data cleanup still runs) and starts no further run. Cleanup and closing the browser come on top. |
| `unknownUsage` | A request whose usage is unknown (no usage in the response, or no accepted response: failed, timed out, aborted or rate-limited) makes the token total unknown. `stop` ends the benchmark there, so the token ceiling stays enforceable; `continue` keeps going with the token ceiling covering reported usage only. |

The worst-case spend is therefore `maxModelCalls` requests at your providers' per-request price, and with `unknownUsage: "stop"` also at most `maxTokens` plus one response. Tokens are not converted to money; multiply by your providers' prices. When a ceiling is reached, the report records which one (`max_model_calls`, `max_tokens`, `max_wall_time`, `token_usage_unknown`, or `cancelled`), when, and the counts at that point.

## The report

`benchmark-report.md` and `benchmark-report.json` in the benchmark directory, built from `benchmark.json` (targets, pinned configuration, ceilings, stop reason, and each model call's role, model, latency and reported tokens, with no request or response bodies) and each target's `results.json`.

- **Identity:** the config path and sha256, each target's suite, sha256, scope and reviewer, the pinned models, endpoints and rate limits, repeat, ceilings, result and audit contract versions, the Git revision (and whether the worktree had uncommitted changes), Node version and platform.
- **Rates:** completion is `passed / n` with `n` and a 95% Wilson score interval, overall, per target and per journey/viewport. A run cut off by a ceiling or Ctrl-C is `interrupted`: listed, never counted as a failure or a pass. Runs that never started are listed as not started.
- **Model quality**, separate from **harness correctness**: each non-passing run is classed from its `resultVersion: 4` outcome (see [Outcome codes](../README.md#outcome-codes)):

  | Class | Outcomes | Section |
  | --- | --- | --- |
  | agent | `agent_loop`, `agent_no_path` | model quality |
  | model | `model_error` | model quality |
  | budget | `budget_exhausted` (attribution unknown: agent, model or application speed) | model quality |
  | assertion | `assertion_failure` | application outcome |
  | policy | `policy_block`, `stale_action` | harness correctness |
  | environment | source `environment`, `auth_failure` | harness correctness |
  | precondition | `precondition_failure` (readiness, setup) | harness correctness |
  | harness | `infrastructure_error`, `cancelled` | harness correctness |
  | unknown | everything else | harness correctness |

  *Model-attributable completion* is `passed / (passed + agent + model + budget)`; *completion (all)* counts every evaluated run. The model-quality section also reports loops (runs ended by a repeated action, plus `loop_check` replans and rejections from `events.jsonl`), planner and selector latency (n, median, p90, max; measured around each adapter call, so it includes client-side rate-limit waits), model calls per run, and tokens. The harness section checks this run's bookkeeping: every `results.json` validates against the result contract, per-run usage reconciles with the benchmark's call log, requests stayed within `maxModelCalls`, requests without an accepted response, and policy/environment/precondition/harness failures. Harness *behaviour* is verified by `npm test`, not by a live run.
- **Tokens** are `unknown`, never 0, when any request's usage was not reported; the report then gives the reported tokens as a lower bound and the number of requests without usage, per role.
- **Finding precision** needs human review. Without a labels file it is reported as `unknown`. A labels file marks findings as `confirmed` (reproduced as a real issue) or `rejected`:

  ```json
  {
    "labelsVersion": 1,
    "reviewer": "Reviewer Name",
    "labels": [
      { "target": "docs-install-desktop", "journey": "find-installation", "viewport": "desktop",
        "attempt": 2, "source": "finding", "index": 0, "verdict": "confirmed" }
    ]
  }
  ```

  `source: "finding"` indexes that run's `findings` (model `hypothesis` or `observed`), `source: "audit"` its `audits.findings`. Precision is `confirmed / labelled` per kind (hypothesis, observed, audit), with n, a Wilson interval and how many findings are unlabelled. A label that names no finding, or a duplicate, is refused.

## Thresholds

There are none. Release thresholds are target-specific and are defined only after a baseline of repeated live runs has been collected and reviewed for each target. Until then the report states `thresholds: not_defined`, and one successful run is reported as `1/1` with its (wide) interval, not as a pass rate.

## Evidence

The benchmark directory is a new directory under `runs/` (gitignored, never reused); its files are mode 0600. Target runs follow the normal [evidence protection](../README.md#evidence-protection); `benchmark.json` holds no keys, page text or model payloads, and error lines in it are redacted. Nothing is uploaded.

## Limits

- Tokens and latency are attributed per target (runs within a target run in sequence); per-run usage stays in each `results.json`, where missing usage counts as 0 as documented there.
- A provider that never reports usage (check whether yours does) makes every token total unknown; with `unknownUsage: "stop"` the benchmark then stops at its first such response.
- Targets and runs execute one at a time.
