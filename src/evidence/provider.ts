// The provider-visible view of a journey: a Models wrapper that redacts every
// input before the planner or selector adapter builds a request from it, and
// withholds screenshots when the evidence policy says so. Action ids, kinds
// and the order of actions are unchanged, so choices map back to the runner's
// own actions.
import type { Action, Journey, Observation } from '../contracts.js';
import type { Models } from '../models.js';
import { formatEnabled } from './policy.js';
import type { EvidenceProtection } from './protection.js';
import type { Redactor } from './redact.js';

// A link destination with its path, query and fragment redacted; the origin is
// kept so the adapter can still parse it.
function redactHref(href: string, redactor: Redactor): string {
  try {
    const url = new URL(href);
    const rest = redactor.text(url.pathname + url.search + url.hash);
    return new URL(rest.startsWith('/') ? rest : `/${rest}`, url.origin).href;
  } catch {
    return 'about:blank';
  }
}

export function providerModels(
  models: Models,
  protection: EvidenceProtection,
): Models {
  const { redactor } = protection;
  const screenshots = formatEnabled(protection.formats, 'provider_screenshots');
  // Adapters read the goal and persona; the rest of the journey (configured
  // values, targets) is redacted too, for adapters that read more.
  const journey = (value: Journey): Journey => redactor.deep(value);
  const observation = (value: Observation): Observation => ({
    ...redactor.deep(value),
    // A local path the adapter reads (the image is masked before capture);
    // empty when the provider must not receive screenshots.
    screenshot: screenshots ? value.screenshot : '',
  });
  const actions = (list: Action[]): Action[] =>
    list.map(
      (action) =>
        ({
          ...redactor.deep(action),
          id: action.id,
          kind: action.kind,
          ...(action.kind === 'link'
            ? { href: redactHref(action.href, redactor) }
            : {}),
        }) as Action,
    );
  return {
    plan(value, observed, history, timeoutMs, offered, context, signal) {
      return models.plan(
        journey(value),
        observation(observed),
        redactor.deep(history),
        timeoutMs,
        offered && actions(offered),
        context && redactor.deep(context),
        signal,
      );
    },
    choose(value, observed, plan, offered, history, timeoutMs, signal) {
      return models.choose(
        journey(value),
        observation(observed),
        redactor.deep(plan),
        actions(offered),
        redactor.deep(history),
        timeoutMs,
        signal,
      );
    },
  };
}
