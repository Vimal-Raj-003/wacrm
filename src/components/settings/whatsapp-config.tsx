'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

// Meta ids are decimal digit strings — mirrors the server-side check in
// POST /api/whatsapp/config so the obvious paste mistakes get a named
// field before a round-trip.
const META_ID_RE = /^\d+$/;

// `meta` object the config route attaches to every failed Meta call
// (issue #505): what a user quotes to Meta support.
type MetaErrorMeta = {
  code: number | null;
  subcode: number | null;
  fbtrace_id: string | null;
  step: string;
  field?: string | null;
  message?: string | null;
};
type MetaFailure = { message: string; meta: MetaErrorMeta | null };
type WabaSubscription = {
  checked: boolean;
  subscribed: boolean | null;
  app_id_match: boolean | null;
  app_id?: string | null;
  subscribed_app_ids?: string[];
  error?: string;
};

/**
 * Meta's own verdict on the number, returned by every config endpoint.
 * `pin_requirement` is what decides whether the PIN box is shown at
 * all: `not_set` means Meta reports no two-step verification PIN on the
 * number (never enabled, or in Meta's 2026 PIN-deprecation cohort), and
 * sending one is what produced "The two-step verification PIN is wrong"
 * on a number that was already live.
 */
type RegistrationInfo = {
  registered: boolean;
  registration_required?: boolean;
  pin_requirement: 'required' | 'not_set' | 'unknown';
  pin_deprecation_eligible?: boolean;
  summary: string;
  blockers?: string[];
};

type CheckState = 'pass' | 'fail' | 'unknown';

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const {
    user,
    accountId,
    loading: authLoading,
    profileLoading,
    canEditSettings,
  } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Structured details of the last failed Meta call (health check or
  // save) — rendered as small muted text under the actionable message.
  const [statusMeta, setStatusMeta] = useState<MetaErrorMeta | null>(null);
  const [saveFailure, setSaveFailure] = useState<MetaFailure | null>(null);
  const [wabaSubscription, setWabaSubscription] = useState<WabaSubscription | null>(null);
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again and overwrites whatever the user typed but hadn't saved yet.
  const loadedAccountIdRef = useRef<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // Inbound-media mirror (issue #466). Unlike everything else on this
  // page it is NOT part of handleSave: that path insists on re-entering
  // the access token so it can re-verify with Meta, which is a silly
  // toll to pay for flipping a boolean. The switch writes straight to
  // the row instead — RLS (migration 017) restricts whatsapp_config
  // UPDATE to admins, hence the canEditSettings gate below; without it
  // a viewer's toggle would match zero rows and appear to work.
  const [mirrorMedia, setMirrorMedia] = useState(true);
  const [savingMirror, setSavingMirror] = useState(false);

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    campaign_ready?: boolean;
    campaign_ready_checks?: Record<string, CheckState>;
    campaign_ready_blockers?: string[];
    checks: Record<string, boolean | null>;
    errors?: string[];
    registration?: RegistrationInfo | null;
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
    migration_pending?: boolean;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  // Meta's registration verdict, refreshed by every action. Drives both
  // the Register Number button's availability and whether a PIN box is
  // shown — a PIN is never asked for unless Meta says one exists.
  const [registration, setRegistration] = useState<RegistrationInfo | null>(null);

  // The three mutating actions, each with its own in-flight flag so one
  // spinner can't imply another action is running.
  const [registering, setRegistering] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);

  // Send Test Template inputs.
  const [testRecipient, setTestRecipient] = useState('');
  const [testTemplate, setTestTemplate] = useState('');
  const [approvedTemplates, setApprovedTemplates] = useState<
    { name: string; language?: string; category?: string }[]
  >([]);

  // True when the API wrote the row but migration 043 is not applied, so
  // the registration-state columns were dropped. Shown as a banner
  // rather than silently reporting state that was never stored.
  const [migrationPending, setMigrationPending] = useState(false);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  /**
   * Load the APPROVED templates Meta will let this WABA send. Defined
   * before `fetchConfig` because it appears in that callback's
   * dependency array, which is evaluated at render time.
   */
  const loadApprovedTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/config/test-template', { method: 'GET' });
      const data = await res.json();
      const list = (data.templates ?? []) as { name: string; language?: string }[];
      setApprovedTemplates(list);
      setTestTemplate((current) => current || list[0]?.name || '');
    } catch (err) {
      console.error('could not load approved templates:', err);
    }
  }, []);

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      // Load form values from Supabase (shows what's in DB).
      // Switched from `user_id` (which would only match the row's
      // original author) to `account_id` so every member of the
      // account sees the same saved configuration. UNIQUE(account_id)
      // on the table guarantees the .maybeSingle() return type
      // remains accurate.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      if (data) {
        setConfig(data);
        setPhoneNumberId(data.phone_number_id || '');
        setWabaId(data.waba_id || '');
        setAccessToken(MASKED_TOKEN);
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
        // Undefined on a row read before migration 039 — treat that as
        // on, matching the webhook's own default.
        setMirrorMedia(data.mirror_inbound_media !== false);
      } else {
        setConfig(null);
        setPhoneNumberId('');
        setWabaId('');
        setAccessToken('');
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
        setMirrorMedia(true);
      }
      // Clear any stale probe result when reloading the row.
      setRegistrationProbe(null);

      // Then verify health via the API (decrypts token + pings Meta)
      if (data) {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
            setStatusMeta(null);
            setWabaSubscription(payload.waba_subscription ?? null);
            // Meta's own verdict on registration, read in the same call.
            setRegistration(payload.registration ?? null);
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
            setStatusMessage(payload.message || '');
            setStatusMeta(payload.meta ?? null);
            setWabaSubscription(null);
            setRegistration(null);
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
        void loadApprovedTemplates();
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
        setStatusMeta(null);
        setWabaSubscription(null);
        setRegistration(null);
        setApprovedTemplates([]);
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [supabase, t, loadApprovedTemplates]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleToggleMirrorMedia(next: boolean) {
    if (!config || !accountId || savingMirror) return;
    // Optimistic — the switch should feel instant; a failure rolls it
    // back rather than leaving the UI ahead of the row.
    const previous = mirrorMedia;
    setMirrorMedia(next);
    setSavingMirror(true);
    try {
      const { error } = await supabase
        .from('whatsapp_config')
        .update({ mirror_inbound_media: next })
        .eq('account_id', accountId);
      if (error) throw new Error(error.message);
      setConfig({ ...config, mirror_inbound_media: next });
    } catch (error) {
      console.error('Failed to update media retention setting:', error);
      setMirrorMedia(previous);
      toast.error(t('mirrorInboundSaveFailed'));
    } finally {
      setSavingMirror(false);
    }
  }

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error(t('phoneNumberIdRequired'));
      return;
    }
    if (!META_ID_RE.test(phoneNumberId.trim())) {
      toast.error(t('phoneNumberIdNotNumeric'));
      return;
    }
    if (wabaId.trim() && !META_ID_RE.test(wabaId.trim())) {
      toast.error(t('wabaIdNotNumeric'));
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error(t('accessTokenRequired'));
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      // No PIN here, deliberately. Saving credentials is a save — it no
      // longer attempts POST /{phone_number_id}/register, so there is
      // nothing for a PIN to be used for. Registration is its own
      // action, and it asks for a PIN only when Meta reports one exists.
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        toast.error(t('reenterAccessToken'));
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        // The route names the failing step and which field to check
        // (issue #505). Keep the details on screen — a toast is too
        // short-lived to copy a trace id out of.
        setSaveFailure({
          message: data.error || t('saveFailed'),
          meta: data.meta ?? null,
        });
        toast.error(data.error || t('saveFailed'), { duration: 10000 });
        setSaving(false);
        return;
      }
      setSaveFailure(null);
      setMigrationPending(Boolean(data.migration_pending));

      // The route saves and reports; it no longer registers or
      // subscribes, so a save can never fail because of a PIN and can
      // never flip a working channel to 'disconnected'.
      if (data.registration) {
        setRegistration(data.registration as RegistrationInfo);
      }
      toast.success(
        data.phone_info?.verified_name
          ? t('savedWithName', { name: data.phone_info.verified_name })
          : t('savedGeneric'),
      );

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        setStatusMeta(null);
        setWabaSubscription(payload.waba_subscription ?? null);
        toast.success(
          payload.phone_info?.verified_name
            ? t('connectedTo', { name: payload.phone_info.verified_name })
            : t('apiConnectionOk')
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        setStatusMeta(payload.meta ?? null);
        setWabaSubscription(null);
        toast.error(payload.message || t('apiConnectionFailed'), { duration: 10000 });
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error(t('connectionTestFailed'));
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      setMigrationPending(Boolean(data.migration_pending));
      if (data.registration) setRegistration(data.registration);
      if (data.campaign_ready) {
        toast.success(t('campaignReadyToast'));
      } else if (data.live) {
        toast.success(t('fullyWired'));
      } else {
        toast.error(
          t('notFullyRegistered'),
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error(t('verifyEndpointUnreachable'));
    } finally {
      setVerifyingRegistration(false);
    }
  }

  /**
   * "Register Number". The server reads Meta's state first and makes no
   * call at all when the number is already live, so this is safe to
   * click on a working production number. A PIN is only sent when Meta
   * reports two-step verification is actually enabled.
   */
  async function handleRegisterNumber() {
    setRegistering(true);
    try {
      const res = await fetch('/api/whatsapp/config/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin.trim() || null }),
      });
      const data = await res.json();
      setMigrationPending(Boolean(data.migration_pending));

      if (!res.ok) {
        setSaveFailure({ message: data.error || t('registerFailed'), meta: data.meta ?? null });
        toast.error(data.error || t('registerFailed'), { duration: 12000 });
        return;
      }
      setSaveFailure(null);
      if (data.registration) setRegistration(data.registration as RegistrationInfo);

      if (data.called_register === false) {
        // Nothing was touched — Meta already had it registered.
        toast.success(t('alreadyRegisteredToast'), { duration: 9000 });
      } else if (data.registration?.registered) {
        toast.success(t('registerSucceeded'), { duration: 9000 });
      } else {
        toast.success(t('registerAcceptedNotLiveYet'), { duration: 10000 });
      }
      setPin('');
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('register failed:', err);
      toast.error(t('registerFailed'));
    } finally {
      setRegistering(false);
    }
  }

  /** "Subscribe Webhooks" — POST /{waba_id}/subscribed_apps, explicitly. */
  async function handleSubscribeWebhooks() {
    setSubscribing(true);
    try {
      const res = await fetch('/api/whatsapp/config/subscribe-webhooks', {
        method: 'POST',
      });
      const data = await res.json();
      setMigrationPending(Boolean(data.migration_pending));

      if (!res.ok) {
        setSaveFailure({ message: data.error || t('subscribeFailed'), meta: data.meta ?? null });
        toast.error(data.error || t('subscribeFailed'), { duration: 12000 });
        return;
      }
      setSaveFailure(null);
      const others: string[] = data.other_subscribed_app_ids ?? [];
      if (others.length > 0) {
        // Legal and often intentional, but every subscriber gets the
        // same inbound events — worth saying out loud.
        toast.success(
          t('subscribedWithOthers', { count: others.length, ids: others.join(', ') }),
          { duration: 12000 },
        );
      } else {
        toast.success(t('subscribeSucceeded'));
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('subscribe-webhooks failed:', err);
      toast.error(t('subscribeFailed'));
    } finally {
      setSubscribing(false);
    }
  }

  /**
   * "Send Test Template" — delivers one approved template to a number
   * the operator types, so Campaign Ready rests on an observed delivery
   * rather than on the API having returned 200.
   */
  async function handleSendTestTemplate() {
    if (!testRecipient.trim()) {
      toast.error(t('testRecipientRequired'));
      return;
    }
    if (!testTemplate) {
      toast.error(t('testTemplateRequired'));
      return;
    }
    setSendingTest(true);
    try {
      const chosen = approvedTemplates.find((x) => x.name === testTemplate);
      const res = await fetch('/api/whatsapp/config/test-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: testRecipient.trim(),
          template_name: testTemplate,
          language: chosen?.language,
        }),
      });
      const data = await res.json();
      setMigrationPending(Boolean(data.migration_pending));

      if (!res.ok) {
        setSaveFailure({ message: data.error || t('testSendFailed'), meta: data.meta ?? null });
        toast.error(data.error || t('testSendFailed'), { duration: 12000 });
        return;
      }
      setSaveFailure(null);
      toast.success(t('testSendAccepted', { wamid: data.wamid }), { duration: 12000 });
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('test-template failed:', err);
      toast.error(t('testSendFailed'));
    } finally {
      setSendingTest(false);
    }
  }

  async function handleReset() {
    if (!confirm(t('resetConfirm'))) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('resetFailed'));
        return;
      }

      toast.success(t('resetDone'));
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
      setStatusMeta(null);
      setSaveFailure(null);
      setWabaSubscription(null);
    } catch (err) {
      console.error('Reset error:', err);
      toast.error(t('resetFailed'));
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success(t('webhookCopied'));
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t("title")}
          description={t("description")}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  // Registration is whatever Meta says, with the local timestamp only
  // as a fallback for a row saved before this screen read Meta's state.
  // The local column alone was the original bug: it records whether
  // wacrm ever ran /register, not whether the number is live.
  const metaRegistered =
    registration?.registered ?? Boolean(config?.registered_at);

  // Campaign Ready comes only from a verification run that passed every
  // check, or from the stamp such a run left on the row. Never derived
  // from "credentials are valid".
  const isCampaignReady =
    registrationProbe?.campaign_ready ??
    Boolean((config as { campaign_ready_at?: string | null } | null)?.campaign_ready_at);

  // Only ask for a PIN when Meta says one exists. `not_set` means there
  // is nothing to type, and typing something is what produced error
  // 133005 on an already-registered number.
  const pinNeeded = registration?.pin_requirement === 'required';
  const pinUnknown = registration?.pin_requirement === 'unknown' || !registration;

  // Step + code + trace id in small muted text, so a user can quote
  // them to Meta support (issue #505). The step names are wire values
  // from the route, shown verbatim.
  const renderMetaDetails = (meta: MetaErrorMeta) => (
    <div className="mt-2 space-y-0.5 text-[11px] leading-relaxed text-muted-foreground break-all">
      <p>
        {t('metaErrorStep')}: <code>{meta.step}</code>
        {meta.code !== null && meta.code !== undefined && (
          <>
            {' · '}
            {t('metaErrorCode')}:{' '}
            <code>
              {meta.code}
              {meta.subcode !== null && meta.subcode !== undefined ? `/${meta.subcode}` : ''}
            </code>
          </>
        )}
        {meta.fbtrace_id && (
          <>
            {' · '}
            {t('metaErrorTrace')}: <code>{meta.fbtrace_id}</code>
          </>
        )}
      </p>
      {meta.message && (
        <p>
          {t('metaErrorMessage')}: {meta.message}
        </p>
      )}
      <p>{t('metaErrorDetailsHint')}</p>
    </div>
  );

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  {t('tokenCorrupted')}
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('resetting')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('resetConfig')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Last save failed — why, which field, and what to quote to Meta */}
        {saveFailure && (
          <Alert className="bg-red-950/30 border-red-700/50">
            <div className="flex items-start gap-3">
              <XCircle className="size-5 text-red-400 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <AlertTitle className="text-red-200 mb-1">{t('lastSaveFailed')}</AlertTitle>
                <AlertDescription className="text-red-100/80 text-sm">
                  {saveFailure.message}
                </AlertDescription>
                {saveFailure.meta && renderMetaDetails(saveFailure.meta)}
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected' ? t('credentialsValid') : t('notConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? t('connectedDesc')
              : statusMessage ||
                t('notConnectedDesc')}
          </AlertDescription>
          {connectionStatus === 'connected' && wabaSubscription?.checked && (
            <p
              className={
                'mt-1 text-xs ' +
                (wabaSubscription.subscribed === false
                  ? 'text-amber-300'
                  : 'text-muted-foreground')
              }
            >
              {wabaSubscription.subscribed === false
                ? t('wabaNotSubscribed')
                : wabaSubscription.subscribed === true
                  ? t('wabaSubscribed')
                  : wabaSubscription.error}
            </p>
          )}
          {connectionStatus !== 'connected' && statusMeta && renderMetaDetails(statusMeta)}
        </Alert>

        {/* Migration 043 not applied — the API had to drop the columns
            that hold Meta's reported state, so say so rather than
            report state that was never stored. */}
        {migrationPending && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">{t('migrationPendingTitle')}</AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {t('migrationPendingDesc')}
                </AlertDescription>
              </div>
            </div>
          </Alert>
        )}

        {/* Channel status — three independent dimensions, because any
            one of them can be the reason nothing works:
              1. credentials valid      (the banner above)
              2. registered on Meta     (Meta's platform_type + status)
              3. webhooks subscribed    (our app id in subscribed_apps)
            Campaign Ready is the conjunction of all of them plus an
            observed delivery in each direction. It is never inferred
            from a green "connected" banner. */}
        {config && (
          <Alert
            className={
              isCampaignReady
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : metaRegistered
                  ? 'bg-sky-950/30 border-sky-700/50'
                  : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isCampaignReady ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : metaRegistered ? (
                  <CheckCircle2 className="size-4 text-sky-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' +
                    (isCampaignReady
                      ? 'text-emerald-200'
                      : metaRegistered
                        ? 'text-sky-200'
                        : 'text-amber-200')
                  }
                >
                  {isCampaignReady
                    ? t('campaignReady')
                    : metaRegistered
                      ? t('registeredNotCampaignReady')
                      : t('notRegistered')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('verifyConnection')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {/* Meta's own words about the number, which is what the
                  decision was actually made from. */}
              {registration?.summary
                ? registration.summary
                : metaRegistered
                  ? t('subscribedSince', {
                      date: config.registered_at
                        ? new Date(config.registered_at).toLocaleString()
                        : t('unknownDate'),
                    }).replace(/<[^>]+>/g, '')
                  : lastRegistrationError
                    ? `${t('lastAttemptFailed')}"${lastRegistrationError}"`
                    : t('noRegistrationHint')}
            </AlertDescription>

            {/* Meta reports no two-step PIN on this number. Saying so
                explicitly is the whole point: it is why the old PIN box
                could never produce anything but "the PIN is wrong". */}
            {registration?.pin_requirement === 'not_set' && (
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {t('pinNotSetOnNumber')}
              </p>
            )}

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  {t('diagnosticLastRun')}
                  <span
                    className={
                      registrationProbe.campaign_ready
                        ? 'text-emerald-400'
                        : registrationProbe.live
                          ? 'text-sky-400'
                          : 'text-amber-400'
                    }
                  >
                    {registrationProbe.campaign_ready
                      ? t('campaignReady')
                      : registrationProbe.live
                        ? t('live')
                        : t('notLive')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(
                    registrationProbe.campaign_ready_checks ?? registrationProbe.checks,
                  ).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true || v === 'pass' ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false || v === 'fail' ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.campaign_ready_blockers ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-amber-300">
                    {registrationProbe.campaign_ready_blockers?.map((b, i) => (
                      <li key={i}>• {b}</li>
                    ))}
                  </ul>
                )}
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('apiCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('apiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('phoneNumberId')}</Label>
              <Input
                placeholder={t('phoneNumberIdPlaceholder')}
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('wabaId')}</Label>
              <Input
                placeholder={t('wabaIdPlaceholder')}
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  {t('tokenHidden')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookVerifyToken')}</Label>
              <Input
                placeholder={t('webhookVerifyTokenPlaceholder')}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('webhookVerifyTokenHint')}
              </p>
            </div>

          </CardContent>
        </Card>

        {/* Channel actions — each Meta mutation behind its own button.
            Save Configuration used to do all of this implicitly, which
            is how a routine credential save ended up attempting a
            registration it did not need and could not succeed at. */}
        {config && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('channelActionsTitle')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('channelActionsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* --- Register Number --- */}
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-sm font-medium text-foreground">{t('registerNumber')}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {metaRegistered ? t('registerNotNeeded') : t('registerNeeded')}
                </p>

                {/* The PIN box only exists when Meta reports a PIN on
                    the number. Otherwise there is nothing to enter. */}
                {(pinNeeded || pinUnknown) && !metaRegistered && (
                  <div className="space-y-1.5 pt-1">
                    <Label className="text-muted-foreground text-xs">
                      {t('twoStepPin')}
                      {pinUnknown && (
                        <span className="ml-1 text-muted-foreground">{t('optional')}</span>
                      )}
                    </Label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder={t('pinPlaceholder')}
                      value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
                    />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {pinNeeded ? t('pinRequiredHint') : t('pinUnknownHint')}
                    </p>
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRegisterNumber}
                  disabled={registering || !canEditSettings}
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  {registering ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('registering')}
                    </>
                  ) : (
                    t('registerNumber')
                  )}
                </Button>
              </div>

              {/* --- Subscribe Webhooks --- */}
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-sm font-medium text-foreground">{t('subscribeWebhooks')}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t('subscribeWebhooksDesc')}
                </p>
                {wabaSubscription?.subscribed_app_ids &&
                  wabaSubscription.subscribed_app_ids.length > 0 && (
                    <p className="text-[11px] text-muted-foreground break-all">
                      {t('subscribedAppIds')}:{' '}
                      <code>{wabaSubscription.subscribed_app_ids.join(', ')}</code>
                      {wabaSubscription.app_id && (
                        <>
                          {' · '}
                          {t('thisApp')}: <code>{wabaSubscription.app_id}</code>
                        </>
                      )}
                    </p>
                  )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSubscribeWebhooks}
                  disabled={subscribing || !canEditSettings || !wabaId.trim()}
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  {subscribing ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('subscribing')}
                    </>
                  ) : (
                    t('subscribeWebhooks')
                  )}
                </Button>
              </div>

              {/* --- Send Test Template --- */}
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-sm font-medium text-foreground">{t('sendTestTemplate')}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t('sendTestTemplateDesc')}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('testRecipient')}</Label>
                    <Input
                      placeholder={t('testRecipientPlaceholder')}
                      value={testRecipient}
                      onChange={(e) => setTestRecipient(e.target.value)}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('testTemplate')}</Label>
                    <select
                      value={testTemplate}
                      onChange={(e) => setTestTemplate(e.target.value)}
                      className="h-9 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
                    >
                      {approvedTemplates.length === 0 && (
                        <option value="">{t('noApprovedTemplates')}</option>
                      )}
                      {approvedTemplates.map((tpl) => (
                        <option key={`${tpl.name}:${tpl.language}`} value={tpl.name}>
                          {tpl.name}
                          {tpl.language ? ` (${tpl.language})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSendTestTemplate}
                  disabled={
                    sendingTest || !canEditSettings || approvedTemplates.length === 0
                  }
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  {sendingTest ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('sendingTest')}
                    </>
                  ) : (
                    t('sendTestTemplate')
                  )}
                </Button>
                {config.last_outbound_test_wamid && (
                  <p className="text-[11px] text-muted-foreground break-all">
                    {t('lastTestSend')}: <code>{config.last_outbound_test_wamid}</code> —{' '}
                    {config.last_outbound_test_status ?? 'accepted'}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Webhook URL */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('webhookTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhookDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Attachment retention. Only meaningful once a number is
            connected, since it governs what the webhook does with
            inbound media. */}
        {config && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('mediaTitle')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('mediaDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('mirrorInbound')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('mirrorInboundDesc')}
                  </p>
                  {!mirrorMedia && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                      {t('mirrorInboundOffWarning')}
                    </p>
                  )}
                </div>
                <Switch
                  checked={mirrorMedia}
                  onCheckedChange={handleToggleMirrorMedia}
                  disabled={savingMirror || !canEditSettings}
                  aria-label={t('mirrorInbound')}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveConfig')
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('testing')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('testConnection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('setupInstructions')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('setupInstructionsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    {t('step1')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                    <li>{t('step1_2')}</li>
                    <li>{t('step1_3')}</li>
                    <li>{t('step1_4')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    {t('step2')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step2_1')}</li>
                    <li>{t('step2_2')}</li>
                    <li>{t('step2_3')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    {t('step3')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step3_1')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step3_2') }} />
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step3_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step3_4') }} />
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    {t('step4')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step4_1')}</li>
                    <li>{t('step4_2')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step4_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step4_4') }} />
                    <li>{t('step4_5')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('metaDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
    </section>
  );
}
