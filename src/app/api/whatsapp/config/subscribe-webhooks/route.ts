import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getAppIdFromToken,
  getSubscribedApps,
  subscribeWabaToApp,
} from '@/lib/whatsapp/meta-api'
import { explainMetaError, metaErrorPayload } from '@/lib/whatsapp/meta-error-explain'
import { appSubscriptionState } from '@/lib/whatsapp/waba-pairing'
import { writeConfigRow } from '@/lib/whatsapp/config-columns'

/**
 * POST /api/whatsapp/config/subscribe-webhooks  —  "Subscribe Webhooks"
 *
 * Subscribes the WhatsApp Business Account to this Meta app, so Meta
 * delivers inbound messages and status updates to wacrm's webhook.
 * Split out of Save Configuration: it is idempotent on Meta's side, but
 * it is still a mutation and belongs behind its own button.
 *
 * Afterwards it re-reads `GET /{waba_id}/subscribed_apps` and reports
 * which app ids are actually subscribed, matching OUR app by id rather
 * than assuming a non-empty list means us. A WABA commonly carries
 * several subscribers (a BSP console alongside your own app), and every
 * one of them receives the same events — worth seeing rather than
 * guessing at.
 *
 * Never unsubscribes anything, including other apps.
 */
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, waba_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    return NextResponse.json(
      { error: 'No WhatsApp configuration saved yet. Save the credentials first.' },
      { status: 400 },
    )
  }
  if (!config.waba_id) {
    return NextResponse.json(
      {
        error:
          'No WhatsApp Business Account ID on file — Meta cannot deliver webhooks without it. ' +
          'Add it in the form above and save, then subscribe.',
        field: 'waba_id',
      },
      { status: 400 },
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json(
      {
        error:
          'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. ' +
          'Re-enter the token and save, then try again.',
      },
      { status: 400 },
    )
  }

  const metaCtx = { phoneNumberId: config.phone_number_id, wabaId: config.waba_id }

  try {
    await subscribeWabaToApp({ wabaId: config.waba_id, accessToken })
  } catch (err) {
    const explained = explainMetaError(err, 'subscribe_waba', metaCtx)
    console.error('[whatsapp/config/subscribe-webhooks] failed:', explained.metaMessage)
    return NextResponse.json(
      { error: explained.summary, meta: metaErrorPayload(explained) },
      { status: explained.httpStatus },
    )
  }

  // Confirm it took effect rather than trusting the 200.
  let subscribedAppIds: string[] = []
  let appIdMatch: boolean | null = null
  let appId: string | null = null
  let readbackError: string | null = null
  try {
    const identity = await getAppIdFromToken({ accessToken })
    appId = identity?.appId ?? process.env.META_APP_ID ?? null
    const subs = await getSubscribedApps({ wabaId: config.waba_id, accessToken })
    subscribedAppIds = subs
      .map((s) => s.whatsapp_business_api_data?.id)
      .filter((id): id is string => typeof id === 'string')
    appIdMatch = appSubscriptionState(subs, appId).appIdMatch
  } catch (err) {
    readbackError = explainMetaError(err, 'subscribed_apps', metaCtx).summary
  }

  const nowIso = new Date().toISOString()
  const { migrationPending } = await writeConfigRow({
    supabase,
    accountId,
    row: {
      subscribed_apps_at: nowIso,
      meta_app_id: appId,
      updated_at: nowIso,
    },
  })

  return NextResponse.json({
    success: true,
    subscribed_apps_at: nowIso,
    app_id: appId,
    app_id_match: appIdMatch,
    subscribed_app_ids: subscribedAppIds,
    // More than one subscriber is legal and often intentional, but it
    // means another system receives the same inbound events.
    other_subscribed_app_ids: subscribedAppIds.filter((id) => id !== appId),
    readback_error: readbackError,
    migration_pending: migrationPending,
  })
}
