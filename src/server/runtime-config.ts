import "server-only";
import { getSetting } from "./settings";

/**
 * Runtime-config façade.
 *
 * Wraps the raw `getSetting()` reads with typed accessors AND the
 * hardcoded fallback values that ship in the code. The fallback is what
 * runs when:
 *
 *   - Supabase isn't configured (dev clones)
 *   - The setting row hasn't been created in the admin UI yet
 *   - The setting was reset to null
 *
 * Adding a new admin-tunable knob is two steps:
 *   1. Add the key to SETTING_KEYS in settings.ts
 *   2. Add a helper here with the hardcoded fallback the code shipped with
 *
 * Every helper caches via the underlying getSetting cache (60s TTL).
 */

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

export interface BrandingConfig {
  brandName: string;
  contactName: string;
  contactRole: string;
  contactEmail: string;
  contactPhone: string;
}

export async function getBrandingConfig(): Promise<BrandingConfig> {
  const [brandName, contactName, contactRole, contactEmail, contactPhone] = await Promise.all([
    getSetting("branding_brand_name", process.env.BRANDING_BRAND_NAME ?? "Gravitas"),
    getSetting(
      "branding_contact_name",
      process.env.BRANDING_CLOSING_CONTACT_NAME ?? "Kieran O'Sullivan",
    ),
    getSetting(
      "branding_contact_role",
      process.env.BRANDING_CLOSING_CONTACT_ROLE ?? "Managing Director",
    ),
    getSetting(
      "branding_contact_email",
      process.env.BRANDING_CLOSING_CONTACT_EMAIL ?? "kieran.osullivan@thisisgravitas.com",
    ),
    getSetting(
      "branding_contact_phone",
      process.env.BRANDING_CLOSING_CONTACT_PHONE ?? "",
    ),
  ]);
  return { brandName, contactName, contactRole, contactEmail, contactPhone };
}

// ---------------------------------------------------------------------------
// Embed widget
// ---------------------------------------------------------------------------

export interface EmbedConfig {
  launcherText: string;
  primaryColor: string;
  textColor: string;
  position: "bottom-right" | "bottom-left";
  width: number;
  height: number;
}

export async function getEmbedConfig(): Promise<EmbedConfig> {
  const [launcherText, primaryColor, textColor, position, width, height] = await Promise.all([
    getSetting("embed_launcher_text", "Talk to the Co-Pilot"),
    getSetting("embed_primary_color", "#0B0B0F"),
    getSetting("embed_text_color", "#FAFAF7"),
    getSetting<"bottom-right" | "bottom-left">("embed_position", "bottom-right"),
    getSetting("embed_width", 420),
    getSetting("embed_height", 640),
  ]);
  return { launcherText, primaryColor, textColor, position, width, height };
}

// ---------------------------------------------------------------------------
// KB ingest
// ---------------------------------------------------------------------------

export interface KbConfig {
  sitemapUrl: string;
  whitelistPatterns: string[];
}

const KB_FALLBACK_WHITELIST: string[] = [];

export async function getKbConfig(): Promise<KbConfig> {
  const [sitemapUrl, whitelistPatterns] = await Promise.all([
    getSetting("kb_sitemap_url", process.env.KB_SITEMAP_URL ?? "https://thisisgravitas.com/sitemap.xml"),
    getSetting<string[]>("kb_whitelist_patterns", KB_FALLBACK_WHITELIST),
  ]);
  return { sitemapUrl, whitelistPatterns };
}

// ---------------------------------------------------------------------------
// Agent prompts
// ---------------------------------------------------------------------------

export interface AgentPrompts {
  discoveryVoiceBase: string | null;
  discoveryProblem: string | null;
  discoveryKbGrounded: string | null;
  discoveryKbEmpty: string | null;
  discoveryMeta: string | null;
  discoveryOfftopic: string | null;
  auditNarration: string | null;
  strategyJson: string | null;
  strategyNarration: string | null;
  outputClose: string | null;
}

/**
 * Each prompt defaults to null — agent nodes treat null as "use the
 * hardcoded value baked into the node." This makes admin opt-in: the
 * admin saves a value to override; otherwise the production code path is
 * unchanged.
 *
 * Interpolation placeholders supported in stored prompts (substituted at
 * runtime by interpolatePrompt below):
 *
 *   {{brand_name}}       — branding.brand_name
 *   {{contact_name}}     — branding.contact_name
 *   {{contact_role}}     — branding.contact_role
 *   {{contact_email}}    — branding.contact_email
 *   {{contact_phone}}    — branding.contact_phone
 */
export async function getAgentPrompts(): Promise<AgentPrompts> {
  const [
    discoveryVoiceBase,
    discoveryProblem,
    discoveryKbGrounded,
    discoveryKbEmpty,
    discoveryMeta,
    discoveryOfftopic,
    auditNarration,
    strategyJson,
    strategyNarration,
    outputClose,
  ] = await Promise.all([
    getSetting<string | null>("prompt_discovery_voice_base", null),
    getSetting<string | null>("prompt_discovery_problem", null),
    getSetting<string | null>("prompt_discovery_kb_grounded", null),
    getSetting<string | null>("prompt_discovery_kb_empty", null),
    getSetting<string | null>("prompt_discovery_meta", null),
    getSetting<string | null>("prompt_discovery_offtopic", null),
    getSetting<string | null>("prompt_audit_narration", null),
    getSetting<string | null>("prompt_strategy_json", null),
    getSetting<string | null>("prompt_strategy_narration", null),
    getSetting<string | null>("prompt_output_close", null),
  ]);
  return {
    discoveryVoiceBase,
    discoveryProblem,
    discoveryKbGrounded,
    discoveryKbEmpty,
    discoveryMeta,
    discoveryOfftopic,
    auditNarration,
    strategyJson,
    strategyNarration,
    outputClose,
  };
}

/**
 * Substitute {{var}} placeholders with current branding values.
 */
export function interpolatePrompt(
  template: string,
  branding: BrandingConfig,
): string {
  return template
    .replace(/\{\{\s*brand_name\s*\}\}/g, branding.brandName)
    .replace(/\{\{\s*contact_name\s*\}\}/g, branding.contactName)
    .replace(/\{\{\s*contact_role\s*\}\}/g, branding.contactRole)
    .replace(/\{\{\s*contact_email\s*\}\}/g, branding.contactEmail)
    .replace(/\{\{\s*contact_phone\s*\}\}/g, branding.contactPhone);
}

/**
 * Resolve a prompt: if the admin has saved an override, interpolate
 * branding into it; otherwise return null so the caller uses its
 * hardcoded fallback.
 */
export function resolvePrompt(
  override: string | null,
  branding: BrandingConfig,
): string | null {
  if (!override) return null;
  return interpolatePrompt(override, branding);
}
