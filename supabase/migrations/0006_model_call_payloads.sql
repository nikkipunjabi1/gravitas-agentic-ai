-- 0006_model_call_payloads.sql
--
-- Capture the actual request + response of every model_call so admins can
-- inspect "what did this Claude turn actually see?" / "what did PSI
-- return?" from /admin/sessions/<id>/flow.
--
-- Two new JSONB columns on model_calls:
--   request_payload   { provider-specific snapshot of the input }
--   response_payload  { provider-specific snapshot of the output }
--
-- For Anthropic + Ollama: request stores { system, messages, options };
--   response stores { text, tokens } (no raw bytes — text is the useful
--   bit; full streaming chunks would explode storage).
-- For Google PSI: request stores { url, strategy }; response stores
--   { perfScore, a11yScore, lighthouseVersion, fetchTime }.
-- For Playwright: request stores { url }; response stores { wordCount,
--   headings, h1Count, structuredDataTypes }.
--
-- Storage: JSONB is queryable, indexable, compact for typical sizes.
-- Average Claude payload ~5–15 KB; PSI ~0.5 KB; Playwright ~1 KB. At
-- 100 sessions/day × 5 calls = 500 rows/day × 8 KB avg = 4 MB/day — well
-- within Supabase free-tier limits.
--
-- Retention: the existing cron-driven retention job in
-- app/api/cron/retention/route.ts deletes model_calls older than the
-- configured horizon, so payloads inherit that lifecycle.

alter table public.model_calls
  add column if not exists request_payload  jsonb,
  add column if not exists response_payload jsonb;

-- No index on the payload columns — admins query model_calls by
-- session_id (existing index) and don't search across payload contents.
-- If that changes we'd add a GIN index here.

comment on column public.model_calls.request_payload is
  'JSONB snapshot of the request handed to the provider. Provider-shape; see src/lib/models/router.ts + worker/src/call-log.ts.';
comment on column public.model_calls.response_payload is
  'JSONB snapshot of the response from the provider. Provider-shape; text-only for Claude/Ollama, score-summary for PSI, structural metrics for Playwright.';
