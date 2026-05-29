import { promises as fs } from "node:fs";
import path from "node:path";
import { getEmbedConfig } from "@/server/runtime-config";

/**
 * GET /embed.js — dynamic embed-widget loader.
 *
 * Was a static file in /public; lifted into a route handler so admins
 * can change the launcher text + colours + dimensions from
 * /admin/settings/branding without a redeploy.
 *
 * Pattern:
 *   1. Load the static template from /public/embed.js.template
 *      (the same widget code that's lived here since P1.9).
 *   2. Prepend a tiny IIFE that seeds `window.GravitasCopilot` with the
 *      admin-defined defaults. Page-level overrides (set by GTM before
 *      the script tag) still win — Object.assign merges in priority
 *      order: admin defaults first, page overrides on top.
 *   3. Serve as text/javascript with a short cache so admin changes
 *      propagate within ~60s.
 *
 * Why prepend rather than substitute placeholders: the template file
 * stays valid JS, the route handler is a one-line injection, and the
 * dev-mode static file (still accessible via `/embed.js.template` for
 * inspection) doesn't drift.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let cachedTemplate: string | null = null;

async function loadTemplate(): Promise<string> {
  if (cachedTemplate !== null) return cachedTemplate;
  const filePath = path.join(process.cwd(), "public", "embed.js.template");
  cachedTemplate = await fs.readFile(filePath, "utf8");
  return cachedTemplate;
}

export async function GET() {
  const [embed, template] = await Promise.all([getEmbedConfig(), loadTemplate()]);

  // Build the admin-defaults IIFE. JSON.stringify handles quoting safely.
  const adminDefaults = JSON.stringify({
    position: embed.position,
    primaryColor: embed.primaryColor,
    textColor: embed.textColor,
    launcherText: embed.launcherText,
    width: embed.width,
    height: embed.height,
  });

  // Priority: admin-saved values ALWAYS win over page-level overrides.
  //
  // Rationale: the entire point of P1.16 is admin-as-source-of-truth for
  // bespoke deployments. If GTM-injected GravitasCopilot were allowed to
  // override admin (the previous merge order), the admin Settings UI
  // would look like it worked but produce no visible change on sites
  // whose GTM tag still has an inline config block — which is exactly
  // the failure mode we hit on initial rollout.
  //
  // Page-level config still functions as a FALLBACK for any key admin
  // hasn't set — but in practice getEmbedConfig() always returns a full
  // record (hardcoded defaults fill any unset key), so page-level
  // overrides become effectively no-ops. That's intentional. If a
  // per-page override is needed in future, route it through a different
  // mechanism (query string, data attribute) rather than re-flipping
  // this priority.
  const prelude =
    "/* Gravitas Co-Pilot — admin-injected defaults (P1.16) */\n" +
    "(function(){var admin=" +
    adminDefaults +
    ";var page=window.GravitasCopilot||{};window.GravitasCopilot=Object.assign({},page,admin);})();\n";

  return new Response(prelude + template, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // 60s cache so admin colour/text changes propagate quickly without
      // hammering this endpoint on every page load of the parent site.
      "Cache-Control": "public, max-age=60, s-maxage=60",
    },
  });
}
