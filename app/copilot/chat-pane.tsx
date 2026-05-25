"use client";

import { useEffect, useRef } from "react";
import type { Message } from "@ai-sdk/react";
import { cn } from "@/lib/utils/cn";

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
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  return (
    <div className={cn("flex flex-col", embed ? "h-screen" : "h-[calc(100vh-7.5rem)] min-h-[28rem]")}>
      {resumed && messages.length > 0 ? (
        <ResumeBanner onStartFresh={onStartFresh} />
      ) : null}
      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto px-5 py-6"
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
      </form>
    </div>
  );
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
