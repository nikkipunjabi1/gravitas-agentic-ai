"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useChat, type Message } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPane } from "./chat-pane";
import { CanvasPane } from "./canvas-pane";
import { UIAction } from "@/canvas/schema";
import { cn } from "@/lib/utils/cn";
import { isUuid, upsertSession, readRoster, type RosterEntry } from "@/lib/sessions/roster";

/**
 * CopilotShell — dual-pane mount.
 *
 *  Left  (chat)    — useChat() consumes the AI SDK Data Stream Protocol.
 *  Right (canvas)  — observes `data` from the same stream and renders
 *                     validated UIActions via the canvas registry.
 *
 * One stream, two consumers (UI_CONTRACT.md → "Do not open a second
 * connection for the canvas"). The demuxing happens client-side here.
 *
 * Session identity comes from the URL: `/copilot?session=<uuid>`.
 *   - When the param is missing, we mint a new uuid, push it to the URL with
 *     history.replaceState, and add it to the localStorage roster.
 *   - When the param is present + valid, we use it as-is. This is how the
 *     landing-page "Recent chats" list deep-links into a specific chat.
 *   - When the param is present but malformed/expired, we mint fresh — never
 *     leak an error UI.
 *
 * The localStorage roster (src/lib/sessions/roster.ts) keeps up to 10 recent
 * session ids with previews. The shell touches it in three places:
 *   - on mount, to bump `lastSeenAt`,
 *   - on first user message, to write the preview,
 *   - on "Start a new chat", to mint + register the new id.
 */
export function CopilotShell({
  embed = false,
  requestedSessionId = null,
  disclaimer = "",
}: {
  embed?: boolean;
  /**
   * Session id requested via the URL `?session=<uuid>` query param.
   * Validated server-side in app/copilot/page.tsx — null here means "mint
   * a fresh id on mount". When this changes (route navigation to a
   * different ?session=), the shell switches chats without remounting.
   */
  requestedSessionId?: string | null;
  /**
   * AI-generated content disclaimer (P1.19). Resolved server-side from
   * /admin/settings → Branding (with a hardcoded default fallback in
   * runtime-config.ts). Rendered only in embed mode; the standalone
   * /copilot route shows it in its own footer.
   */
  disclaimer?: string;
} = {}) {
  const { sessionId, startNewChat } = useSessionId(requestedSessionId);

  // useChat keys its internal state by `id` — when sessionId changes (visitor
  // jumped to a different chat or clicked "Start a new chat"), useChat gives
  // us a fresh isolated state automatically, no manual setMessages([]) needed.
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    data,
    status,
    error,
    setMessages,
    setInput,
  } = useChat({
    id: sessionId,
    api: "/api/chat",
    body: { sessionId },
  });

  // ---- Resume on mount ----------------------------------------------------
  const [resumed, setResumed] = useState(false);
  const hydratedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || sessionId === PLACEHOLDER_SESSION_ID) return;
    if (hydratedFor.current === sessionId) return;
    hydratedFor.current = sessionId;
    setResumed(false); // reset banner state when switching chats

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn("[copilot] history fetch failed", { sessionId, status: res.status });
          return;
        }
        if (cancelled) return;
        const body = (await res.json()) as {
          messages?: Array<{ id: string; role: "user" | "assistant"; content: string }>;
          suspended?: boolean;
        };
        if (cancelled) return;
        if (body.suspended) {
          // eslint-disable-next-line no-console
          console.info("[copilot] session is suspended (profanity gate)", { sessionId });
          return;
        }
        if (!body.messages || body.messages.length === 0) {
          // eslint-disable-next-line no-console
          console.info(
            "[copilot] no prior messages for this session — starting fresh",
            { sessionId, hint: "Check /admin/sessions/" + sessionId + " to verify server-side." },
          );
          return;
        }

        setMessages((current) => {
          if (current.length > 0) return current;
          setResumed(true);
          // Reseed the roster preview from server history (covers the case
          // where the roster lost the entry but the server still has it).
          const firstUserMsg = body.messages!.find((m) => m.role === "user");
          if (firstUserMsg) {
            upsertSession(sessionId, { preview: firstUserMsg.content });
          }
          return body.messages!.map<Message>((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
          }));
        });
      } catch {
        // History is best-effort. Silently fall back to a fresh chat.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, setMessages]);

  // ---- Keep roster preview in sync with the first user message ------------
  // Runs whenever the messages array changes; the upsert helper is idempotent
  // so re-running it on every keystroke after the first message is cheap +
  // safe. It bumps `lastSeenAt` as a side effect, which keeps the active chat
  // at the top of the landing-page list.
  const previewWrittenFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || sessionId === PLACEHOLDER_SESSION_ID) return;
    const firstUser = messages.find((m) => m.role === "user");
    if (!firstUser) return;
    const text =
      typeof firstUser.content === "string" && firstUser.content.trim().length > 0
        ? firstUser.content
        : null;
    if (!text) return;
    // Same session + same preview already written → no-op.
    const key = `${sessionId}|${text.slice(0, 32)}`;
    if (previewWrittenFor.current === key) return;
    previewWrittenFor.current = key;
    upsertSession(sessionId, { preview: text });
  }, [messages, sessionId]);

  // ---- "Start a new chat" -------------------------------------------------
  const handleStartFresh = useCallback(() => {
    setMessages([]);
    setActions([]);
    setInput("");
    setResumed(false);
    hydratedFor.current = null;
    previewWrittenFor.current = null;
    startNewChat();
  }, [setMessages, setInput, startNewChat]);

  // ---- Canvas action store -------------------------------------------------
  const [actions, setActions] = useState<UIAction[]>([]);
  const consumedUpTo = useRef(0);

  // Resetting the consumed counter when sessionId changes ensures we don't
  // skip parts in the new chat's `data` stream just because we'd already
  // consumed N items in the previous chat.
  useEffect(() => {
    consumedUpTo.current = 0;
    setActions([]);
  }, [sessionId]);

  useEffect(() => {
    if (!data) return;
    if (consumedUpTo.current >= data.length) return;

    const fresh = data.slice(consumedUpTo.current);
    consumedUpTo.current = data.length;

    const newActions: UIAction[] = [];
    for (const part of fresh) {
      if (!isUIActionPart(part)) continue;
      const parsed = UIAction.safeParse(part.action);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.warn("[canvas] dropped invalid UIAction", parsed.error.issues);
        continue;
      }
      newActions.push(parsed.data);
    }
    if (newActions.length === 0) return;

    setActions((prev) => mergeActions(prev, newActions));
  }, [data]);

  const isStreaming = status === "streaming" || status === "submitted";
  const canvasVisible = actions.length > 0;

  // ---- Embed-mode handshake with the parent page -------------------------
  // When the audit lands and the canvas has content, the floating widget in
  // public/embed.js needs to expand the iframe panel — otherwise the canvas
  // crushes the chat into the same 420×640 box and the visitor gets three
  // scrollbars stacked on top of each other. Two-way protocol:
  //
  //   iframe → parent : { type: "gravitas:canvas-state", open: true|false }
  //
  // embed.js listens, toggles `.gv-panel--expanded` on the floating panel.
  // We post on every canvas-visibility transition + once on mount so a fresh
  // load with a resumed chat starts in the right size.
  useEffect(() => {
    if (!embed) return;
    if (typeof window === "undefined") return;
    if (window.parent === window) return; // not actually iframed
    try {
      window.parent.postMessage(
        { type: "gravitas:canvas-state", open: canvasVisible },
        "*",
      );
    } catch {
      // cross-origin restriction or detached frame — best-effort only
    }
  }, [embed, canvasVisible]);

  // ---- Recent chats roster (embed dropdown only reads this) --------------
  // Read once on mount and on every sessionId change so a fresh session
  // appears in the dropdown without a reload. Kept lightweight — readRoster
  // is synchronous and tiny.
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setRoster(readRoster());
  }, [sessionId, messages.length]);

  // Memoise to keep the ChatPane ref-stable so its scroll-to-bottom effect
  // doesn't re-fire on every render.
  const onStartFresh = useMemo(() => handleStartFresh, [handleStartFresh]);

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <section
        className={cn(
          "flex w-full flex-col border-paper-edge transition-[width] duration-300 ease-out",
          canvasVisible
            ? "lg:w-[42%] lg:border-r"
            : "lg:w-full lg:max-w-2xl lg:mx-auto",
        )}
      >
        <ChatPane
          messages={messages}
          input={input}
          onInputChange={handleInputChange}
          onSubmit={handleSubmit}
          isStreaming={isStreaming}
          error={error}
          embed={embed}
          resumed={resumed}
          onStartFresh={onStartFresh}
          recentChats={roster}
          activeSessionId={sessionId}
          disclaimer={disclaimer}
        />
      </section>

      <AnimatePresence initial={false}>
        {canvasVisible ? (
          <motion.section
            key="canvas"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
            className="flex w-full flex-1 flex-col bg-paper-soft/40"
          >
            <CanvasPane
              actions={actions}
              isStreaming={isStreaming}
              onClose={() => setActions([])}
            />
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUIActionPart(value: unknown): value is { type: "ui-action"; action: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "ui-action" &&
    "action" in value
  );
}

function mergeActions(prev: UIAction[], incoming: UIAction[]): UIAction[] {
  let next = prev;
  let mutated = false;
  for (const action of incoming) {
    const existingIdx = next.findIndex((a) => a.id === action.id);
    if (existingIdx === -1) {
      if (!mutated) {
        next = [...next];
        mutated = true;
      }
      next.push(action);
    } else {
      if (!mutated) {
        next = [...next];
        mutated = true;
      }
      next[existingIdx] = action;
    }
  }
  return next;
}

const PLACEHOLDER_SESSION_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Session-id source-of-truth: the `requestedSessionId` prop, which is
 * read from `?session=<uuid>` by the server component in
 * app/copilot/page.tsx. The prop is the single client-side input that
 * decides which chat to render.
 *
 * Lifecycle:
 *   1. Initial render — `id` is seeded from the prop (or PLACEHOLDER when
 *      the URL had no session). Render is pure; nothing mutates.
 *   2. Mount / prop-change effect — when `id` differs from the latest
 *      requested prop, switch to it. When the prop is null, mint a fresh
 *      uuid and write it back to the URL.
 *   3. `startNewChat()` mints a uuid, replaces the URL, and updates `id`.
 *
 * Why a prop rather than `window.location`: clicking a recent-chats <Link>
 * from "/copilot?session=A" to "/copilot?session=B" stays on the same
 * route. The client component doesn't unmount, so a useState initializer
 * that reads window.location only ever saw the original URL — the chat got
 * stuck on A. Passing the validated id down as a prop guarantees React
 * sees the change as a normal prop update, and the effect below routes
 * the new id into useChat / the roster / the history fetch.
 */
function useSessionId(requestedSessionId: string | null): {
  sessionId: string;
  startNewChat: () => void;
} {
  // Seed from the prop on first render. No side-effects here — the effect
  // below commits the roster write + (when needed) a URL update.
  const [id, setId] = useState<string>(() => {
    if (requestedSessionId && isUuid(requestedSessionId)) {
      return requestedSessionId;
    }
    return PLACEHOLDER_SESSION_ID;
  });

  // Track the prop value we last reconciled against. The reconciliation
  // effect MUST only fire on prop changes — not on internal id changes —
  // or `startNewChat`'s setId(fresh) would immediately get reverted to the
  // stale prop value (the server-component URL update isn't observed by
  // window.history.replaceState, so requestedSessionId stays at the old
  // id until a full route navigation).
  const lastReconciledProp = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Skip if we've already applied this exact prop value.
    if (lastReconciledProp.current === requestedSessionId) return;
    lastReconciledProp.current = requestedSessionId;

    const desired =
      requestedSessionId && isUuid(requestedSessionId) ? requestedSessionId : null;

    if (desired) {
      setId(desired);
      upsertSession(desired);
      return;
    }

    // No prop value — mint fresh, but ONLY if our internal state hasn't
    // already been populated (otherwise we'd clobber a uuid we minted
    // earlier in this mount). Read current id via setId's callback form
    // so we don't have to add `id` to the dep array — that would re-fire
    // the effect every time startNewChat updates id, which is exactly the
    // bug we're avoiding.
    setId((current) => {
      if (current !== PLACEHOLDER_SESSION_ID) return current;
      const fresh = crypto.randomUUID();
      upsertSession(fresh);
      const url = new URL(window.location.href);
      url.searchParams.set("session", fresh);
      window.history.replaceState({}, "", url.toString());
      return fresh;
    });
  }, [requestedSessionId]);

  const startNewChat = useCallback(() => {
    if (typeof window === "undefined") return;
    const fresh = crypto.randomUUID();
    upsertSession(fresh);
    const url = new URL(window.location.href);
    url.searchParams.set("session", fresh);
    window.history.replaceState({}, "", url.toString());
    // Record the URL we just wrote so the reconciliation effect doesn't
    // think the prop has "changed back" to the original value on a
    // subsequent prop-equality check.
    lastReconciledProp.current = fresh;
    setId(fresh);
  }, []);

  return { sessionId: id, startNewChat };
}

// Re-export used types so test files can import from this module surface.
export type { UIAction };
