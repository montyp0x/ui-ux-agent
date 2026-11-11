// The horizontal overflow check, ported onto the audit framework: the
// document is wider than the viewport in an observed state. The width is
// measured by the driver on every observation (Observation.horizontalOverflow),
// so this core audit only reads recorded states at its checkpoints. Only the
// Playwright driver measures it; the macOS driver reports 0, so it is
// unsupported there rather than a silent pass.
import type { AuditDefinition } from './registry.js';
import type { AuditConfig } from './config.js';

export const horizontalOverflowAudit: AuditDefinition<
  Extract<AuditConfig, { id: 'layout.horizontal-overflow' }>
> = {
  id: 'layout.horizontal-overflow',
  source: 'builtin',
  title: 'Document wider than the viewport',
  drivers: ['playwright'],
  unsupported:
    'The macOS accessibility driver does not measure document overflow',
  evaluate({ observations }) {
    // One finding per run, for the first overflowing state, as before.
    const first = observations.find((state) => state.horizontalOverflow > 1);
    return {
      complete: observations.length > 0,
      detail: observations.length ? null : 'No UI state was observed',
      observations: observations.length,
      findings: first
        ? [
            {
              ruleId: 'document-wider-than-viewport',
              severity: 'serious',
              certainty: 'violation',
              description: `Document is ${first.horizontalOverflow}px wider than the viewport; review whether the horizontal overflow is intentional`,
              helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/reflow.html',
              targets: [{ description: 'document', selector: 'html', snippet: null }],
              nodeCount: 1,
              at: {
                step: first.step,
                url: first.url,
                screenshot: first.screenshot,
              },
            },
          ]
        : [],
    };
  },
};
