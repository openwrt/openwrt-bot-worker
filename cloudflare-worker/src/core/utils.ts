import type { SubrequestBudget } from '../types/env.ts';

// Truncates text to a specified byte limit while ensuring valid UTF-8 boundaries
export function safeTruncate(text: string, limit: number = 65000): string {
  if (!text) return "";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return text;

  const suffix = "\n\n... [Output truncated due to GitHub character limit] ...";
  const suffixBytes = encoder.encode(suffix);
  const maxContentBytes = limit - suffixBytes.length;

  const truncatedBytes = bytes.slice(0, maxContentBytes);
  let truncatedText = decoder.decode(truncatedBytes);
  if (truncatedText.endsWith("\uFFFD")) {
    truncatedText = truncatedText.slice(0, -1);
  }
  return truncatedText + suffix;
}

// Parses an env var as an integer, falling back to `fallback` only when the
// value is unset/unparseable/out of bounds — unlike `parseInt(x, 10) || fallback`, this
// correctly honors an explicitly configured 0 instead of treating it the
// same as "not set", unless a minimum value `min` is specified.
export function parseEnvInt(value: unknown, fallback: number, min?: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = parseInt(String(value), 10);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return fallback;
  if (min !== undefined && parsed < min) return fallback;
  return parsed;
}

// Bots never act as maintainers here, whatever access they hold on the
// repository: this app's own formality reports quote the override commands
// back at the PR, so honoring a bot comment would let it re-trigger itself.
export function isBotUser(user: { login?: string; type?: string } | null | undefined): boolean {
  const login = user?.login;
  return user?.type === 'Bot' || (!!login && login.toLowerCase().endsWith('[bot]'));
}

// Takes one attempt for an optional lookup out of the budget, or refuses when
// nothing but the reserve kept for the terminal writes is left. The check and
// the charge are deliberately one step: a caller that plans several lookups in
// one synchronous pass and fires them together would otherwise hand every one
// of them the same answer, and spend as many attempts as it planned.
export function reserveOptionalAttempt(subrequestBudget: SubrequestBudget): boolean {
  if (subrequestBudget.limit - subrequestBudget.reserve - subrequestBudget.used <= 0) {
    return false;
  }
  subrequestBudget.used++;
  return true;
}

// Counts an outgoing attempt for a lookup the run can do without, and refuses
// it once only the reserve is left. Every attempt is treated alike: charging
// the first one whatever the headroom let an optional lookup spend out of the
// room the terminal writes are kept for, and two lookups starting together
// could take two attempts out of a reserve that had none to give. A declined
// attempt comes back as HTTP 599 with the sentinel body githubApiCall
// documents, which wasAttemptDeclined tells apart from a request GitHub
// refused, so a caller reports an input it never read rather than a verdict.
export function optionalAttemptCounter(subrequestBudget: SubrequestBudget): (attempt: number) => boolean {
  return (_attempt: number): boolean => reserveOptionalAttempt(subrequestBudget);
}
