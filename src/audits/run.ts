// Runs the configured audits at a journey's checkpoints and records every
// run, including unsupported and failed ones, in the audit result. Nothing
// here throws into the journey: an audit exception becomes an `error` run.
import type { Journey, Observation, Suite } from '../contracts.js';
import type { EventLogger, UISession } from '../drivers/types.js';
import type { AuditConfig, AuditId } from './config.js';
import {
  AUDIT_CONTRACT_VERSION,
  auditOutputSchema,
  isGating,
  type AuditCheckpoint,
  type AuditStatus,
  type AuditsResult,
  type DriverKind,
  type ParsedAuditOutput,
} from './contract.js';
import { auditDefinition, type AuditDefinition } from './registry.js';

export type JourneyAuditOptions = {
  suite: Suite;
  journey: Journey;
  viewport: { name: string; width: number; height: number };
  directory: string;
  session: UISession;
  log: EventLogger;
  // The audit registry; tests substitute their own definitions.
  definitions?: (id: AuditId) => AuditDefinition;
};

function firstLine(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.split('\n')[0]!.slice(0, 200);
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Audit timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class JourneyAudits {
  readonly driver: DriverKind;
  private readonly result: AuditsResult;
  private readonly checks: AuditConfig[];
  // States recorded since each audit's previous run.
  private readonly pending = new Map<AuditId, Observation[]>();
  private last: Observation | null = null;
  private observed = 0;
  private readyDone = false;
  private completionDone = false;
  private readonly statesDone = new Set<string>();

  constructor(private readonly options: JourneyAuditOptions) {
    const { suite, session } = options;
    this.driver =
      session.driver ?? (suite.platform === 'macos' ? 'macos' : 'playwright');
    this.checks = suite.audits.checks;
    this.result = {
      contractVersion: AUDIT_CONTRACT_VERSION,
      failOn: suite.audits.failOn,
      configured: this.checks.map((check) => check.id),
      runs: [],
      findings: [],
      notReached: [],
    };
    for (const check of this.checks) this.pending.set(check.id, []);
  }

  // Every observed state, so core audits can read the states between their
  // checkpoints. Recording runs no audit.
  record(observation: Observation): void {
    this.observed++;
    this.last = observation;
    for (const states of this.pending.values()) states.push(observation);
  }

  // Called after each recorded journey observation: fires the ready
  // checkpoint once, then each declared state the first time it holds.
  async afterObservation(observation: Observation): Promise<void> {
    if (!this.readyDone) {
      this.readyDone = true;
      await this.checkpoint('ready', null, observation, observation.step);
    }
    const auditsAtStates = this.at('states');
    if (!auditsAtStates.length) return;
    for (const state of this.options.journey.states ?? []) {
      if (this.statesDone.has(state.name)) continue;
      let holds: boolean;
      try {
        holds = await this.options.session.check(state.when);
      } catch (caught) {
        // The state cannot be decided; record it once instead of retrying.
        this.statesDone.add(state.name);
        const checkpoint = this.checkpointOf(
          'state',
          state.name,
          observation,
          observation.step,
        );
        for (const config of auditsAtStates)
          await this.push(
            config,
            checkpoint,
            'error',
            `State check failed: ${firstLine(caught)}`,
            null,
            Date.now(),
          );
        continue;
      }
      if (!holds) continue;
      this.statesDone.add(state.name);
      await this.checkpoint('state', state.name, observation, observation.step);
    }
  }

  // The final state, once, after the journey ended. Skipped when no state was
  // ever observed (the journey stopped before ready and setup completed).
  async completion(step: number, screenshot: string | null): Promise<void> {
    if (this.completionDone || !this.observed) return;
    this.completionDone = true;
    let url: string | null = this.last?.url ?? null;
    try {
      url = this.options.session.location();
    } catch {
      // Keep the last observed URL.
    }
    await this.checkpoint('completion', null, this.last, step, {
      url,
      screenshot,
    });
  }

  finish(): AuditsResult {
    const notReached: AuditsResult['notReached'] = [];
    for (const check of this.checks)
      for (const at of check.at) {
        if (at === 'ready' && !this.readyDone)
          notReached.push({ auditId: check.id, at: 'ready' });
        if (at === 'completion' && !this.completionDone)
          notReached.push({ auditId: check.id, at: 'completion' });
        if (at === 'states')
          for (const state of this.options.journey.states ?? [])
            if (!this.statesDone.has(state.name))
              notReached.push({ auditId: check.id, at: `state:${state.name}` });
      }
    return { ...this.result, notReached };
  }

  private at(at: 'ready' | 'states' | 'completion'): AuditConfig[] {
    return this.checks.filter((check) => (check.at as string[]).includes(at));
  }

  private checkpointOf(
    kind: AuditCheckpoint['kind'],
    name: string | null,
    state: Observation | null,
    step: number,
    override: { url?: string | null; screenshot?: string | null } = {},
  ): AuditCheckpoint {
    return {
      id: kind === 'state' ? `state:${name}` : kind,
      kind,
      name,
      step,
      url: override.url !== undefined ? override.url : (state?.url ?? null),
      screenshot:
        override.screenshot !== undefined
          ? override.screenshot
          : (state?.screenshot ?? null),
    };
  }

  private async checkpoint(
    kind: AuditCheckpoint['kind'],
    name: string | null,
    state: Observation | null,
    step: number,
    override: { url?: string | null; screenshot?: string | null } = {},
  ): Promise<void> {
    const configs = this.at(kind === 'state' ? 'states' : kind);
    if (!configs.length) return;
    const checkpoint = this.checkpointOf(kind, name, state, step, override);
    for (const config of configs) await this.run(config, checkpoint, state);
  }

  private async run(
    config: AuditConfig,
    checkpoint: AuditCheckpoint,
    current: Observation | null,
  ): Promise<void> {
    const definition = (this.options.definitions ?? auditDefinition)(config.id);
    const started = Date.now();
    const recorded = this.pending.get(config.id) ?? [];
    this.pending.set(config.id, []);
    const observations = recorded.length ? recorded : current ? [current] : [];
    if (!definition.drivers.includes(this.driver))
      return this.push(
        config,
        checkpoint,
        'unsupported',
        definition.unsupported,
        null,
        started,
      );
    let output: ParsedAuditOutput;
    try {
      const { session, directory, suite } = this.options;
      const timeoutMs = suite.audits.timeoutMs;
      let raw: unknown;
      if (definition.evaluate)
        raw = definition.evaluate({ checkpoint, config, observations });
      else if (!session.runAudit)
        throw new Error(
          `The ${this.driver} session does not implement runAudit for ${config.id}`,
        );
      else
        raw = await within(
          session.runAudit({ config, checkpoint, directory, timeoutMs }),
          timeoutMs,
        );
      const parsed = auditOutputSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          `Invalid audit output: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`,
        );
      output = parsed.data;
    } catch (caught) {
      return this.push(
        config,
        checkpoint,
        'error',
        firstLine(caught),
        null,
        started,
      );
    }
    const status: AuditStatus = !output.complete
      ? 'incomplete'
      : output.findings.some((finding) => finding.certainty === 'violation')
        ? 'findings'
        : 'clean';
    return this.push(
      config,
      checkpoint,
      status,
      output.detail,
      output,
      started,
    );
  }

  private async push(
    config: AuditConfig,
    checkpoint: AuditCheckpoint,
    status: AuditStatus,
    detail: string | null,
    output: ParsedAuditOutput | null,
    started: number,
  ): Promise<void> {
    const { journey, viewport, log } = this.options;
    const definition = (this.options.definitions ?? auditDefinition)(config.id);
    const run = this.result.runs.length;
    const findings: number[] = [];
    for (const finding of output?.findings ?? []) {
      findings.push(this.result.findings.length);
      this.result.findings.push({
        auditId: config.id,
        source: definition.source,
        analyzer: output?.analyzer ?? null,
        ruleId: finding.ruleId,
        severity: finding.severity,
        certainty: finding.certainty,
        description: finding.description,
        helpUrl: finding.helpUrl,
        tags: finding.tags,
        nodeCount: Math.max(finding.nodeCount ?? 0, finding.targets.length),
        targets: finding.targets,
        run,
        gating: isGating(finding, this.result.failOn),
        evidence: {
          screenshot: finding.at
            ? finding.at.screenshot
            : checkpoint.screenshot,
          files: finding.files,
        },
        reproduction: {
          journey: journey.id,
          viewport: { ...viewport },
          checkpoint: checkpoint.id,
          step: finding.at?.step ?? checkpoint.step,
          url: finding.at?.url ?? checkpoint.url,
        },
      });
    }
    const durationMs = Date.now() - started;
    this.result.runs.push({
      auditId: config.id,
      source: definition.source,
      checkpoint,
      analyzer: output?.analyzer ?? null,
      status,
      detail,
      durationMs,
      observations:
        status === 'unsupported' || status === 'error'
          ? 0
          : (output?.observations ?? 0),
      limitations: output?.limitations ?? [],
      findings,
    });
    await log('audit_run', {
      journey: journey.id,
      viewport: viewport.name,
      auditId: config.id,
      checkpoint: checkpoint.id,
      step: checkpoint.step,
      driver: this.driver,
      status,
      detail,
      findings: findings.length,
      gating: findings.filter((index) => this.result.findings[index]!.gating)
        .length,
      durationMs,
    });
  }
}
