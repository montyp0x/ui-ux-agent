# UI/UX tester improvement plan

## Goal and scope

Evolve the existing bounded journey runner into an evidence-backed web UI/UX regression tester. A useful release must explain **what failed, where, compared with which baseline, and how to reproduce it**, without confusing model behavior with product defects.

Prioritize web depth. Preserve macOS accessibility support and repair its regressions, but defer Windows, native mobile, and broad native expansion. A narrow browser viewport is not native mobile verification. Automated and synthetic-user checks supplement, not replace, human usability research or a full accessibility audit.

This document is an implementation proposal, not implementation or authorization to merge, make paid model calls, import personal browser sessions, or operate on production data. No implementation workers have been dispatched by creating this plan. Start each slice with an assigned agent owner and retain ownership through review, CI, delivery, or an explicit blocker.

## Architecture decision: TypeScript first; Rust only for a demonstrated need

Keep TypeScript/Node, Playwright, and Zod as the primary engine. Keep Swift for the macOS Accessibility/AppKit boundary.

Rust offers strong types, predictable resource use, and good standalone-binary tooling. It does not by itself improve UI assertions, UX judgment, or model reliability. Browser startup, page behavior, screenshots, and model calls are likely larger costs than runner CPU; profile before assuming otherwise.

A Rust rewrite now would add migration risk and bridge work around the existing Node/Playwright integration. A Rust launcher that still starts Node and browsers is not a genuinely single-binary distribution. Native macOS integration would still require platform-specific APIs and permissions.

Revisit Rust only for a bounded component if there is evidence of one of these needs:

- A deployment requirement that the current Node distribution cannot reasonably satisfy.
- A measured CPU/memory bottleneck in a specific module, after improving its algorithm.
- A reusable native helper whose requirements materially exceed the current Swift helper.

Before adopting it, benchmark that component against the current implementation, account for browser/runtime and FFI or IPC costs, preserve the existing typed driver contract, and demonstrate an end-to-end benefit worth a second toolchain. Do not maintain two journey engines.

## Starting point and known gaps

The inspected worktree has an existing planner → offered-action selector → independently checked outcome loop; scoped browser and macOS drivers; viewport observations; bounded retries and loop detection; scoped authentication; and local reports, screenshots, traces, and optional video. Browser errors and failed requests are recorded. Repeats include usage and duration summaries.

The previous check reported:

- TypeScript passed; the generated suite schema was stale.
- 122 tests passed and three macOS tests failed: journey scope, synthetic click, and synthetic Enter.
- A local limiter reproduction showed a queued request starting after about 100 ms despite a newly applied 1,000 ms cooldown.
- The deterministic browser demo passed; this is not live-model verification.
- Uncommitted synthetic native input conflicts with `AGENTS.md`; personal-browser session extraction conflicts with the documented authentication guarantee.

These are historical check results, not checks rerun for this document. Reproduce them against the implementation branch before changing behavior. The worktree already contains substantial uncommitted work: isolate intended changes and preserve unrelated edits.

## Operating principles

1. **Independent assertions decide completion.** A model opinion cannot turn a failed assertion into a pass.
2. **Separate facts from interpretation.** Measured defects, model hypotheses, and operational failures must remain distinguishable.
3. **Keep functional outcome and quality verdict separate.** Reaching a goal may coexist with an accessibility or visual regression. Gate the configured quality policy independently.
4. **Keep the engine application-independent.** Product routes, vocabulary, fixtures, credentials, and reference paths belong in suites or external configuration.
5. **Preserve bounded execution.** No model-generated JavaScript, selectors, shell commands, or arbitrary navigation. Treat page/model content as untrusted input; it cannot expand permissions.
6. **Default to safe test environments.** Explicitly authorize writes, block destructive actions, isolate test data, and prove cleanup. Request restrictions are not a complete security sandbox.
7. **Reuse the existing test discovery.** Tests belong in `test/*.test.ts` and its existing fixtures, run through `npm test`. Do not add another runner, per-file workflow registration, or a dedicated CI job/step just to execute new tests.
8. **Evidence is sensitive.** No committed credentials, sessions, or run evidence; no automatic artifact upload. Redaction must happen before model submission or explicit sharing, not only in the HTML report.

## Delivery sequence

Each numbered slice should be independently reviewable and have its own regression tests. Later phases depend on the foundation; they need not ship as one branch.

### Phase 0 — Trustworthy foundation

**0A. Reconcile supported behavior and restore validation**

- Reproduce the existing failures and establish a clean, documented baseline.
- Default to removing/disabling unsupported personal-browser extraction and synthetic native input, not weakening the standing rules. Use dedicated test profiles/scoped storage state and accessibility-offered native actions. A different policy requires an explicit user decision first.
- Repair the native journey/scope behavior through permitted APIs; replace unsupported-input tests with supported-action regressions and rejection coverage.
- Regenerate the suite schema after the supported contract is settled; align README and CLI help.
- Areas: `src/contracts.ts`, `src/schema.ts`, `src/cli.ts`, `src/auth.ts`, browser-session changes, native driver/helper, `test/auth.test.ts`, `test/macos.test.ts`.
- **Acceptance:** typecheck, schema parity, full suite, browser demo, native suite, and native demo pass on their applicable platforms. No extraction path or prohibited native input remains enabled by default or advertised as supported.

**0B. Correct model scheduling and cancellation**

- Make queued requests recheck the latest endpoint cooldown immediately before dispatch.
- Test overlapping cooldowns, shared endpoints, concurrency release, cancellation, deadline expiry, and retry exhaustion using local model responses and controlled timing.
- Preserve wait/retry diagnostics without logging credentials.
- Areas: `src/models.ts`, `src/config.ts`, `test/model-rate-limit.test.ts`, deadline tests.
- **Acceptance:** no request starts before the most recent applicable cooldown expires; expired/cancelled work never dispatches; concurrency slots are released on every exit path.

**0C. Classify outcomes without overclaiming**

- Preserve existing journey statuses, adding typed reason/source information to distinguish assertion failures, policy blocks, stale actions, agent loops, budget exhaustion, auth failures, and model/infrastructure errors.
- A loop or exhausted budget alone is not proof of a product defect. Unknown attribution stays unknown.
- Define a separate quality verdict: pass, fail, or not evaluated, with explicit skipped/unsupported checks. No executed checks must not look healthy.
- Areas: `src/contracts.ts`, `src/runner.ts`, `src/report.ts`, `src/summary.ts` and their tests.
- **Acceptance:** representative failures have reproducible reason codes and evidence; reports retain the functional outcome even when quality checks fail. Existing result consumers are updated or versioned deliberately.

**Foundation exit gate:** all known failures are fixed or explicitly blocked with an owner; deterministic validation is green; safety/documentation conflicts are resolved. Do not call live-model quality verified yet.

### Phase 1 — Objective UI checks

**1A. Shared audit checkpoints and finding contract**

- Introduce explicitly configured checkpoints, initially after readiness/setup and at declared journey states or completion. Do not run every expensive audit after every action.
- Define typed, versioned findings with rule/source, affected state/target, severity, evidence references, and reproduction context. Keep model hypotheses distinct and uncalibrated model confidence out of release gates.
- Preserve check coverage and reasons for unsupported/skipped checks; use the existing driver boundary rather than leaking Playwright into the core.
- Areas: `src/contracts.ts`, `src/runner.ts`, `src/drivers/types.ts`, `src/report.ts`.
- **Acceptance:** configured checkpoints execute predictably; unsupported native audits are explicit, not silently passed; audit exceptions are distinguishable from clean results.

**1B. Web accessibility audits**

- Integrate an established analyzer such as axe-core at checkpoints, mapping rule, impact, affected elements, and applicable guidance into findings.
- Add controlled fixtures for missing accessible names, form labeling, invalid semantics, and contrast where reliably supported. Surface incomplete/manual-review results separately.
- Add keyboard/focus tests separately in Phase 2; an analyzer scan alone does not prove keyboard usability or WCAG compliance.
- Areas: browser driver, audit module, contracts/report, new discovered tests and local fixtures.
- **Acceptance:** fixtures with known violations are detected; corrected fixtures are clean; incomplete checks are visible; the report never claims a complete accessibility certification.

**1C. Responsive layout checks**

- Run declared breakpoint matrices and test zoom/reflow settings through supported browser capabilities.
- Extend current overflow checks with scoped clipping, occluded required controls, and configured touch-target checks. Treat intentional carousels/overlap as configurable exceptions, not universal defects.
- Keep inference-heavy truncation and overlap concerns as review candidates until supported by a reliable rule or suite assertion.
- Areas: `src/viewport.ts`, browser/scroll code, layout audit module, viewport and scroll tests.
- **Acceptance:** seeded defects are found at the affected breakpoint, corrected layouts pass, and intentional-layout exceptions have narrow, visible scope.

### Phase 2 — States, privacy, and visual regression

**2A. State coverage and safe data lifecycle**

- Add reusable suite examples for validation errors, loading/empty/error/success states, dialogs, menus, tables, pagination, and multi-step flows.
- Add web keyboard-only journeys covering focus visibility, focus order, dialog focus trapping, Escape behavior, and focus restoration where explicitly expected.
- Use isolated fixture services and disposable test identities for authorized write flows. Cover setup/reset and cleanup after failure, timeout, and cancellation; report cleanup failure prominently.
- Defer uploads/downloads, frames, multi-tab flows, and drag-and-drop until target journeys require them. Each needs an explicit capability and security design rather than relaxing scope globally.
- **Acceptance:** each state has independent checks; keyboard tests do not fall back to pointer interaction; repeated write tests leave no persistent shared data or unreported cleanup failures.

**2B. Evidence handling before expansion/sharing**

- Define provider-visible versus local-only data, screenshot masks, text/URL redaction, trace/video restrictions, and retention/deletion controls. Never use secrets as visual-baseline content.
- Apply protections before capture/submission where needed; an HTML-only mask does not protect the underlying image, trace, video, or model payload. If a format cannot be reliably sanitized, disable its capture/sharing for that suite.
- Test with planted secrets in every enabled evidence path, including failures and logs. Explain that redaction is not a guarantee for arbitrary unknown sensitive content.
- **Acceptance:** fixture secrets are absent from all enabled outbound payloads and shareable artifacts; disabled formats are reported; existing runs are never overwritten or uploaded automatically.

**2C. Reviewed visual baselines**

- Add named checkpoints, deterministic screenshot capture, animation/font readiness, dynamic-region masks, and explicit baseline approval/update operations.
- Key compatibility by suite/checkpoint, viewport, browser version, OS/rendering environment, and relevant locale/theme settings. A missing/incompatible baseline is not a pass.
- Produce baseline/current/diff views with region-level and aggregate differences; calibrate thresholds using stable fixtures. Never auto-approve the current output.
- Keep golden images and diff evidence outside Git under the current no-evidence rule. Start with a user-supplied local baseline directory; shared storage requires an explicitly approved destination and privacy policy.
- **Acceptance:** repeated stable captures stay within calibrated tolerance; seeded meaningful changes fail; dynamic masks do not hide unmasked changes; mismatched baselines are surfaced clearly.

### Phase 3 — Actionable UX evidence and regression comparison

**3A. Evidence-backed task-friction summaries**

- Report backtracks, repeats, recovery actions, detours, and failed attempts with links to observed steps. Distinguish product actions from planner/recovery overhead.
- Compare against optional reviewed reference paths. Extra steps alone do not establish poor usability; alternate valid paths may exist.
- Add an explicit qualitative rubric for discoverability, feedback, clarity, and recovery. Model judgments stay hypotheses pending reproduction/review.
- **Acceptance:** metrics reconcile with the recorded event stream; deterministic fixtures cover alternate valid paths; no agent duration or synthetic success rate is labeled human usability performance.

**3B. Compatible-run comparison and gates**

- Record build/revision, suite/config identity, engine/schema version, browser/environment, and model configuration. Compare only compatible runs or show why comparison is invalid.
- Generate stable finding identities excluding volatile candidate IDs, timestamps, and raw secrets. Show new, persisting, resolved, and unassessed findings.
- Add machine-readable comparison and configurable severity/rule gates. Keep hypotheses non-gating by default; make exit-code/report behavior explicit and tested.
- Keep evidence local unless explicit sharing is configured. Integrate with the existing execution path rather than adding per-feature CI runners/jobs.
- **Acceptance:** a seeded regression fails the configured gate even when the journey completes; unchanged known findings are not called new; missing checks/baselines cannot masquerade as improvement.

**3C. Opt-in live-model benchmark**

- Use the existing CLI and repeat support on a small reviewed target set. Run only with approved credentials, targets, data, and explicit call/token/time ceilings.
- Track completion, agent/policy/environment failures, repeated behavior, model latency/tokens, and human-reviewed finding precision. Report sample sizes and uncertainty; capture actual missing usage as unknown rather than implying free calls.
- Pin configuration and compare multiple runs; one success is not a pass rate. Never put paid live-model calls in the normal deterministic suite.
- **Acceptance:** a reproducible benchmark report separates model quality from harness correctness and names the tested targets/configuration. Define target-specific release thresholds only after collecting a baseline.

### Phase 4 — Broader coverage, driven by real needs

- **Performance:** capture navigation/Web Vitals where supported and selected interaction timing, with controlled network/CPU conditions. Separate app timing from model and screenshot overhead. Compare compatible measurements, not a single universal score.
- **Cross-browser:** validate actual browser-specific behavior before advertising parity; use existing discovered tests and local browser runtimes. The current Chromium installation in CI is not evidence for Firefox/WebKit.
- **Environment matrices:** add locale/long text, theme, reduced motion, and other settings required by product suites, without exploding every run into every combination.
- **Design references:** optional suite-owned token/reference checks; mark unsupported comparisons and subjective assessments clearly.
- **Native depth:** extend permitted macOS accessibility coverage after web gates are stable. Windows/mobile remain separate proposals, not implied deliverables.
- **Acceptance:** each claimed capability has real execution coverage, documented limitations, and an evidence-producing example. No platform-parity claim based solely on mocks or configuration options.

## Release checkpoints

| Checkpoint | Required slices | Deliverable |
| --- | --- | --- |
| R0: Trustworthy runner | 0A–0C | Green supported execution, safe authentication/native behavior, honest outcome attribution |
| R1: Objective web audits | R0, 1A–1C | Accessibility and responsive findings at explicit states, separate quality verdict |
| R2: State and visual coverage | R1, 2A–2C | Keyboard/state journeys, privacy controls, reviewed visual comparisons |
| R3: Regression tester | R2, 3A–3C | Actionable compatible-run diffs, configurable gates, live-model evidence with limits |
| Later: Coverage expansion | Selected Phase 4 slices | Verified additional environments rather than a broad unsupported promise |

## Definition of done for every implementation slice

- Assigned agent owner carries it through implementation, review, CI, and delivery, or reports the explicit blocker. Split large slices further rather than carrying unrelated fixes.
- New configuration and external/model data are validated at boundaries; schema/docs/examples match supported behavior.
- Meaningful positive, negative, failure, and cancellation regressions run via existing test discovery. Check that failures identify the defect, not only that a fixture can pass.
- After behavior changes: run typecheck, schema generation/parity, and the normal suite. Run the browser demo for driver/runner changes. For native changes, run the native demo; run `test:native` before pushing native/helper/runner changes.
- Reports and machine-readable results expose coverage, skips, and errors without leaking credentials or mislabeling hypotheses as observed defects.
- No unrelated existing work is discarded. No credentials, session files, screenshots, traces, videos, or other run evidence are committed.
- If delivery is requested: use a small draft PR, never write PR comments or merge, and retain an agent owner for unfinished follow-up. Deployment validation applies where the repo has a relevant deployed service; local-only tooling needs no invented staging deployment.

## Recommended next action

Start with **0A**, scoped to supported authentication/native behavior, schema parity, and restoring native validation. Then ship **0B** independently and **0C** before building the audit layer. Do not begin with a Rust rewrite, a dashboard, unrestricted exploration, or additional platforms.
