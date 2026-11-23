import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  MetaApiError,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  explainSendFailure,
  extractTemplateBodyParams,
  isOutside24HourWindowError,
  isWithin24HourWindow,
  withTransientRetry,
} from '@/lib/whatsapp/retry-policy';
import { MEDIA_KINDS } from '@/lib/whatsapp/send-message';
import type { InteractiveMessagePayload, MessageTemplate } from '@/types';

/**
 * POST /api/whatsapp/retry
 *
 * Immediately retry a persisted `failed` outbound message without
 * waiting 24 hours and without creating duplicate rows or duplicate sends.
 *
 * Guarantees:
 *  - Atomic status transition (`failed` -> `sending`) prevents two
 *    concurrent Retry clicks from double-sending the same message.
 *  - Enforces WhatsApp's 24-hour customer service window: non-template
 *    messages cannot be retried once the 24-hour window has expired;
 *    returns HTTP 400 with `{ code: 'window_expired' }` so the UI guides
 *    the agent to send an approved template instead.
 *  - Updates the existing `messages` row in place (`sent` + new wamid,
 *    or back to `failed` with updated error metadata).
 */
export async function POST(request: Request) {
  let claimedMessageId: string | null = null;
  let originalErrorFields: {
    error_code: number | null;
    error_title: string | null;
    error_details: string | null;
  } = { error_code: null, error_title: null, error_details: null };

  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json().catch(() => ({}));
    const messageId =
      typeof body?.message_id === 'string' ? body.message_id.trim() : '';

    if (!messageId) {
      return NextResponse.json(
        { error: 'message_id is required' },
        { status: 400 },
      );
    }

    // Load the target message and confirm it belongs to this account.
    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .select('*, conversation:conversations!inner(id, account_id, contact:contacts(*))')
      .eq('id', messageId)
      .eq('conversation.account_id', accountId)
      .maybeSingle();

    if (msgErr || !msg) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (msg.sender_type === 'customer') {
      return NextResponse.json(
        { error: 'Inbound customer messages cannot be retried' },
        { status: 400 },
      );
    }

    if (msg.status !== 'failed') {
      return NextResponse.json(
        {
          error:
            msg.status === 'sending'
              ? 'This message is already retrying'
              : 'Only failed messages can be retried',
          code: 'not_failed',
        },
        { status: 409 },
      );
    }

    originalErrorFields = {
      error_code: msg.error_code ?? null,
      error_title: msg.error_title ?? null,
      error_details: msg.error_details ?? null,
    };

    // Enforce WhatsApp 24-hour customer service window for non-template messages.
    if (msg.content_type !== 'template') {
      if (isOutside24HourWindowError(msg.error_code, msg.error_details ?? msg.error_title)) {
        return NextResponse.json(
          {
            error:
              'The 24-hour customer service window has expired. Send an approved WhatsApp template instead.',
            code: 'window_expired',
          },
          { status: 400 },
        );
      }

      const { data: lastInbound } = await supabase
        .from('messages')
        .select('created_at')
        .eq('conversation_id', msg.conversation_id)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!isWithin24HourWindow(lastInbound?.created_at)) {
        return NextResponse.json(
          {
            error:
              'Outside the 24-hour customer service window. Free-form messages cannot be retried — send an approved WhatsApp template instead.',
            code: 'window_expired',
          },
          { status: 400 },
        );
      }
    }

    // Atomically claim the retry so concurrent requests cannot double-send.
    const { data: claimed, error: claimErr } = await supabase
      .from('messages')
      .update({ status: 'sending' })
      .eq('id', messageId)
      .eq('status', 'failed')
      .select('id')
      .maybeSingle();

    if (claimErr || !claimed) {
      return NextResponse.json(
        {
          error: 'Retry already in progress or message already sent',
          code: 'retry_conflict',
        },
        { status: 409 },
      );
    }
    claimedMessageId = messageId;

    const conv = Array.isArray(msg.conversation)
      ? msg.conversation[0]
      : msg.conversation;
    const contact = Array.isArray(conv?.contact)
      ? conv.contact[0]
      : conv?.contact;

    const resolvedTarget = resolveContactSendTarget(contact);
    if (!resolvedTarget) {
      await supabase
        .from('messages')
        .update({ status: 'failed', ...originalErrorFields })
        .eq('id', messageId);
      claimedMessageId = null;
      return NextResponse.json(
        { error: 'Contact has no valid phone number or WhatsApp user ID' },
        { status: 400 },
      );
    }

    const { data: config, error: configErr } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configErr || !config) {
      await supabase
        .from('messages')
        .update({ status: 'failed', ...originalErrorFields })
        .eq('id', messageId);
      claimedMessageId = null;
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.access_token);

    let contextMessageId: string | undefined;
    if (msg.reply_to_message_id) {
      const { data: parent } = await supabase
        .from('messages')
        .select('message_id')
        .eq('id', msg.reply_to_message_id)
        .eq('conversation_id', msg.conversation_id)
        .maybeSingle();
      if (parent?.message_id) contextMessageId = parent.message_id;
    }

    let templateRow: MessageTemplate | null = null;
    let templateLanguage = 'en_US';
    let templateBodyParams: string[] = [];
    if (msg.content_type === 'template' && msg.template_name) {
      const resolved = await resolveTemplateRow(
        supabase,
        accountId,
        msg.template_name,
        undefined,
      );
      if (resolved.malformed) {
        await supabase
          .from('messages')
          .update({ status: 'failed', ...originalErrorFields })
          .eq('id', messageId);
        claimedMessageId = null;
        return NextResponse.json(
          {
            error:
              'Template row is malformed locally — run "Sync from Meta" in Settings.',
          },
          { status: 500 },
        );
      }
      templateRow = resolved.row;
      templateLanguage = resolved.language;

      if (templateRow) {
        const extracted = extractTemplateBodyParams(
          templateRow.body_text,
          msg.content_text,
        );
        if (extracted === null) {
          await supabase
            .from('messages')
            .update({ status: 'failed', ...originalErrorFields })
            .eq('id', messageId);
          claimedMessageId = null;
          return NextResponse.json(
            {
              error:
                'Template variables could not be auto-filled from the original message — please confirm them in the template picker.',
              code: 'template_params_required',
              template_name: msg.template_name,
            },
            { status: 422 },
          );
        }
        templateBodyParams = extracted;
      }
    }

    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(
      msg.content_type,
    );

    const filenameFromUrl = (url: string): string | undefined => {
      try {
        const seg = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
        return seg || undefined;
      } catch {
        return undefined;
      }
    };

    const attempt = async (target: string): Promise<string> => {
      if (msg.content_type === 'template' && msg.template_name) {
        const headerMediaUrl =
          msg.media_url || templateRow?.header_media_url || undefined;
        const res = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: target,
          templateName: msg.template_name,
          language: templateLanguage,
          template: templateRow ?? undefined,
          params: templateBodyParams,
          messageParams: {
            body: templateBodyParams,
            ...(headerMediaUrl ? { headerMediaUrl } : {}),
            ...(templateRow?.header_type === 'document' && headerMediaUrl
              ? { headerDocumentFilename: filenameFromUrl(headerMediaUrl) }
              : {}),
          },
          contextMessageId,
        });
        return res.messageId;
      }

      if (isMediaKind && msg.media_url) {
        const res = await sendMediaMessage({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: target,
          kind: msg.content_type as MediaKind,
          link: msg.media_url,
          caption:
            msg.content_type === 'audio'
              ? undefined
              : msg.content_text || undefined,
          filename:
            msg.content_type === 'document'
              ? msg.content_text || undefined
              : undefined,
          contextMessageId,
        });
        return res.messageId;
      }

      if (msg.content_type === 'interactive' && msg.interactive_payload) {
        const p = msg.interactive_payload as InteractiveMessagePayload;
        if (p.kind === 'buttons') {
          const res = await sendInteractiveButtons({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: target,
            bodyText: p.body,
            headerText: p.header || undefined,
            footerText: p.footer || undefined,
            buttons: p.buttons,
            contextMessageId,
          });
          return res.messageId;
        }
        const res = await sendInteractiveList({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: target,
          bodyText: p.body,
          buttonLabel: p.button_label,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          sections: p.sections,
          contextMessageId,
        });
        return res.messageId;
      }

      const res = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: target,
        text: msg.content_text || '',
        contextMessageId,
      });
      return res.messageId;
    };

    const variants = resolvedTarget.isPhone
      ? phoneVariants(resolvedTarget.target)
      : [resolvedTarget.target];

    let waMessageId = '';
    let lastError: unknown = null;
    try {
      for (const variant of variants) {
        try {
          waMessageId = await withTransientRetry(() => attempt(variant));
          lastError = null;
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!isRecipientNotAllowedError(errMsg)) {
            throw err;
          }
          lastError = err;
        }
      }
      if (lastError) throw lastError;
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      const metaCode = err instanceof MetaApiError ? err.code : null;
      const metaDetails = err instanceof MetaApiError ? err.details : null;
      const readableError = explainSendFailure(metaCode, errMsg, metaDetails);

      await supabase
        .from('messages')
        .update({
          status: 'failed',
          error_code: metaCode ?? originalErrorFields.error_code,
          error_title: readableError,
          error_details: metaDetails ?? null,
        })
        .eq('id', messageId);
      claimedMessageId = null;

      return NextResponse.json(
        {
          error: readableError,
          meta_code: metaCode,
          code: isOutside24HourWindowError(metaCode, errMsg)
            ? 'window_expired'
            : 'meta_error',
        },
        { status: isOutside24HourWindowError(metaCode, errMsg) ? 400 : 502 },
      );
    }

    // Update the existing row in place (prevents duplicate messages).
    const { error: updateErr } = await supabase
      .from('messages')
      .update({
        status: 'sent',
        message_id: waMessageId,
        error_code: null,
        error_title: null,
        error_details: null,
      })
      .eq('id', messageId);
    claimedMessageId = null;

    if (updateErr) {
      console.error('[whatsapp/retry] failed to update retried row:', updateErr);
      return NextResponse.json(
        { error: `Message resent to Meta, but failed to update DB: ${updateErr.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message_id: messageId,
      whatsapp_message_id: waMessageId,
    });
  } catch (error) {
    if (claimedMessageId) {
      // Best-effort restore so the row doesn't stay stuck in 'sending'.
      try {
        const { supabase } = await requireRole('agent');
        await supabase
          .from('messages')
          .update({ status: 'failed', ...originalErrorFields })
          .eq('id', claimedMessageId);
      } catch {
        // ignore
      }
    }
    console.error('Error in WhatsApp retry POST:', error);
    return toErrorResponse(error);
  }
}
