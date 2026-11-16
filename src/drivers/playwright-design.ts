// The `design.tokens` driver audit through Playwright: measures computed
// styles in the page (src/audits/design-detect.ts), compares them with the
// suite's token set and writes the full measurement as run evidence.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { AuditOutput } from '../audits/contract.js';
import {
  detectDesign,
  type DesignDetectInput,
} from '../audits/design-detect.js';
import {
  activeRules,
  designAuditOutput,
  designMeasurementSchema,
  evaluateDesign,
  selectTokens,
  type DesignMeasurement,
} from '../audits/design-tokens.js';
import { settleLayout } from './playwright-layout.js';
import type { DriverAuditRequest } from './types.js';

export async function designTokensPlaywrightAudit(
  page: Page,
  request: DriverAuditRequest,
): Promise<AuditOutput> {
  const { config, checkpoint, directory } = request;
  if (config.id !== 'design.tokens')
    throw new Error(`Not a design.tokens audit: ${config.id}`);
  // The run's environment's own set, when the entry lists one.
  const { tokens, ...selection } = selectTokens(config, request.environment);
  const rules = activeRules(config, tokens);
  await settleLayout(page);
  const input: DesignDetectInput = {
    include: config.include,
    exclude: config.exclude,
    rules,
    exceptions: config.exceptions.map((exception) => exception.selector),
    maxElements: config.maxElements,
  };
  const measurement = designMeasurementSchema.parse(
    await page.evaluate(
      detectDesign as unknown as (arg: unknown) => DesignMeasurement,
      input as unknown,
    ),
  );
  const evaluation = evaluateDesign(measurement, config, tokens, rules);
  // Every off-token and exempted value with all its elements, for
  // reproduction. Selectors and computed values only, no page text.
  const file = join(
    directory,
    `design-tokens-${checkpoint.id.replace(/[^a-z0-9-]+/gi, '-')}-step${checkpoint.step}.json`,
  );
  const element = (index: number) => measurement.nodes[index]!;
  await writeFile(
    file,
    JSON.stringify(
      {
        checkpoint: checkpoint.id,
        url: measurement.url,
        tokens: {
          name: tokens.name ?? 'inline',
          environment: selection.environment,
          ownSet: selection.own,
          rootFontSizePx: measurement.rootFontSizePx,
          rules,
          tolerance: config.tolerance,
        },
        elements: measurement.elements,
        truncated: measurement.truncated,
        compared: evaluation.compared,
        skipped: measurement.skipped,
        offToken: evaluation.offToken.map((group) => ({
          ...group,
          nodes: group.nodes.map(element),
        })),
        exempted: evaluation.exempted.map((group) => ({
          ...group,
          nodes: group.nodes.map(element),
        })),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  return designAuditOutput(evaluation, config, { files: [file], selection });
}
