import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { normalizeKey } from '@/lib/contacts/dedupe';

/**
 * POST /api/whatsapp/conversations
 *
 * Open (find-or-create) an individual 1-to-1 WhatsApp conversation for
 * either an existing CRM contact (`contact_id`) or a brand-new contact
 * (`phone`, optional `name` / `email` / `company`).
 *
 * Does NOT send any WhatsApp message on its own — it prepares the
 * thread so the agent can view history, inspect the 24-hour session
 * status, and initiate the conversation with an approved template (or
 * free-form text/PDF if an inbound 24h window is already active).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const body = await request.json().catch(() => ({}));

    const contactIdInput =
      typeof body?.contact_id === 'string' ? body.contact_id.trim() : '';
    const phoneInput =
      typeof body?.phone === 'string' ? body.phone.trim() : '';
    const nameInput =
      typeof body?.name === 'string' ? body.name.trim() : '';
    const emailInput =
      typeof body?.email === 'string' ? body.email.trim() : '';
    const companyInput =
      typeof body?.company === 'string' ? body.company.trim() : '';

    if (!contactIdInput && !phoneInput) {
      return NextResponse.json(
        { error: 'Either contact_id or phone is required' },
        { status: 400 },
      );
    }

    let contactId = contactIdInput;

    if (contactId) {
      const { data: existingContact, error } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contactId)
        .eq('account_id', accountId)
        .maybeSingle();

      if (error || !existingContact) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 },
        );
      }
    } else {
      // Validate international phone (+countrycode...) so Meta can deliver.
      const parsed = parseInternationalPhone(phoneInput);
      if (!parsed) {
        return NextResponse.json(
          {
            error:
              'Please enter a valid international phone number starting with + and country code (e.g. +919876543210)',
          },
          { status: 400 },
        );
      }

      const normalized = normalizeKey(phoneInput);
      const { data: existingByPhone } = await supabase
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone_normalized', normalized)
        .maybeSingle();

      if (existingByPhone) {
        contactId = existingByPhone.id;
      } else {
        const { data: createdContact, error: createContactErr } = await supabase
          .from('contacts')
          .insert({
            account_id: accountId,
            user_id: userId,
            phone: phoneInput,
            name: nameInput || null,
            email: emailInput || null,
            company: companyInput || null,
          })
          .select('id')
          .single();

        if (createContactErr || !createdContact) {
          console.error(
            '[whatsapp/conversations] contact insert failed:',
            createContactErr?.message,
          );
          return NextResponse.json(
            { error: 'Failed to create contact' },
            { status: 500 },
          );
        }
        contactId = createdContact.id;
      }
    }

    // Find existing conversation for this contact, or create one.
    let conversationId: string | null = null;
    let created = false;

    const { data: existingConv } = await supabase
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle();

    if (existingConv) {
      conversationId = existingConv.id;
    } else {
      const { data: newConv, error: createConvErr } = await supabase
        .from('conversations')
        .insert({
          account_id: accountId,
          user_id: userId,
          contact_id: contactId,
        })
        .select('id')
        .single();

      if (createConvErr || !newConv) {
        // Handle race where a concurrent request created it first.
        const { data: raced } = await supabase
          .from('conversations')
          .select('id')
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .maybeSingle();
        if (!raced) {
          console.error(
            '[whatsapp/conversations] conversation insert failed:',
            createConvErr?.message,
          );
          return NextResponse.json(
            { error: 'Failed to open conversation' },
            { status: 500 },
          );
        }
        conversationId = raced.id;
      } else {
        conversationId = newConv.id;
        created = true;
      }
    }

    const { data: hydrated, error: hydrateErr } = await supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('id', conversationId)
      .single();

    if (hydrateErr || !hydrated) {
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      created,
      conversation: normalizeConversation(hydrated),
    });
  } catch (error) {
    console.error('Error in WhatsApp conversations POST:', error);
    return toErrorResponse(error);
  }
}
