import nodemailer, { type Transporter } from "nodemailer";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Email notifications — Phase 1.8.
 *
 * Sends KB ingest-run summaries to the admin-configured recipient list.
 * Triggered from worker/src/kb-ingest.ts after each finishRunRow call.
 *
 * Transport: nodemailer over SMTP. Gmail / Google Workspace App Passwords
 * work natively (host=smtp.gmail.com, port=465, secure=true). Self-hosted
 * SMTP servers also work — set SMTP_HOST + SMTP_PORT accordingly.
 *
 * Best-effort: every failure is logged but never thrown — a transient SMTP
 * outage must not break the ingest. The KB still gets refreshed; the admin
 * just doesn't get the email this time.
 *
 * Settings live in admin_settings (migration 0004):
 *   kb_notify_emails           text[]
 *   kb_notify_on_success       boolean
 *   kb_notify_on_failure       boolean
 */

export interface KbRunSummary {
  runId: string | null;
  status: "completed" | "failed";
  mode: "incremental" | "reseed";
  triggeredBy: string;
  pagesPlanned: number;
  pagesFetched: number;
  pagesUnchanged: number;
  pagesErrored: number;
  chunksEmbedded: number;
  durationMs: number;
  errorMessage?: string | null;
  /** Absolute URL used in the "View in admin" link inside the email. */
  appUrl?: string;
}

interface NotificationSettings {
  emails: string[];
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

let cachedTransporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (cachedTransporter !== undefined) return cachedTransporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) {
    cachedTransporter = null;
    return null;
  }
  const port = Number(process.env.SMTP_PORT ?? 465);
  const secure = port === 465; // 465 = TLS-on-connect; 587 = STARTTLS
  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  return cachedTransporter;
}

function getSettings(): { fromAddress: string; fromName: string } {
  return {
    fromAddress: process.env.SMTP_USER ?? "noreply@thisisgravitas.com",
    fromName: process.env.EMAIL_FROM_NAME ?? "Gravitas Co-Pilot",
  };
}

// ---------------------------------------------------------------------------
// Public entry — called after each run finalises
// ---------------------------------------------------------------------------

export async function sendIngestNotification(
  supabase: SupabaseClient | null,
  summary: KbRunSummary,
  log: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void },
): Promise<void> {
  if (!supabase) return;

  let settings: NotificationSettings | null;
  try {
    settings = await loadNotificationSettings(supabase);
  } catch (err) {
    log.warn("[email] could not load notification settings", {
      err: (err as Error).message,
    });
    return;
  }
  if (!settings || settings.emails.length === 0) {
    return;
  }
  if (summary.status === "completed" && !settings.notifyOnSuccess) return;
  if (summary.status === "failed" && !settings.notifyOnFailure) return;

  const transporter = getTransporter();
  if (!transporter) {
    log.warn(
      "[email] SMTP not configured (need SMTP_HOST + SMTP_USER + SMTP_PASSWORD) — skipping notification",
    );
    return;
  }

  const { fromAddress, fromName } = getSettings();
  const subject = composeSubject(summary);
  const html = composeHtml(summary);
  const text = composeText(summary);

  try {
    await transporter.sendMail({
      from: { address: fromAddress, name: fromName },
      to: settings.emails,
      subject,
      html,
      text,
    });
    log.info("[email] ingest notification sent", {
      recipients: settings.emails.length,
      status: summary.status,
    });
  } catch (err) {
    log.warn("[email] sendMail failed", { err: (err as Error).message });
  }
}

async function loadNotificationSettings(
  supabase: SupabaseClient,
): Promise<NotificationSettings | null> {
  const { data, error } = await supabase
    .from("admin_settings")
    .select("kb_notify_emails, kb_notify_on_success, kb_notify_on_failure")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    kb_notify_emails: string[] | null;
    kb_notify_on_success: boolean | null;
    kb_notify_on_failure: boolean | null;
  };
  return {
    emails: (row.kb_notify_emails ?? []).filter((e) => typeof e === "string" && e.length > 0),
    notifyOnSuccess: row.kb_notify_on_success !== false, // default true
    notifyOnFailure: row.kb_notify_on_failure !== false,
  };
}

// ---------------------------------------------------------------------------
// Content composition
// ---------------------------------------------------------------------------

function composeSubject(s: KbRunSummary): string {
  const verb = s.status === "completed" ? "completed" : "FAILED";
  const mode = s.mode === "reseed" ? "Full reseed" : "Refresh";
  return `[Gravitas KB] ${mode} ${verb} · ${s.pagesFetched} pages · ${formatDuration(s.durationMs)}`;
}

function composeText(s: KbRunSummary): string {
  const lines = [
    `Gravitas KB ingest ${s.status === "completed" ? "completed" : "FAILED"}`,
    "",
    `Mode:           ${s.mode}`,
    `Triggered by:   ${s.triggeredBy}`,
    `Duration:       ${formatDuration(s.durationMs)}`,
    `Pages planned:  ${s.pagesPlanned}`,
    `Pages fetched:  ${s.pagesFetched}`,
    `Pages unchanged: ${s.pagesUnchanged}`,
    `Pages errored:  ${s.pagesErrored}`,
    `Chunks embedded: ${s.chunksEmbedded}`,
  ];
  if (s.errorMessage) {
    lines.push("", `Error: ${s.errorMessage}`);
  }
  if (s.appUrl) {
    lines.push("", `View in admin: ${s.appUrl}/admin/kb`);
  }
  return lines.join("\n");
}

function composeHtml(s: KbRunSummary): string {
  const ok = s.status === "completed";
  const accent = ok ? "#2E8B6B" : "#B91C1C";
  const statusLabel = ok ? "Completed" : "Failed";
  const mode = s.mode === "reseed" ? "Full reseed" : "Refresh";

  const row = (label: string, value: string | number, tone?: "ok" | "warn") => {
    const valueColor =
      tone === "warn" && typeof value === "number" && value > 0
        ? "#B91C1C"
        : tone === "ok" && typeof value === "number" && value > 0
          ? "#2E8B6B"
          : "#0B0B0F";
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #E5E5DC;color:#6B6B75;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(label)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #E5E5DC;color:${valueColor};font-family:ui-monospace,monospace;font-size:13px;">${escapeHtml(String(value))}</td>
    </tr>`;
  };

  const adminLink = s.appUrl
    ? `<p style="margin:24px 0 0;font-size:13px;"><a href="${escapeHtml(s.appUrl)}/admin/kb" style="color:#E94E1B;text-decoration:none;">View in admin →</a></p>`
    : "";

  const errorBlock = s.errorMessage
    ? `<div style="margin-top:16px;padding:12px;border-left:3px solid #B91C1C;background:#FDF2F2;color:#7F1D1D;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;">${escapeHtml(s.errorMessage)}</div>`
    : "";

  return `<!doctype html>
<html lang="en"><body style="margin:0;background:#FAFAF7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0B0B0F;">
  <div style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border:1px solid #E5E5DC;border-radius:16px;">
    <p style="margin:0;color:#6B6B75;font-size:11px;text-transform:uppercase;letter-spacing:0.12em;">Gravitas Co-Pilot · KB ingest</p>
    <h1 style="margin:8px 0 4px;font-size:22px;font-weight:600;color:${accent};">${statusLabel}</h1>
    <p style="margin:0 0 20px;font-size:14px;color:#2A2A33;">${mode} · ${formatDuration(s.durationMs)} · triggered by ${escapeHtml(s.triggeredBy)}</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #E5E5DC;border-radius:8px;overflow:hidden;">
      ${row("Pages planned", s.pagesPlanned)}
      ${row("Pages fetched", s.pagesFetched, "ok")}
      ${row("Pages unchanged", s.pagesUnchanged)}
      ${row("Pages errored", s.pagesErrored, "warn")}
      ${row("Chunks embedded", s.chunksEmbedded, "ok")}
    </table>
    ${errorBlock}
    ${adminLink}
    <p style="margin:24px 0 0;font-size:11px;color:#6B6B75;">This message was sent automatically by the Gravitas Transformation Co-Pilot. Configure recipients at /admin/kb.</p>
  </div>
</body></html>`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
