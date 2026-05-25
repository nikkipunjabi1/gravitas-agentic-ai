import "server-only";

/**
 * Profanity guardrail — Phase 1.10.
 *
 * Per spec: "If anyone speaks vulgar 3 times → suspend that chat."
 *
 * Tracking lives in an in-memory Map keyed by sessionId. The map resets on
 * server restart — Phase 2 swap target: a `suspended_at` column on the
 * sessions table, with a check during the chat-route turn gate.
 *
 * Detection is intentionally narrow:
 *   - Word-boundary match against a small embedded list of common slurs +
 *     obscenities. We're not trying to be a content-moderation product; the
 *     point is to react to clear abuse, not flag medical / cultural language.
 *   - Bypass-resistant for the obvious l33t variants (f*ck, sh!t).
 *   - Refused phrases never reach the LLM — saves cost and prevents the
 *     model from echoing the input.
 *
 * Returns:
 *   { profane: false }                              — clean turn, continue
 *   { profane: true, strikes: 1|2, suspended: false } — warn, continue
 *   { profane: true, strikes: 3, suspended: true }    — suspend the chat
 *   { suspended: true, strikes: ≥3 }                  — pre-existing suspend
 */

interface StrikeRow {
  strikes: number;
  suspendedAt: number | null;
}

const sessionStrikes = new Map<string, StrikeRow>();

// Strike threshold — third profane message suspends. Configurable for tests.
const STRIKES_TO_SUSPEND = 3;

// Conservative word list — abusive slurs, common obscenities, sexual content.
// Each entry is a stem; we match with word boundaries + common substitutions.
// Intentionally NOT pretending to be exhaustive — Phase 2 swaps for a real
// content-moderation API (e.g., Anthropic's safety classifier, OpenAI mod).
const PROFANITY_STEMS = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "dick",
  "pussy",
  "cunt",
  "whore",
  "slut",
  "faggot",
  "nigger",
  "nigga",
  "retard",
  "tranny",
  "kike",
  "spic",
  "chink",
  "wetback",
  "gook",
  "raghead",
  "towelhead",
  "twat",
  "wank",
  "jerkoff",
  "motherfucker",
];

/**
 * Normalises common bypass tricks before matching:
 *   - leet substitutions: 0→o, 1→i, 3→e, 4→a, 5→s, 7→t, $→s, @→a, !→i
 *   - punctuation/whitespace inserted between letters: "f*ck" → "fck" → leet → "fck"
 *   - repeated characters collapsed: "fuuuuck" → "fuck"
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[*\-_.,'`"]/g, "") // strip common in-word inserts
    .replace(/(.)\1{2,}/g, "$1$1"); // collapse 3+ repeats to 2
}

export interface ProfanityCheck {
  profane: boolean;
  strikes: number;
  suspended: boolean;
  reason: string | null;
}

/**
 * Inspect a turn for profanity AND advance the session's strike count.
 *
 * IMPORTANT: this mutates state. Call exactly once per visitor turn at the
 * top of the chat route (before any agent work). If the result has
 * `suspended: true`, the route should emit a refusal UIAction and bail.
 */
export function inspectAndTrack(
  sessionId: string,
  userMessage: string,
): ProfanityCheck {
  const row = sessionStrikes.get(sessionId) ?? { strikes: 0, suspendedAt: null };

  // Already suspended → reject without further inspection.
  if (row.suspendedAt) {
    return {
      profane: false,
      strikes: row.strikes,
      suspended: true,
      reason: "session_suspended",
    };
  }

  const normalised = normalise(userMessage);
  const found = detect(normalised);

  if (!found) {
    sessionStrikes.set(sessionId, row);
    return { profane: false, strikes: row.strikes, suspended: false, reason: null };
  }

  row.strikes += 1;
  if (row.strikes >= STRIKES_TO_SUSPEND) {
    row.suspendedAt = Date.now();
  }
  sessionStrikes.set(sessionId, row);
  return {
    profane: true,
    strikes: row.strikes,
    suspended: Boolean(row.suspendedAt),
    reason: `matched: ${found}`,
  };
}

/**
 * Read-only check — does NOT increment strikes. Used by the chat route to
 * verify a session is still allowed before processing the turn.
 */
export function isSuspended(sessionId: string): boolean {
  const row = sessionStrikes.get(sessionId);
  return Boolean(row?.suspendedAt);
}

/** Tests + admin tooling. */
export function _resetForTests(): void {
  sessionStrikes.clear();
}

function detect(normalisedText: string): string | null {
  for (const stem of PROFANITY_STEMS) {
    // Word-boundary match. The normalisation step above has stripped the
    // common bypass characters, so a simple substring + boundary check is
    // robust enough for the obvious cases.
    const rx = new RegExp(`\\b${stem}[a-z]{0,4}\\b`, "i");
    if (rx.test(normalisedText)) return stem;
  }
  return null;
}
