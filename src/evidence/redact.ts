// Text redaction for every evidence path: model payloads, logs, results,
// reports and text files in a run directory. One Redactor per run, built from
// the suite's evidence policy and the environment.
//
// Redaction removes what it is told about (suite patterns, the values of
// credential environment variables) and a fixed set of well-known credential
// shapes. It is not a guarantee for arbitrary unknown sensitive content.

export const REDACTED = '[REDACTED]';
// A replacement token; split() keeps it as an odd-index part.
const TOKEN = /(\[REDACTED(?::[^\]\s]*)?\])/;

// A compiled text pattern. `source` and `flags` are kept so drivers can
// rebuild it inside a page (screenshot masks) without sharing RegExp objects.
export type TextPattern = { label: string; source: string; flags: string };

// Well-known credential shapes, always applied. Each replaces only the secret
// part (a group named `secret`), so the surrounding text stays readable.
export const BUILT_IN_PATTERNS: readonly TextPattern[] = [
  {
    label: 'private-key',
    source:
      '(?<secret>-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----)',
    flags: 'g',
  },
  {
    label: 'bearer',
    source: '\\b(?:Bearer|Basic)\\s+(?<secret>[A-Za-z0-9._~+/=-]{8,})',
    flags: 'gi',
  },
  {
    label: 'jwt',
    source:
      '(?<secret>\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,})',
    flags: 'g',
  },
  {
    label: 'api-key',
    source: '(?<secret>\\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_]{16,})',
    flags: 'g',
  },
  {
    label: 'github-token',
    source:
      '(?<secret>\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}))',
    flags: 'g',
  },
  {
    label: 'aws-access-key',
    source: '(?<secret>\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b)',
    flags: 'g',
  },
  {
    label: 'slack-token',
    source: '(?<secret>\\bxox[abprs]-[A-Za-z0-9-]{10,})',
    flags: 'g',
  },
  {
    label: 'google-api-key',
    source: '(?<secret>\\bAIza[0-9A-Za-z_-]{35})',
    flags: 'g',
  },
  // user:password@ in any URL.
  {
    label: 'url-credentials',
    source: '\\b[a-z][a-z0-9+.-]*://(?<secret>[^/\\s:@]+:[^/\\s@]+)@',
    flags: 'gi',
  },
  // Values of credential-like URL query or fragment parameters.
  {
    label: 'url-parameter',
    source:
      '[?&#](?:access_token|id_token|refresh_token|token|auth|authorization|api_?key|key|secret|password|passwd|pwd|session|sessionid|sid|code|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token)=(?!\\[REDACTED)(?<secret>[^&#\\s"\'<>]+)',
    flags: 'gi',
  },
  // password=..., "api_key": "...", token: ... in free text.
  {
    label: 'credential-assignment',
    source:
      '\\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token)["\']?\\s*[:=]\\s*["\']?(?!\\[REDACTED)(?<secret>[^\\s"\',;&]{4,})',
    flags: 'gi',
  },
];

// Environment variables whose values are credentials by their name. Their
// values are redacted wherever they appear, whether or not a suite lists them.
const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|COOKIE|SESSION|AUTH|PAT)(?:_|$)/i;
// Header maps whose values are credentials (gateway keys, cookies).
const CREDENTIAL_HEADER_ENV = ['PLANNER_API_HEADERS', 'SELECTOR_API_HEADERS'];
// Shorter values are too likely to occur in ordinary text to redact safely.
const MIN_DISCOVERED_LENGTH = 8;
export const MIN_DECLARED_LENGTH = 4;

// Object keys whose string values are always credentials, whatever they hold.
const CREDENTIAL_KEY =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token)$/i;

export type RedactorOptions = {
  // Suite-declared patterns (regex sources), applied after literal values.
  patterns?: { label?: string; pattern: string; ignoreCase?: boolean }[];
  // Environment variable names whose values the suite marks as secret.
  envNames?: string[];
  env?: Record<string, string | undefined>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Credential values from the environment: every variable listed by the suite
// (MIN_DECLARED_LENGTH or longer) and every variable whose name marks it as a
// credential (MIN_DISCOVERED_LENGTH or longer), plus model gateway header
// values. Returned as { name, value } with the longest values first, so a
// value containing another is replaced whole.
export function credentialEnvValues(
  env: Record<string, string | undefined>,
  declared: string[] = [],
): { name: string; value: string }[] {
  const found = new Map<string, string>();
  const add = (name: string, value: string | undefined, min: number) => {
    if (value && value.length >= min && !found.has(value))
      found.set(value, name);
  };
  for (const name of declared) add(name, env[name], MIN_DECLARED_LENGTH);
  for (const [name, value] of Object.entries(env))
    if (CREDENTIAL_ENV_NAME.test(name)) add(name, value, MIN_DISCOVERED_LENGTH);
  for (const name of CREDENTIAL_HEADER_ENV) {
    const raw = env[name];
    if (!raw) continue;
    try {
      const headers: unknown = JSON.parse(raw);
      if (headers && typeof headers === 'object')
        for (const [header, value] of Object.entries(headers))
          if (typeof value === 'string')
            add(`${name}.${header}`, value, MIN_DECLARED_LENGTH);
    } catch {
      // config.ts reports malformed header JSON; nothing to collect here.
    }
  }
  return [...found]
    .map(([value, name]) => ({ name, value }))
    .sort((a, b) => b.value.length - a.value.length);
}

export class Redactor {
  // Literal secret values (environment), as patterns, longest first.
  readonly literals: readonly TextPattern[];
  // Suite-declared patterns.
  readonly declared: readonly TextPattern[];
  readonly builtIn: readonly TextPattern[] = BUILT_IN_PATTERNS;
  private readonly compiled: { label: string; regex: RegExp }[];
  constructor(options: RedactorOptions = {}) {
    const env = options.env ?? {};
    this.literals = credentialEnvValues(env, options.envNames ?? []).map(
      ({ name, value }) => ({
        label: `env:${name}`,
        source: escapeRegExp(value),
        flags: 'g',
      }),
    );
    this.declared = (options.patterns ?? []).map((entry, index) => ({
      label: entry.label ?? `suite-${index + 1}`,
      source: entry.pattern,
      flags: entry.ignoreCase ? 'gi' : 'g',
    }));
    this.compiled = [...this.literals, ...this.declared, ...this.builtIn].map(
      (pattern) => ({
        label: pattern.label,
        regex: new RegExp(pattern.source, pattern.flags),
      }),
    );
  }
  // Every pattern a screenshot mask should look for in page text and values.
  get patterns(): readonly TextPattern[] {
    return [...this.literals, ...this.declared, ...this.builtIn];
  }
  // Whether the suite declared anything sensitive (its own patterns or
  // environment names). Built-in patterns and discovered environment
  // credentials apply to every suite and do not count.
  get declaredSensitive(): boolean {
    return this.declared.length > 0;
  }
  text(value: string): string {
    let out = value;
    for (const { label, regex } of this.compiled)
      // Existing tokens are left alone, so redacting twice changes nothing.
      out = out
        .split(TOKEN)
        .map((part, index) =>
          index % 2 ? part : this.replace(part, label, regex),
        )
        .join('');
    return out;
  }
  private replace(text: string, label: string, regex: RegExp): string {
    regex.lastIndex = 0;
    return text.replace(regex, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.at(-1);
      const secret =
        groups && typeof groups === 'object'
          ? (groups as Record<string, string | undefined>).secret
          : undefined;
      const token = `[REDACTED:${label}]`;
      if (secret === undefined || secret === match) return token;
      // Replace only the secret part of the match.
      const offset = match.lastIndexOf(secret);
      return (
        match.slice(0, offset) + token + match.slice(offset + secret.length)
      );
    });
  }
  // Whether `value` holds anything this redactor would replace.
  matches(value: string): boolean {
    return this.text(value) !== value;
  }
  // A redacted deep copy: every string value is redacted, string values under
  // credential-named keys are replaced whole, and data: URLs (screenshots sent
  // to the planner, already masked before capture) are kept as they are.
  deep<T>(value: T): T {
    return this.walk(value, null) as T;
  }
  private walk(value: unknown, key: string | null): unknown {
    if (typeof value === 'string') {
      if (key !== null && CREDENTIAL_KEY.test(key) && value) return REDACTED;
      if (value.startsWith('data:image/')) return value;
      return this.text(value);
    }
    if (Array.isArray(value))
      return value.map((entry) => this.walk(entry, null));
    if (value && typeof value === 'object') {
      if (value instanceof Date) return value;
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          this.walk(entry, name),
        ]),
      );
    }
    return value;
  }
}
