export { GRAVITAS_LOGO_DATA_URI, GRAVITAS_LOGO_SOURCE_URL, GRAVITAS_LOGO_IS_REAL } from "./logo";
export { GravitasMark } from "./mark";

/**
 * Closing-contact configuration — read from env at module load (server only).
 * The audit report and lead-form chrome use this. Never hard-coded.
 */
export function getClosingContact() {
  return {
    name: process.env.BRANDING_CLOSING_CONTACT_NAME ?? "",
    role: process.env.BRANDING_CLOSING_CONTACT_ROLE ?? "",
    phone: process.env.BRANDING_CLOSING_CONTACT_PHONE ?? "",
    email: process.env.BRANDING_CLOSING_CONTACT_EMAIL ?? "",
  };
}
