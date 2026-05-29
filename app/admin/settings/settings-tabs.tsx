"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils/cn";
import type { SettingKey } from "@/server/settings";
import type {
  BrandingConfig,
  EmbedConfig,
  KbConfig,
  AgentPrompts,
  FeatureFlags,
} from "@/server/runtime-config";

interface MetaMap {
  [key: string]: { updatedAt: string; updatedBy: string | null };
}

export function SettingsTabs({
  rateLimits,
  branding,
  embed,
  kb,
  prompts,
  features,
  disclaimerSaved,
  meta,
}: {
  rateLimits: { turnLimit: number; auditLimit: number };
  branding: BrandingConfig;
  embed: EmbedConfig;
  kb: KbConfig;
  prompts: AgentPrompts;
  features: FeatureFlags;
  disclaimerSaved: string;
  meta: MetaMap;
}) {
  const [activeTab, setActiveTab] = useState<TabKey>("rate-limits");

  return (
    <div className="space-y-4">
      <nav
        className="flex flex-wrap gap-1 rounded-full border border-paper-edge bg-paper p-1"
        aria-label="Settings sections"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs transition",
              activeTab === t.key
                ? "bg-ink text-paper"
                : "text-ink-soft hover:bg-paper-soft hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="rounded-2xl border border-paper-edge bg-paper p-5">
        {activeTab === "rate-limits" ? (
          <RateLimitsSection rateLimits={rateLimits} meta={meta} />
        ) : null}
        {activeTab === "branding" ? (
          <BrandingSection
            branding={branding}
            disclaimerSaved={disclaimerSaved}
            meta={meta}
          />
        ) : null}
        {activeTab === "embed" ? (
          <EmbedSection embed={embed} meta={meta} />
        ) : null}
        {activeTab === "knowledge-base" ? (
          <KbSection kb={kb} meta={meta} />
        ) : null}
        {activeTab === "prompts" ? (
          <PromptsSection prompts={prompts} meta={meta} />
        ) : null}
        {activeTab === "features" ? (
          <FeaturesSection features={features} meta={meta} />
        ) : null}
      </div>
    </div>
  );
}

type TabKey =
  | "rate-limits"
  | "branding"
  | "embed"
  | "knowledge-base"
  | "prompts"
  | "features";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "rate-limits", label: "Rate limits" },
  { key: "branding", label: "Branding" },
  { key: "embed", label: "Embed widget" },
  { key: "knowledge-base", label: "Knowledge base" },
  { key: "prompts", label: "Agent prompts" },
  { key: "features", label: "Features" },
];

// ---------------------------------------------------------------------------
// Shared save infrastructure
// ---------------------------------------------------------------------------

function useSettingSaver() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<Record<string, { tone: "ok" | "err"; msg: string }>>({});

  const save = async (key: SettingKey, value: unknown) => {
    setStatus((s) => ({ ...s, [key]: { tone: "ok", msg: "Saving…" } }));
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      setStatus((s) => ({ ...s, [key]: { tone: "ok", msg: "Saved." } }));
      startTransition(() => router.refresh());
    } catch (err) {
      setStatus((s) => ({
        ...s,
        [key]: { tone: "err", msg: (err as Error).message },
      }));
    }
  };

  return { save, status };
}

function StatusLine({ entry }: { entry?: { tone: "ok" | "err"; msg: string } }) {
  if (!entry) return null;
  return (
    <p
      className={cn(
        "mt-1 text-xs",
        entry.tone === "ok" ? "text-ink-muted" : "text-severity-critical",
      )}
    >
      {entry.msg}
    </p>
  );
}

function MetaLine({ meta }: { meta?: { updatedAt: string; updatedBy: string | null } }) {
  if (!meta) return null;
  if (!meta.updatedAt || meta.updatedAt === new Date(0).toISOString()) return null;
  return (
    <p className="font-mono text-[10px] text-ink-muted/80">
      Last changed {new Date(meta.updatedAt).toLocaleString()}
      {meta.updatedBy ? ` by ${meta.updatedBy}` : ""}
    </p>
  );
}

function FieldHeader({
  label,
  hint,
  keyName,
  meta,
}: {
  label: string;
  hint?: string;
  keyName: string;
  meta?: { updatedAt: string; updatedBy: string | null };
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-sm font-medium text-ink">{label}</label>
        <code className="font-mono text-[10px] text-ink-muted">{keyName}</code>
      </div>
      {hint ? <p className="text-xs text-ink-soft">{hint}</p> : null}
      <MetaLine meta={meta} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Rate limits
// ---------------------------------------------------------------------------

function RateLimitsSection({
  rateLimits,
  meta,
}: {
  rateLimits: { turnLimit: number; auditLimit: number };
  meta: MetaMap;
}) {
  const { save, status } = useSettingSaver();
  const [resetState, setResetState] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);
  const [turn, setTurn] = useState(String(rateLimits.turnLimit));
  const [audit, setAudit] = useState(String(rateLimits.auditLimit));

  const handleReset = async () => {
    setResetState({ tone: "ok", msg: "Resetting…" });
    try {
      const res = await fetch("/api/admin/quota/reset", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { deleted: number };
      setResetState({
        tone: "ok",
        msg: `Cleared today's quota — ${body.deleted} row${body.deleted === 1 ? "" : "s"} removed.`,
      });
    } catch (err) {
      setResetState({ tone: "err", msg: (err as Error).message });
    }
  };

  return (
    <div className="space-y-5">
      <NumberFieldCard
        keyName="ip_daily_turn_limit"
        label="Chat turns per IP per day"
        hint="Cap on chat messages from one visitor's IP in a 24-hour window (UTC reset)."
        value={turn}
        onChange={setTurn}
        onSave={() => save("ip_daily_turn_limit", Number(turn))}
        status={status.ip_daily_turn_limit}
        meta={meta.ip_daily_turn_limit}
      />
      <NumberFieldCard
        keyName="ip_daily_audit_limit"
        label="URL audits per IP per day"
        hint="Cap on full Lighthouse audits from one visitor's IP."
        value={audit}
        onChange={setAudit}
        onSave={() => save("ip_daily_audit_limit", Number(audit))}
        status={status.ip_daily_audit_limit}
        meta={meta.ip_daily_audit_limit}
      />

      <div className="rounded-xl border border-paper-edge bg-paper-soft/40 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-ink">Reset today&apos;s IP quota</h3>
            <p className="text-xs text-ink-soft">
              Clears every visitor&apos;s counter for the current UTC day. Use to unblock a
              demo that hit a cap.
            </p>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="shrink-0 rounded-full bg-ink px-4 py-2 text-xs font-medium text-paper transition hover:bg-ink-soft"
          >
            Reset now
          </button>
        </div>
        {resetState ? (
          <p
            className={cn(
              "mt-3 text-xs",
              resetState.tone === "ok" ? "text-ink-soft" : "text-severity-critical",
            )}
          >
            {resetState.msg}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Branding
// ---------------------------------------------------------------------------

function BrandingSection({
  branding,
  disclaimerSaved,
  meta,
}: {
  branding: BrandingConfig;
  disclaimerSaved: string;
  meta: MetaMap;
}) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-soft">
        These values flow into the agent prompts (as <code>{`{{brand_name}}`}</code>,
        <code>{`{{contact_name}}`}</code>, etc.) and into the closing turn / push-to-contact
        message.
      </p>
      <TextFieldCard
        keyName="ui_disclaimer_text"
        label="AI-content disclaimer"
        hint="Short line shown beneath the chat composer (embed + standalone). Reassures visitors the bot's output may contain mistakes. Leave empty to use the built-in default text shown as the placeholder."
        initialValue={disclaimerSaved}
        placeholder="AI-generated responses may contain mistakes. Verify key details before acting."
        meta={meta.ui_disclaimer_text}
      />
      <TextFieldCard
        keyName="branding_brand_name"
        label="Brand name"
        hint="Used in prompts via {{brand_name}}."
        initialValue={branding.brandName}
        meta={meta.branding_brand_name}
      />
      <TextFieldCard
        keyName="branding_contact_name"
        label="Named contact — name"
        hint="Used in prompts via {{contact_name}}. Appears in closing turn handoffs."
        initialValue={branding.contactName}
        meta={meta.branding_contact_name}
      />
      <TextFieldCard
        keyName="branding_contact_role"
        label="Named contact — role"
        hint="Used via {{contact_role}}."
        initialValue={branding.contactRole}
        meta={meta.branding_contact_role}
      />
      <TextFieldCard
        keyName="branding_contact_email"
        label="Named contact — email"
        hint="Used via {{contact_email}}. Validated as an email address."
        initialValue={branding.contactEmail}
        meta={meta.branding_contact_email}
      />
      <TextFieldCard
        keyName="branding_contact_phone"
        label="Named contact — phone (optional)"
        hint="Used via {{contact_phone}}. Free-form; not currently rendered in any prompt by default."
        initialValue={branding.contactPhone}
        meta={meta.branding_contact_phone}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Embed widget
// ---------------------------------------------------------------------------

function EmbedSection({ embed, meta }: { embed: EmbedConfig; meta: MetaMap }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-soft">
        Controls the floating launcher served by <code>/embed.js</code>. Changes propagate
        within ~60 seconds of saving (the embed.js endpoint reads these settings on every
        load, cached for 60s).
      </p>
      <TextFieldCard
        keyName="embed_launcher_text"
        label="Launcher button text"
        hint='e.g. "Talk to the Co-Pilot". Leave empty for an icon-only launcher.'
        initialValue={embed.launcherText}
        meta={meta.embed_launcher_text}
      />
      <ColorFieldCard
        keyName="embed_primary_color"
        label="Launcher background colour"
        hint="Hex colour. The launcher pill + iframe panel header use this."
        initialValue={embed.primaryColor}
        meta={meta.embed_primary_color}
      />
      <ColorFieldCard
        keyName="embed_text_color"
        label="Launcher text colour"
        hint="Hex colour. Must contrast with the background colour above."
        initialValue={embed.textColor}
        meta={meta.embed_text_color}
      />
      <SelectFieldCard
        keyName="embed_position"
        label="Launcher position"
        options={[
          { value: "bottom-right", label: "Bottom right" },
          { value: "bottom-left", label: "Bottom left" },
        ]}
        initialValue={embed.position}
        meta={meta.embed_position}
      />
      <NumberSettingCard
        keyName="embed_width"
        label="Panel width (px)"
        hint="Compact iframe width. Auto-clamps on mobile."
        initialValue={embed.width}
        meta={meta.embed_width}
      />
      <NumberSettingCard
        keyName="embed_height"
        label="Panel height (px)"
        hint="Compact iframe height. Auto-clamps on mobile."
        initialValue={embed.height}
        meta={meta.embed_height}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Knowledge base
// ---------------------------------------------------------------------------

function KbSection({ kb, meta }: { kb: KbConfig; meta: MetaMap }) {
  const [patternsDraft, setPatternsDraft] = useState(kb.whitelistPatterns.join("\n"));
  const { save, status } = useSettingSaver();
  const onSavePatterns = () => {
    const arr = patternsDraft
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    void save("kb_whitelist_patterns", arr);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-soft">
        Controls what the worker crawls into the vector store. Empty whitelist = include
        everything in the sitemap not caught by the always-on denylist (privacy / cookies /
        legal / search / tag / paginate / sitemap / feed). With entries, only paths that
        start with one of these prefixes are ingested.
      </p>
      <TextFieldCard
        keyName="kb_sitemap_url"
        label="Sitemap URL"
        hint="The XML sitemap the worker fetches. Point at a different host to ingest a different client's site."
        initialValue={kb.sitemapUrl}
        meta={meta.kb_sitemap_url}
        placeholder="https://example.com/sitemap.xml"
      />
      <div className="space-y-2 rounded-xl border border-paper-edge bg-paper-soft/40 p-4">
        <FieldHeader
          keyName="kb_whitelist_patterns"
          label="Whitelist path prefixes (one per line)"
          hint='Each entry must start with "/". Example: "/work" matches /work and /work/case-study-1. Leave empty to allow everything (denylist still applies).'
          meta={meta.kb_whitelist_patterns}
        />
        <textarea
          value={patternsDraft}
          onChange={(e) => setPatternsDraft(e.target.value)}
          rows={6}
          placeholder="/&#10;/about&#10;/services&#10;/work&#10;/insights&#10;/contact"
          className="w-full rounded-md border border-paper-edge bg-paper px-2 py-1.5 font-mono text-xs"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onSavePatterns}
            className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper transition hover:bg-ink-soft"
          >
            Save
          </button>
        </div>
        <StatusLine entry={status.kb_whitelist_patterns} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Agent prompts
// ---------------------------------------------------------------------------

function PromptsSection({ prompts, meta }: { prompts: AgentPrompts; meta: MetaMap }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-soft">
        Override the system prompt fed to each agent node. Leave empty to use the code
        default (current production prompt). Supports placeholders: <code>{`{{brand_name}}`}</code>
        , <code>{`{{contact_name}}`}</code>, <code>{`{{contact_role}}`}</code>,
        <code>{`{{contact_email}}`}</code>, <code>{`{{contact_phone}}`}</code> — substituted
        at runtime from the Branding tab.
      </p>
      <PromptCard
        keyName="prompt_discovery_voice_base"
        label="Discovery — brand voice"
        hint="The base voice system prompt. Used by every Discovery sub-mode (problem-statement, gravitas-question, meta, off-topic, KB-grounded, KB-empty)."
        initialValue={prompts.discoveryVoiceBase}
        meta={meta.prompt_discovery_voice_base}
      />
      <PromptCard
        keyName="prompt_discovery_problem"
        label="Discovery — problem statement"
        hint="Used when the visitor names a friction or pastes a URL."
        initialValue={prompts.discoveryProblem}
        meta={meta.prompt_discovery_problem}
      />
      <PromptCard
        keyName="prompt_discovery_kb_grounded"
        label="Discovery — Gravitas question (KB hits)"
        hint="Used when the visitor asks about the brand AND KB chunks were retrieved."
        initialValue={prompts.discoveryKbGrounded}
        meta={meta.prompt_discovery_kb_grounded}
      />
      <PromptCard
        keyName="prompt_discovery_kb_empty"
        label="Discovery — Gravitas question (no KB hits)"
        hint="Used when the visitor asks about the brand but the KB returned nothing relevant."
        initialValue={prompts.discoveryKbEmpty}
        meta={meta.prompt_discovery_kb_empty}
      />
      <PromptCard
        keyName="prompt_discovery_meta"
        label="Discovery — meta / about-the-bot"
        hint='Used when the visitor asks "are you an AI", "how does this work", etc.'
        initialValue={prompts.discoveryMeta}
        meta={meta.prompt_discovery_meta}
      />
      <PromptCard
        keyName="prompt_discovery_offtopic"
        label="Discovery — off-topic refusal"
        hint="Used for greetings + anything not in scope."
        initialValue={prompts.discoveryOfftopic}
        meta={meta.prompt_discovery_offtopic}
      />
      <PromptCard
        keyName="prompt_audit_narration"
        label="Audit narration"
        hint="3-sentence visitor-facing narration after the audit cards render."
        initialValue={prompts.auditNarration}
        meta={meta.prompt_audit_narration}
      />
      <PromptCard
        keyName="prompt_strategy_json"
        label="Strategy — JSON synthesis"
        hint="System prompt that drives the structured Maturity / Themes / Roadmap JSON output."
        initialValue={prompts.strategyJson}
        meta={meta.prompt_strategy_json}
      />
      <PromptCard
        keyName="prompt_strategy_narration"
        label="Strategy — narration"
        hint="3-sentence narration after the Strategy cards land."
        initialValue={prompts.strategyNarration}
        meta={meta.prompt_strategy_narration}
      />
      <PromptCard
        keyName="prompt_output_close"
        label="Output — closing turn"
        hint="The 4-sentence bilingual close + named-contact handoff."
        initialValue={prompts.outputClose}
        meta={meta.prompt_output_close}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field components (typed by editor flavour)
// ---------------------------------------------------------------------------

function NumberFieldCard({
  keyName,
  label,
  hint,
  value,
  onChange,
  onSave,
  status,
  meta,
}: {
  keyName: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  status?: { tone: "ok" | "err"; msg: string };
  meta?: { updatedAt: string; updatedBy: string | null };
}) {
  const valid = /^\d+$/.test(value);
  return (
    <div className="space-y-2 rounded-xl border border-paper-edge bg-paper-soft/40 p-4">
      <FieldHeader keyName={keyName} label={label} hint={hint} meta={meta} />
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-32 rounded-md border bg-paper px-2 py-1.5 text-right font-mono text-sm",
            valid ? "border-paper-edge text-ink" : "border-severity-critical/60",
          )}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={!valid}
          className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper transition hover:bg-ink-soft disabled:bg-ink-muted/40"
        >
          Save
        </button>
      </div>
      <StatusLine entry={status} />
    </div>
  );
}

function NumberSettingCard({
  keyName,
  label,
  hint,
  initialValue,
  meta,
}: {
  keyName: SettingKey;
  label: string;
  hint?: string;
  initialValue: number;
  meta?: { updatedAt: string; updatedBy: string | null };
}) {
  const { save, status } = useSettingSaver();
  const [draft, setDraft] = useState(String(initialValue));
  return (
    <NumberFieldCard
      keyName={keyName}
      label={label}
      hint={hint}
      value={draft}
      onChange={setDraft}
      onSave={() => void save(keyName, Number(draft))}
      status={status[keyName]}
      meta={meta}
    />
  );
}

function TextFieldCard({
  keyName,
  label,
  hint,
  initialValue,
  placeholder,
  meta,
}: {
  keyName: SettingKey;
  label: string;
  hint?: string;
  initialValue: string;
  placeholder?: string;
  meta?: { updatedAt: string; updatedBy: string | null };
}) {
  const { save, status } = useSettingSaver();
  const [draft, setDraft] = useState(initialValue);
  return (
    <div className="space-y-2 rounded-xl border border-paper-edge bg-paper-soft/40 p-4">
      <FieldHeader keyName={keyName} label={label} hint={hint} meta={meta} />
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 rounded-md border border-paper-edge bg-paper px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={() => void save(keyName, draft)}
          className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper transition hover:bg-ink-soft"
        >
          Save
        </button>
      </div>
      <StatusLine entry={status[keyName]} />
    </div>
  );
}

function ColorFieldCard({
  keyName,
  label,
  hint,
  initialValue,
  meta,
}: {
  keyName: SettingKey;
  label: string;
  hint?: string;
  initialValue: string;
  meta?: { updatedAt: string; updatedBy: string | null };
}) {
  const { save, status } = useSettingSaver();
  const [draft, setDraft] = useState(initialValue);
  return (
    <div className="space-y-2 rounded-xl border border-paper-edge bg-paper-soft/40 p-4">
      <FieldHeader keyName={keyName} label={label} hint={hint} meta={meta} />
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-9 w-12 cursor-pointer rounded-md border border-paper-edge bg-paper"
        />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-32 rounded-md border border-paper-edge bg-paper px-2 py-1.5 font-mono text-sm"
        />
        <button
          type="button"
          onClick={() => void save(keyName, draft)}
          className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper transition hover:bg-ink-soft"
        >
          Save
        </button>
      </div>
      <StatusLine entry={status[keyName]} />
    </div>
  );
}

function SelectFieldCard({
  keyName,
  label,
  hint,
  options,
  initialValue,
  meta,
}: {
  keyName: SettingKey;
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
  initialValue: string;
  meta?: { updatedAt: string; updatedBy: string | null };
}) {
  const { save, status } = useSettingSaver();
  const [draft, setDraft] = useState(initialValue);
  return (
    <div className="space-y-2 rounded-xl border border-paper-edge bg-paper-soft/40 p-4">
      <FieldHeader keyName={keyName} label={label} hint={hint} meta={meta} />
      <div className="flex items-center gap-2">
        <select
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="rounded-md border border-paper-edge bg-paper px-2 py-1.5 text-sm"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void save(keyName, draft)}
          className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper transition hover:bg-ink-soft"
        >
          Save
        </button>
      </div>
      <StatusLine entry={status[keyName]} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Features
// ---------------------------------------------------------------------------

function FeaturesSection({
  features,
  meta,
}: {
  features: FeatureFlags;
  meta: MetaMap;
}) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-soft">
        Top-level switches that decide which agent pipelines run. Use the master
        switch to ship a &ldquo;chatbot only&rdquo; bespoke deployment (no URL audit, no
        canvas cards from the audit / strategy / mapping nodes). The two sub-
        switches choose which data engine runs when the audit is enabled.
      </p>
      <BooleanFieldCard
        keyName="feature_audit_enabled"
        label="Audit pipeline (master switch)"
        hint="When OFF, the graph routes Discovery → END. No Audit, Strategy, Solution Mapping, or Output nodes fire. Visitors still get the brand-voice chat replies, but no canvas content from the audit path."
        initialValue={features.auditEnabled}
        meta={meta.feature_audit_enabled}
      />
      <BooleanFieldCard
        keyName="feature_audit_use_psi"
        label="Audit data source: Google PageSpeed Insights"
        hint="When OFF, the worker skips the PSI call and ships Playwright-only audit data. Turning both PSI and Playwright off makes the audit hard-fail with a clear error."
        initialValue={features.auditUsePsi}
        meta={meta.feature_audit_use_psi}
      />
      <BooleanFieldCard
        keyName="feature_audit_use_playwright"
        label="Audit data source: Local Playwright crawl"
        hint="When OFF, the worker skips the Playwright crawl and ships PSI-only audit data. Useful for clients whose target sites are public + score-friendly but block headless browsers."
        initialValue={features.auditUsePlaywright}
        meta={meta.feature_audit_use_playwright}
      />
    </div>
  );
}

function BooleanFieldCard({
  keyName,
  label,
  hint,
  initialValue,
  meta,
}: {
  keyName: SettingKey;
  label: string;
  hint?: string;
  initialValue: boolean;
  meta?: { updatedAt: string; updatedBy: string | null };
}) {
  const { save, status } = useSettingSaver();
  const [draft, setDraft] = useState(initialValue);
  return (
    <div className="space-y-2 rounded-xl border border-paper-edge bg-paper-soft/40 p-4">
      <FieldHeader keyName={keyName} label={label} hint={hint} meta={meta} />
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={draft}
          onClick={() => setDraft((v) => !v)}
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full transition",
            draft ? "bg-ink" : "bg-paper-edge",
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-paper transition",
              draft ? "translate-x-5" : "translate-x-0.5",
            )}
          />
        </button>
        <span className="font-mono text-xs text-ink-soft">
          {draft ? "Enabled" : "Disabled"}
        </span>
        <button
          type="button"
          onClick={() => void save(keyName, draft)}
          className="ml-auto rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper transition hover:bg-ink-soft"
        >
          Save
        </button>
      </div>
      <StatusLine entry={status[keyName]} />
    </div>
  );
}

function PromptCard({
  keyName,
  label,
  hint,
  initialValue,
  meta,
}: {
  keyName: SettingKey;
  label: string;
  hint?: string;
  initialValue: string | null;
  meta?: { updatedAt: string; updatedBy: string | null };
}) {
  const { save, status } = useSettingSaver();
  const [draft, setDraft] = useState(initialValue ?? "");
  const isOverride = (initialValue ?? "").length > 0;
  return (
    <details className="group rounded-xl border border-paper-edge bg-paper-soft/40 p-4">
      <summary className="flex cursor-pointer items-baseline justify-between gap-3 list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[9px] text-ink-muted/60 group-open:rotate-90 inline-block transition"
            aria-hidden="true"
          >
            ▸
          </span>
          <span className="text-sm font-medium text-ink">{label}</span>
          {isOverride ? (
            <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-mono uppercase tracking-widest text-accent">
              override
            </span>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              default
            </span>
          )}
        </div>
        <code className="font-mono text-[10px] text-ink-muted">{keyName}</code>
      </summary>
      <div className="mt-3 space-y-2">
        {hint ? <p className="text-xs text-ink-soft">{hint}</p> : null}
        <MetaLine meta={meta} />
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={14}
          placeholder="(empty — using code default)"
          className="w-full rounded-md border border-paper-edge bg-paper px-2 py-2 font-mono text-xs leading-relaxed"
        />
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setDraft("");
              void save(keyName, "");
            }}
            className="rounded-full border border-paper-edge px-3 py-1 text-[11px] text-ink-soft transition hover:border-ink-muted hover:text-ink"
          >
            Reset to default
          </button>
          <button
            type="button"
            onClick={() => void save(keyName, draft)}
            className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper transition hover:bg-ink-soft"
          >
            Save override
          </button>
        </div>
        <StatusLine entry={status[keyName]} />
      </div>
    </details>
  );
}
