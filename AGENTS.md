# UI/UX agent

Keep the test engine independent from application routes, product vocabulary, authentication providers and browser implementations. Application-specific journeys belong in `examples/` or an external suite.

The supported scope is websites and browser-based applications. Native desktop/mobile drivers are outside this version. Never describe mocked decisions or fixture-backed runs as live model or application verification.

Parse configuration and model output at their boundaries. Actions must come from observed controls or explicit suite configuration. Never execute model-generated JavaScript, selectors, shell commands or arbitrary URLs. Keep task completion based on independent checks, and keep model-generated UX concerns marked as hypotheses.

Run `npm run typecheck`, `npm run schema`, and `npm test` after behavior changes. Exercise the local `npm run demo` when driver or runner behavior changes. Browser tests require the matching Playwright Chromium runtime. Add meaningful regressions for changed selection, execution, scope and outcome behavior.

Do not commit credentials, storage state, model keys, screenshots, traces, videos or other run evidence. Do not write pull request comments. Do not merge pull requests.
