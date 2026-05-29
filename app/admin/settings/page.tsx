import {
  getBrandingConfig,
  getEmbedConfig,
  getKbConfig,
  getAgentPrompts,
  getFeatureFlags,
} from "@/server/runtime-config";
import { listSettings } from "@/server/settings";
import { SettingsTabs } from "./settings-tabs";

/**
 * /admin/settings — bespoke deployment control panel.
 *
 * Every value here is hot-tunable from the UI (writes to system_settings,
 * cached for 60s, propagates to the agent + embed + KB ingest without a
 * redeploy). Five sections:
 *
 *   Rate limits     — per-IP turn + audit caps; "Reset today's quota" helper.
 *   Branding        — brand name + named contact (substituted into prompts
 *                     as {{brand_name}}, {{contact_name}}, etc.).
 *   Embed widget    — launcher text + colours + position + dimensions for
 *                     the /embed.js floating chat.
 *   Knowledge base  — sitemap URL + optional whitelist of path prefixes
 *                     to restrict the KB ingest.
 *   Agent prompts   — full system prompts for every agent node. Unset =
 *                     code defaults; saved = override. Supports {{var}}
 *                     placeholders for branding values.
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Load every section's current effective values in parallel — server
  // component, single render, no client fetches.
  const [branding, embed, kb, prompts, features, rawSettings] = await Promise.all([
    getBrandingConfig(),
    getEmbedConfig(),
    getKbConfig(),
    getAgentPrompts(),
    getFeatureFlags(),
    listSettings(),
  ]);

  // Build a lookup of stored-value metadata (updatedAt, updatedBy) keyed
  // by setting key — used to show "last changed by X at Y" hints in the
  // form. Values from runtime-config helpers are already effective values
  // (override OR fallback) so we don't read from rawSettings for those.
  const metaByKey = new Map(rawSettings.map((r) => [r.key, r]));

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">Settings</h1>
        <p className="text-sm text-ink-soft">
          Runtime configuration. Every change takes effect within ~60 seconds of
          saving — no redeploy. Empty / unset values fall back to the code defaults.
        </p>
      </header>

      <SettingsTabs
        branding={branding}
        embed={embed}
        kb={kb}
        prompts={prompts}
        features={features}
        disclaimerSaved={
          (rawSettings.find((r) => r.key === "ui_disclaimer_text")?.value as
            | string
            | undefined) ?? ""
        }
        // rate-limit values come from the unified listSettings call
        rateLimits={{
          turnLimit:
            (rawSettings.find((r) => r.key === "ip_daily_turn_limit")?.value as
              | number
              | undefined) ?? 20,
          auditLimit:
            (rawSettings.find((r) => r.key === "ip_daily_audit_limit")?.value as
              | number
              | undefined) ?? 3,
        }}
        meta={Object.fromEntries(
          Array.from(metaByKey.entries()).map(([k, v]) => [
            k,
            { updatedAt: v.updatedAt, updatedBy: v.updatedBy },
          ]),
        )}
      />
    </div>
  );
}
