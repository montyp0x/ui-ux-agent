// Declared state expectations: each journey state's own `expect` checks,
// evaluated once at the state's checkpoint, the first observed state where
// its `when` holds. They are independent of the journey's success checks, so
// a loading, empty, error or success state is verified on its own terms (an
// error state offers a retry; an empty state explains itself) whatever the
// journey's outcome. A session audit: it uses only UISession.check, so every
// driver that evaluates checks supports it.
import type { Check } from '../contracts.js';
import type { Target } from '../target.js';
import type { AuditConfig } from './config.js';
import type { AuditOutput, AuditOutputFinding } from './contract.js';
import type { AuditDefinition } from './registry.js';

export function describeTarget(target: Target): string {
  switch (target.by) {
    case 'role':
      return `${target.role} "${target.name}"`;
    case 'testId':
      return `test id "${target.value}"`;
    case 'label':
      return `label "${target.value}"`;
    case 'placeholder':
      return `placeholder "${target.value}"`;
    case 'css':
      return `CSS ${target.value}`;
  }
}

export function describeCheck(check: Check): string {
  switch (check.kind) {
    case 'path':
      return `path matches /${check.pattern}/`;
    case 'text':
      return `${describeTarget(check.target)} text matches /${check.pattern}/`;
    default:
      return `${check.kind} ${describeTarget(check.target)}`;
  }
}

type Config = Extract<AuditConfig, { id: 'journey.state-checks' }>;

export const stateChecksAudit: AuditDefinition<Config> = {
  id: 'journey.state-checks',
  source: 'builtin',
  title: 'Declared state expectations',
  drivers: ['playwright', 'macos'],
  unsupported: 'The driver does not evaluate checks',
  async inspect({ checkpoint, config, journey, check }): Promise<AuditOutput> {
    if (checkpoint.kind !== 'state' || !checkpoint.name)
      throw new Error('journey.state-checks runs at declared states only');
    const state = (journey.states ?? []).find(
      (entry) => entry.name === checkpoint.name,
    );
    if (!state) throw new Error(`Unknown journey state ${checkpoint.name}`);
    const expected = state.expect ?? [];
    if (!expected.length)
      return {
        complete: true,
        detail: null,
        limitations: [`State ${state.name} declares no expect checks`],
        findings: [],
      };
    const findings: AuditOutputFinding[] = [];
    const undecided: string[] = [];
    for (const [index, condition] of expected.entries()) {
      let holds: boolean;
      try {
        holds = await check(condition);
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        undecided.push(
          `expect[${index}] (${describeCheck(condition)}): ${message.split('\n')[0]!.slice(0, 200)}`,
        );
        continue;
      }
      if (holds) continue;
      findings.push({
        ruleId: 'state-expectation',
        severity: config.severity,
        certainty: 'violation',
        description: `In state ${state.name}, expected check ${index + 1} did not hold: ${describeCheck(condition)}`,
        helpUrl: null,
        tags: [`state:${state.name}`, `check:${condition.kind}`],
        nodeCount: 1,
        targets: [
          {
            description: describeCheck(condition),
            selector:
              'target' in condition && condition.target.by === 'css'
                ? condition.target.value
                : null,
            reason: `expect[${index}] of state ${state.name}`,
          },
        ],
      });
    }
    return {
      complete: !undecided.length,
      detail: undecided.length
        ? `Could not evaluate ${undecided.join('; ')}`
        : null,
      findings,
    };
  },
};
