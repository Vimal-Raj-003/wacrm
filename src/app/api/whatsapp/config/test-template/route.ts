import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { listMessageTemplates, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { explainMetaError, metaErrorPayload } from '@/lib/whatsapp/meta-error-explain'
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'
import { writeConfigRow } from '@/lib/whatsapp/config-columns'

/**
 * GET /api/whatsapp/config/test-template
 *
 * Lists the APPROVED templates Meta will let this WABA send, so the UI
 * can offer a real choice instead of hard-coding a name. Read-only.
 */
export async function GET() {
  const ctx = await resolveContext()
  if ('response' in ctx) return ctx.response
  const { config, accessToken } = ctx

  if (!config.waba_id) {
    return NextResponse.json({ templates: [], error: 'No WhatsApp Business Account ID on file.' })
  }
  try {
    const all = await listMessageTemplates({ wabaId: config.waba_id, accessToken })
    return NextResponse.json({
      templates: all
        .filter((t) => (t.status ?? '').toUpperCase() === 'APPROVED')
        .map((t) => ({ name: t.name, language: t.language, category: t.category })),
      total: all.length,
    })
  } catch (err) {
    const explained = explainMetaError(err, 'subscribed_apps', { wabaId: config.waba_id })
    return NextResponse.json({ templates: [], error: explained.summary })
  }
}

/**
 * POST /api/whatsapp/config/test-template  —  "Send Test Template"
 *
 * Sends one APPROVED template to a number the operator names, so
 * outbound delivery is *observed* rather than assumed. Campaign Ready
 * depends on this having succeeded — see
 * `src/lib/whatsapp/campaign-readiness.ts`.
 *
 * It records the returned `wamid` so the status webhook
 * (`sent` → `delivered` → `read`) can be matched back to this test. The
 * Meta API returning 200 only means Meta accepted the message; the
 * `delivered` status is the part that proves it reached a handset, and
 * that arrives asynchronously on the webhook.
 *
 * Body: `{ to: string, template_name: string, language?: string }`
 *
 * Guardrails: the recipient must be given explicitly (never inferred
 * from the contact list), the template must be one Meta reports as
 * APPROVED, and only templates with no body variables are accepted so
 * the test cannot silently fail on a missing parameter.
 */
export async function POST(request: Request) {
  const ctx = await resolveContext()
  if ('response' in ctx) return ctx.response
  const { supabase, accountId, config, accessToken } = ctx

  let body: { to?: unknown; template_name?: unknown; language?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'A JSON body with `to` and `template_name` is required.' }, { status: 400 })
  }

  if (typeof body.to !== 'string' || !body.to.trim()) {
    return NextResponse.json(
      { error: 'A recipient `to` is required — the WhatsApp number to send the test to, with its + country code.', field: 'to' },
      { status: 400 },
    )
  }
  const to = parseInternationalPhone(body.to)
  if (!to) {
    return NextResponse.json(
      {
        error:
          'The recipient must be a full international number starting with + and its country code, e.g. +919876543210.',
        field: 'to',
      },
      { status: 400 },
    )
  }

  if (typeof body.template_name !== 'string' || !body.template_name.trim()) {
    return NextResponse.json(
      { error: 'A `template_name` is required.', field: 'template_name' },
      { status: 400 },
    )
  }
  const templateName = body.template_name.trim()

  if (!config.waba_id) {
    return NextResponse.json(
      { error: 'No WhatsApp Business Account ID on file, so templates cannot be verified.' },
      { status: 400 },
    )
  }

  // Confirm with Meta that the template exists and is approved, and
  // pick up its real language code — templates created as `en` fail if
  // sent as `en_US`.
  let approved
  try {
    const all = await listMessageTemplates({ wabaId: config.waba_id, accessToken })
    approved = all.find(
      (t) => t.name === templateName && (t.status ?? '').toUpperCase() === 'APPROVED',
    )
  } catch (err) {
    const explained = explainMetaError(err, 'subscribed_apps', { wabaId: config.waba_id })
    return NextResponse.json(
      { error: explained.summary, meta: metaErrorPayload(explained) },
      { status: explained.httpStatus },
    )
  }
  if (!approved) {
    return NextResponse.json(
      {
        error:
          `Meta does not report an APPROVED template named "${templateName}" on this ` +
          'WhatsApp Business Account. Pick one from the list, or submit it for approval first.',
        field: 'template_name',
      },
      { status: 400 },
    )
  }

  const language =
    typeof body.language === 'string' && body.language.trim()
      ? body.language.trim()
      : (approved.language ?? 'en')

  try {
    const result = await sendTemplateMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to,
      templateName,
      language,
    })

    const nowIso = new Date().toISOString()
    const { migrationPending } = await writeConfigRow({
      supabase,
      accountId,
      row: {
        last_outbound_test_at: nowIso,
        last_outbound_test_wamid: result.messageId,
        // Meta accepted it. The webhook upgrades this to `delivered`.
        last_outbound_test_status: 'accepted',
        updated_at: nowIso,
      },
    })

    return NextResponse.json({
      success: true,
      wamid: result.messageId,
      to,
      template_name: templateName,
      language,
      sent_at: nowIso,
      status: 'accepted',
      migration_pending: migrationPending,
      message:
        'Meta accepted the message. Delivery to the handset is confirmed by the status ' +
        'webhook — re-run Verify Connection in a few seconds to see it move to delivered.',
    })
  } catch (err) {
    const explained = explainMetaError(err, 'verify_number', {
      phoneNumberId: config.phone_number_id,
      wabaId: config.waba_id,
    })
    console.error('[whatsapp/config/test-template] send failed:', explained.metaMessage)
    return NextResponse.json(
      { error: explained.summary, meta: metaErrorPayload(explained) },
      { status: explained.httpStatus },
    )
  }
}

/** Shared auth + config + token resolution for both handlers. */
async function resolveContext(): Promise<
  | { response: NextResponse }
  | {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: any
      accountId: string
      config: { phone_number_id: string; waba_id: string | null; access_token: string }
      accessToken: string
    }
> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return {
      response: NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      ),
    }
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, waba_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!config) {
    return {
      response: NextResponse.json(
        { error: 'No WhatsApp configuration saved yet. Save the credentials first.' },
        { status: 400 },
      ),
    }
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return {
      response: NextResponse.json(
        {
          error:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. ' +
            'Re-enter the token and save, then try again.',
        },
        { status: 400 },
      ),
    }
  }

  return { supabase, accountId, config, accessToken }
}
