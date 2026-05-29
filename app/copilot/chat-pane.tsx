"use client";

import { useEffect, useRef, useState } from "react";
import type { Message } from "@ai-sdk/react";
import { cn } from "@/lib/utils/cn";
import type { RosterEntry } from "@/lib/sessions/roster";

/**
 * ChatPane — chat surface (left pane / full pane when canvas is empty).
 *
 * Stateless renderer. Owns: scroll-to-bottom on new content, composer, and
 * the markdown-link rendering inside assistant messages (so KB citations
 * like ([page-name](url)) become real clickable links).
 *
 * The `embed` prop trims the composer caption + opener wording so the chat
 * reads naturally as a widget inside thisisgravitas.com.
 */
export function ChatPane({
  messages,
  input,
  onInputChange,
  onSubmit,
  isStreaming,
  error,
  embed = false,
  resumed = false,
  onStartFresh,
  recentChats = [],
  activeSessionId = null,
  disclaimer = "",
}: {
  messages: Message[];
  input: string;
  onInputChange: (
    e: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLTextAreaElement>,
  ) => void;
  onSubmit: (e?: React.FormEvent<HTMLFormElement>) => void;
  isStreaming: boolean;
  error: Error | undefined;
  embed?: boolean;
  /** True when this mount restored prior messages from /api/chat/history. */
  resumed?: boolean;
  /** Mint a fresh session id + wipe in-memory chat. */
  onStartFresh?: () => void;
  /** Roster of prior chats, used by the embed-mode header dropdown. */
  recentChats?: RosterEntry[];
  /** Current chat id — used to highlight it in the dropdown. */
  activeSessionId?: string | null;
  /**
   * AI-disclaimer line shown below the composer in embed mode (P1.19).
   * Empty string = render nothing. The standalone /copilot footer
   * shows the same string in its own chrome.
   */
  disclaimer?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  return (
    <div className={cn("flex flex-col", embed ? "h-screen" : "h-[calc(100vh-7.5rem)] min-h-[28rem]")}>
      {embed ? (
        <EmbedHeader
          recentChats={recentChats}
          activeSessionId={activeSessionId}
          onStartFresh={onStartFresh}
        />
      ) : null}
      {resumed && messages.length > 0 ? (
        // In embed mode the EmbedHeader already exposes "New chat" — passing
        // undefined hides the banner's own button so the visitor doesn't see
        // two near-identical CTAs stacked on top of each other.
        <ResumeBanner onStartFresh={embed ? undefined : onStartFresh} />
      ) : null}
      <div
        ref={scrollRef}
        className={cn(
          "flex-1 space-y-4 overflow-y-auto px-5 py-6",
          // Embed mode: parent iframe overlays an X button at top-right.
          // Without right padding on the first scroll-row, a long visitor
          // bubble (max-w 88%) collides with the X.
          embed && "pr-12",
        )}
      >
        {messages.length === 0 ? <Opener embed={embed} /> : null}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {error ? (
          <div className="rounded-lg border border-severity-critical/40 bg-severity-critical/5 px-3 py-2 text-sm text-severity-critical">
            {error.message}
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || isStreaming) return;
          onSubmit(e);
        }}
        className="border-t border-paper-edge bg-paper px-5 py-4"
      >
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <div className="flex items-end gap-2 rounded-2xl border border-paper-edge bg-paper-soft/60 px-3 py-2 focus-within:border-ink-muted">
          <textarea
            id="chat-input"
            value={input}
            onChange={onInputChange}
            placeholder="Describe a digital problem, or paste a URL you'd like audited."
            rows={2}
            className={cn(
              "flex-1 resize-none bg-transparent text-sm leading-relaxed text-ink",
              "placeholder:text-ink-muted focus:outline-none",
            )}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!input.trim() || isStreaming) return;
                onSubmit();
              }
            }}
            disabled={isStreaming}
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            aria-label={isStreaming ? "Co-Pilot is thinking" : "Send message"}
            className={cn(
              "shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper",
              "transition hover:bg-ink-soft",
              "disabled:cursor-not-allowed disabled:bg-ink-muted/40 disabled:text-paper/80",
              // Fixed width while streaming so the button doesn't reflow as
              // content swaps Send → loader. Matches the natural width of
              // "Send" + horizontal padding.
              isStreaming && "min-w-[64px]",
            )}
          >
            {isStreaming ? (
              <span className="flex items-center justify-center">
                <span className="chat-loader chat-loader--sm" aria-hidden="true" />
              </span>
            ) : (
              "Send"
            )}
          </button>
        </div>
        {!embed ? (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Enter to send · Shift+Enter for newline
          </p>
        ) : null}
        {/* P1.19 — AI disclaimer. Embed mode renders it here (the only
            chrome the iframe owns); standalone /copilot route has its own
            footer that shows the same string. */}
        {embed && disclaimer ? (
          <p className="mt-2 text-[10px] italic leading-snug text-ink-muted">
            {disclaimer}
          </p>
        ) : null}
      </form>
    </div>
  );
}

/**
 * Header bar rendered ONLY in embed mode (inside the iframe widget on
 * thisisgravitas.com). Two jobs:
 *
 *   1. Give the visitor access to their previous conversations — the
 *      embed widget skips the public landing page (which is where the
 *      Recent Chats list lives), so without this they have no way back
 *      to a prior session.
 *
 *   2. Reserve a 48-px gutter on the right so embed.js's floating "×"
 *      button (positioned at top:10px right:10px of the iframe panel)
 *      doesn't collide with the visitor's first message bubble.
 *
 * The dropdown is intentionally small + monochrome — it sits inside a
 * 420×640 iframe and shouldn't compete for attention with the chat.
 */
function EmbedHeader({
  recentChats,
  activeSessionId,
  onStartFresh,
}: {
  recentChats: RosterEntry[];
  activeSessionId: string | null;
  onStartFresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Outside-click closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Filter the active chat out of the "switch to" list — there's no point
  // listing the chat you're already in. Newest first; cap at 8 for the
  // small iframe.
  const switchable = recentChats
    .filter((c) => c.id !== activeSessionId)
    .slice(0, 8);

  return (
    <div
      ref={wrapRef}
      className="relative flex items-center justify-between gap-3 border-b border-paper-edge bg-paper px-4 py-2 pr-12"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-ink-soft",
          "transition hover:bg-paper-soft",
          open && "bg-paper-soft text-ink",
        )}
      >
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M3 6h18M3 18h18" />
        </svg>
        Chats
        {switchable.length > 0 ? (
          <span className="rounded-full bg-ink/10 px-1.5 text-[10px] text-ink-soft">
            {switchable.length}
          </span>
        ) : null}
      </button>

      <button
        type="button"
        onClick={() => {
          setOpen(false);
          onStartFresh?.();
        }}
        className={cn(
          "rounded-full border border-paper-edge px-2.5 py-1 text-[11px] text-ink-soft",
          "transition hover:border-ink-muted hover:text-ink",
        )}
      >
        New chat
      </button>

      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute left-3 top-[calc(100%+4px)] z-20 w-72",
            "rounded-xl border border-paper-edge bg-paper shadow-lg",
            "overflow-hidden",
          )}
        >
          <div className="border-b border-paper-edge px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Recent chats
          </div>
          {switchable.length === 0 ? (
            <p className="px-3 py-4 text-xs text-ink-muted">
              No other chats yet. Start a new one with the button on the right.
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {switchable.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={`/copilot?embed=1&session=${entry.id}`}
                    className="flex flex-col gap-0.5 border-b border-paper-edge px-3 py-2 transition last:border-b-0 hover:bg-paper-soft/60"
                    onClick={() => setOpen(false)}
                  >
                    <span className="line-clamp-1 text-xs text-ink">
                      {entry.preview ?? "(no message yet)"}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                      {formatRelativeShort(entry.lastSeenAt)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatRelativeShort(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
  });
}

/**
 * Slim banner shown above the message list when the chat resumed from
 * localStorage. Gives the visitor a one-click "Start fresh" reset so a
 * borrowed device or finished conversation doesn't trap them in old context.
 *
 * Visually tame: monospace label + a single text button. Doesn't shift
 * layout — sits in the flex column above the scrolling message list.
 */
function ResumeBanner({ onStartFresh }: { onStartFresh?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-paper-edge bg-paper-soft/50 px-5 py-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        Resumed your previous conversation
      </span>
      {onStartFresh ? (
        <button
          type="button"
          onClick={onStartFresh}
          className={cn(
            "rounded-full border border-paper-edge px-3 py-0.5 text-[11px] text-ink-soft",
            "transition hover:border-ink-muted hover:text-ink",
          )}
        >
          Start a new chat
        </button>
      ) : null}
    </div>
  );
}

function Opener({ embed }: { embed: boolean }) {
  return (
    <div className="space-y-4 rounded-2xl border border-paper-edge bg-paper px-4 py-5">
      <p className="font-display text-lg font-semibold leading-snug">
        We make Firsts. Not Followers.
      </p>
      <p className="text-sm text-ink-soft">
        Tell me one thing — what&apos;s the friction you&apos;re feeling today? I&apos;ll think
        across UX, CX, technology, and AI, and {embed ? "show you the answer here." : "start sketching the answer in the canvas on the right."}
      </p>
      <p className="text-xs text-ink-muted">
        Paste a URL and I&apos;ll audit the page — performance, accessibility, conversion, design execution.
      </p>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const text = extractText(message);
  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-ink text-paper"
            : "border border-paper-edge bg-paper text-ink",
        )}
      >
        {isUser ? text : renderAssistantText(text)}
      </div>
    </div>
  );
}

function extractText(message: Message): string {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    return message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return message.content ?? "";
}

/**
 * Render assistant text with inline markdown links.
 *
 * The Discovery node prompts Claude to cite sources as `([page-name](url))`.
 * Without this, those would render as raw markdown to the user. We parse
 * the well-known `[text](url)` pattern and replace each match with a real
 * <a> tag — `target=_blank` + `rel=noopener noreferrer` for safety.
 *
 * Intentionally narrow: we only parse links. Other markdown (bold, lists,
 * headings) is rare in 2-4-sentence agent replies; skipping the full
 * markdown grammar avoids bringing in a parser dep + the XSS surface that
 * comes with HTML rendering.
 */
function renderAssistantText(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const linkRx = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = linkRx.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push(<span key={`t${key++}`}>{text.slice(lastIndex, match.index)}</span>);
    }
    const [, label, href] = match;
    out.push(
      <a
        key={`l${key++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline decoration-accent/40 underline-offset-2 transition hover:decoration-accent"
      >
        {label}
      </a>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    out.push(<span key={`t${key++}`}>{text.slice(lastIndex)}</span>);
  }
  return out;
}
