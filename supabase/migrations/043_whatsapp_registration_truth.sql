-- ============================================================
-- whatsapp_config: record Meta's authoritative connection state,
-- and gate "Campaign Ready" on checks that actually passed.
--
-- Why this exists
-- ---------------
--   Migration 015 added `registered_at`, intending it as "is this
--   number live on Meta". It cannot answer that. It only records
--   whether *wacrm itself* ever ran POST /{phone_number_id}/register,
--   so a number onboarded through Embedded Signup, registered by
--   another tool, or saved before 015 existed reads as unregistered
--   forever.
--
--   POST /api/whatsapp/config trusted that NULL and attempted
--   /register on every first save, passing whatever sat in the PIN
--   box. On a number with no two-step verification PIN, Meta compares
--   that value against nothing and answers
--
--       (#133005) Two-step verification PIN mismatch
--
--   which the route stored as `last_registration_error` and then wrote
--   status='disconnected' over a channel that was, on Meta's side,
--   CONNECTED on CLOUD_API and sending fine.
--
--   The columns below hold what Meta actually says, read from the
--   phone-number node (`status`, `platform_type`, `is_pin_enabled`),
--   so no code has to guess again. See
--   src/lib/whatsapp/registration-state.ts.
--
-- Campaign readiness
-- ------------------
--   `campaign_ready_at` is stamped only by the verification endpoint,
--   and only when every check passed: credentials valid, Meta reports
--   the number registered, the WABA is subscribed to THIS app (by app
--   id, not "the list is non-empty"), at least one APPROVED template
--   exists, an outbound template actually delivered, and an inbound
--   event actually arrived. `campaign_ready_blockers` keeps the
--   reasons it is not ready so the UI can list them.
--
-- Nothing is dropped, renamed or backfilled destructively. Every
-- column is nullable and additive; existing rows keep their values,
-- including `registered_at`, which stays as the historical record of
-- wacrm-initiated registrations.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  -- Meta's `status` on the phone-number node: CONNECTED, PENDING, …
  ADD COLUMN IF NOT EXISTS meta_status TEXT,
  -- Meta's `platform_type`: CLOUD_API, ON_PREMISE, NOT_APPLICABLE.
  ADD COLUMN IF NOT EXISTS meta_platform_type TEXT,
  -- Meta's `is_pin_enabled`. NULL = Meta did not say. FALSE = there is
  -- no two-step PIN on this number, so /register must omit the
  -- parameter (the 2026 PIN-deprecation cohort behaves this way).
  ADD COLUMN IF NOT EXISTS meta_pin_enabled BOOLEAN,
  -- Meta's `last_onboarded_time` — when the number actually became
  -- live on the Cloud API, regardless of who registered it.
  ADD COLUMN IF NOT EXISTS meta_onboarded_at TIMESTAMPTZ,
  -- The Meta app id the stored access token belongs to, recovered via
  -- /debug_token. Lets the subscription check match by id instead of
  -- assuming a non-empty subscriber list means "us".
  ADD COLUMN IF NOT EXISTS meta_app_id TEXT,
  -- Last time the verification endpoint completed a full read.
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
  -- Proof of real outbound delivery: the wamid and when Meta accepted
  -- and then confirmed it.
  ADD COLUMN IF NOT EXISTS last_outbound_test_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_outbound_test_wamid TEXT,
  ADD COLUMN IF NOT EXISTS last_outbound_test_status TEXT,
  -- Proof of real inbound delivery: set by the webhook on every
  -- inbound message, so "Meta is delivering events" is an observation
  -- rather than an assumption.
  ADD COLUMN IF NOT EXISTS last_inbound_event_at TIMESTAMPTZ,
  -- Stamped only when every readiness check passed. NULL = not ready.
  ADD COLUMN IF NOT EXISTS campaign_ready_at TIMESTAMPTZ,
  -- Why it is not ready, newest run wins. JSONB array of strings.
  ADD COLUMN IF NOT EXISTS campaign_ready_blockers JSONB;

COMMENT ON COLUMN whatsapp_config.registered_at IS
  'Historical: when wacrm last ran POST /{phone_number_id}/register successfully. '
  'NOT a reliable "is the number live" signal — a number registered elsewhere has '
  'this NULL while being fully live. Read meta_status + meta_platform_type for that.';

COMMENT ON COLUMN whatsapp_config.meta_pin_enabled IS
  'Meta is_pin_enabled. FALSE means no two-step verification PIN exists on the '
  'number, so POST /register must omit the pin parameter; sending one yields '
  'error 133005. TRUE means a PIN is required. NULL means Meta did not report it.';

COMMENT ON COLUMN whatsapp_config.campaign_ready_at IS
  'Set only by GET /api/whatsapp/config/verify-registration, and only when every '
  'check passed. Never set by Save Configuration.';

-- Finding the numbers that are configured but not yet campaign-ready.
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_campaign_ready
  ON whatsapp_config (campaign_ready_at)
  WHERE campaign_ready_at IS NULL;
