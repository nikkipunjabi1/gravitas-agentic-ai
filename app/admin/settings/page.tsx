import { listSettings } from "@/server/settings";
import { SettingsForm } from "./settings-form";

/**
 * /admin/settings — runtime knobs.
 *
 * Reads the canonical setting rows server-side (so the form always boots
 * with the live values) and hands them to a small client form for editing.
 * Mutations go through /api/admin/settings → setSetting(), which validates
 * + persists. A "Reset today's quota" affordance is also wired here for
 * demo unblocking.
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await listSettings();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">Settings</h1>
        <p className="text-sm text-ink-soft">
          Runtime knobs that take effect within ~60 seconds of saving. No redeploy required.
        </p>
      </header>

      <SettingsForm settings={settings} />
    </div>
  );
}
