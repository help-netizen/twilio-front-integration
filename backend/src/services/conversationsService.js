/**
 * Conversations Service
 * Business logic for Twilio Conversations SMS.
 */
const twilio = require('twilio');
const convQueries = require('../db/conversationsQueries');
const queries = require('../db/queries');
const realtimeService = require('./realtimeService');
const db = require('../db/connection');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const SERVICE_SID = process.env.TWILIO_CONVERSATIONS_SERVICE_SID;

/**
 * Create or find a Twilio Conversation for a customer↔proxy pair.
 */
async function getOrCreateConversation(customerE164, proxyE164, companyId) {
    // Check DB first
    let dbConv = await convQueries.findActiveConversation(customerE164, proxyE164);
    if (dbConv) return dbConv;

    // Create in Twilio
    const twilioConv = await client.conversations.v1
        .services(SERVICE_SID)
        .conversations.create({
            friendlyName: `SMS ${customerE164}`,
            attributes: JSON.stringify({ customerE164, proxyE164 }),
        });

    // Add SMS participant (customer)
    await client.conversations.v1
        .services(SERVICE_SID)
        .conversations(twilioConv.sid)
        .participants.create({
            'messagingBinding.address': customerE164,
            'messagingBinding.proxyAddress': proxyE164,
        });

    // Save to DB
    dbConv = await convQueries.upsertConversation({
        twilio_conversation_sid: twilioConv.sid,
        service_sid: SERVICE_SID,
        customer_e164: customerE164,
        proxy_e164: proxyE164,
        friendly_name: `SMS ${customerE164}`,
        company_id: companyId,
    });

    return dbConv;
}

/**
 * Upload media to Twilio MCS (Media Content Service).
 * Returns the Media SID for attachment to a message.
 */
async function uploadMediaToMCS(buffer, contentType, filename) {
    const url = `https://mcs.us1.twilio.com/v1/Services/${SERVICE_SID}/Media`;

    // Build multipart/form-data manually because Node fetch + form-data streams
    // don't handle boundaries correctly.
    const boundary = '----TwilioMCS' + Date.now();
    const parts = [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="Media"; filename="${filename}"\r\n`,
        `Content-Type: ${contentType}\r\n\r\n`,
    ];
    const header = Buffer.from(parts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(
                `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
            ).toString('base64'),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`MCS upload failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    console.log(`[ConvService] Uploaded media to MCS: ${data.sid} (${contentType}, ${buffer.length} bytes)`);
    return data.sid;
}

/**
 * Send a message in a conversation.
 */
async function sendMessage(conversationId, { body, author = 'agent', mediaSid, fileInfo }) {
    const conv = await convQueries.getConversationById(conversationId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);

    const params = { author };
    if (body) params.body = body;
    if (mediaSid) {
        params.mediaSid = mediaSid;
    }

    const twilioMsg = await client.conversations.v1
        .services(SERVICE_SID)
        .conversations(conv.twilio_conversation_sid)
        .messages.create(params);

    const dbMsg = await convQueries.upsertMessage({
        twilio_message_sid: twilioMsg.sid,
        conversation_id: conv.id,
        conversation_sid: conv.twilio_conversation_sid,
        author,
        author_type: 'agent',
        direction: 'outbound',
        body: body || (fileInfo ? `[${fileInfo.filename}]` : null),
        delivery_status: 'sent',
        date_created_remote: twilioMsg.dateCreated,
        company_id: conv.company_id,
    });

    // Save media record so UI can render it immediately
    if (mediaSid && fileInfo) {
        const mediaRecord = await convQueries.insertMedia({
            message_id: dbMsg.id,
            twilio_media_sid: mediaSid,
            filename: fileInfo.filename,
            content_type: fileInfo.contentType,
            size_bytes: fileInfo.size,
            preview_kind: guessPreviewKind(fileInfo.contentType),
        });
        dbMsg.media = mediaRecord ? [mediaRecord] : [];
    } else {
        dbMsg.media = [];
    }

    await convQueries.updateConversationPreview(conv.id, {
        body: body || '[media]',
        direction: 'outbound',
        timestamp: twilioMsg.dateCreated || new Date().toISOString(),
    });

    // SSE push
    realtimeService.publishMessageAdded(dbMsg, conv);
    const updatedConv = await convQueries.getConversationById(conv.id);
    if (updatedConv) realtimeService.publishConversationUpdate(updatedConv);

    return dbMsg;
}

/**
 * Process Twilio Conversations post-event webhook.
 */
async function processWebhookEvent(eventType, payload) {
    const conversationSid = payload.ConversationSid;
    const messageSid = payload.MessageSid;

    // Record raw event
    const idempotencyKey = `${eventType}:${payload['X-Twilio-Webhook-Enabled'] || ''}:${conversationSid}:${messageSid || ''}:${Date.now()}`;
    const event = await convQueries.insertEvent({
        event_type: eventType,
        idempotency_key: idempotencyKey,
        conversation_sid: conversationSid,
        message_sid: messageSid,
        participant_sid: payload.ParticipantSid,
        payload,
    });

    if (!event) return; // duplicate

    try {
        switch (eventType) {
            case 'onMessageAdded':
                await handleMessageAdded(payload);
                break;
            case 'onDeliveryUpdated':
                await handleDeliveryUpdated(payload);
                break;
            case 'onConversationStateUpdated':
                await handleConversationStateUpdated(payload);
                break;
            default:
                console.log(`[ConvService] Unhandled event: ${eventType}`);
        }
        await convQueries.markEventProcessed(event.id);
    } catch (err) {
        console.error(`[ConvService] Error processing ${eventType}:`, err);
        await convQueries.markEventProcessed(event.id, err.message);
    }
}

async function handleMessageAdded(payload) {
    const conversationSid = payload.ConversationSid;

    // Ensure conversation exists in DB
    let conv = await convQueries.getConversationBySid(conversationSid);
    if (!conv) {
        // Fetch from Twilio
        const twilioConv = await client.conversations.v1
            .services(SERVICE_SID)
            .conversations(conversationSid)
            .fetch();

        const attrs = JSON.parse(twilioConv.attributes || '{}');
        let customerE164 = attrs.customerE164 || null;
        let proxyE164 = attrs.proxyE164 || null;

        // If autocreated by Twilio Address Config — attributes are empty.
        // Fetch participants to determine customer vs proxy.
        if (!customerE164 || !proxyE164) {
            try {
                const participants = await client.conversations.v1
                    .services(SERVICE_SID)
                    .conversations(conversationSid)
                    .participants.list();

                for (const p of participants) {
                    const binding = p.messagingBinding;
                    if (binding) {
                        const addr = binding.address || binding.projected_address;
                        const proxy = binding.proxy_address;
                        if (addr) customerE164 = addr;
                        if (proxy) proxyE164 = proxy;
                    }
                }
                console.log(`[ConvService] Autocreated conv: customer=${customerE164}, proxy=${proxyE164}`);
            } catch (e) {
                console.error('[ConvService] Failed to fetch participants:', e.message);
            }
        }

        conv = await convQueries.upsertConversation({
            twilio_conversation_sid: conversationSid,
            service_sid: SERVICE_SID,
            customer_e164: customerE164,
            proxy_e164: proxyE164,
            friendly_name: customerE164 ? `SMS ${customerE164}` : twilioConv.friendlyName,
        });
    }

    // If conversation still has no customer_e164, try to backfill from participants
    if (!conv.customer_e164 && conv.twilio_conversation_sid) {
        try {
            const participants = await client.conversations.v1
                .services(SERVICE_SID)
                .conversations(conv.twilio_conversation_sid)
                .participants.list();

            let customerE164 = null;
            let proxyE164 = null;
            for (const p of participants) {
                const binding = p.messagingBinding;
                if (binding) {
                    const addr = binding.address || binding.projected_address;
                    const proxy = binding.proxy_address;
                    if (addr) customerE164 = addr;
                    if (proxy) proxyE164 = proxy;
                }
            }
            if (customerE164) {
                conv = await convQueries.upsertConversation({
                    twilio_conversation_sid: conv.twilio_conversation_sid,
                    service_sid: SERVICE_SID,
                    customer_e164: customerE164,
                    proxy_e164: proxyE164 || conv.proxy_e164,
                    friendly_name: `SMS ${customerE164}`,
                    company_id: conv.company_id,
                });
                console.log(`[ConvService] Backfilled conv ${conv.id}: customer=${customerE164}, proxy=${proxyE164}`);
            }
        } catch (e) {
            console.error('[ConvService] Failed to backfill participants:', e.message);
        }
    }

    const author = payload.Author;
    // Direction: if author matches customer phone → inbound, if author is "agent" or matches proxy → outbound
    const isInbound = conv.customer_e164
        ? author === conv.customer_e164
        : (author !== 'agent' && author !== conv.proxy_e164);
    const direction = isInbound ? 'inbound' : 'outbound';

    const msg = await convQueries.upsertMessage({
        twilio_message_sid: payload.MessageSid,
        conversation_id: conv.id,
        conversation_sid: conversationSid,
        author,
        author_type: isInbound ? 'external' : 'agent',
        direction,
        body: payload.Body,
        index_in_conversation: payload.Index ? parseInt(payload.Index) : null,
        date_created_remote: payload.DateCreated,
        company_id: conv.company_id,
    });

    // Handle media — Twilio may not send MediaCount, check Media array directly
    if (payload.Media) {
        try {
            const mediaItems = typeof payload.Media === 'string'
                ? JSON.parse(payload.Media)
                : payload.Media;
            for (const item of mediaItems) {
                await convQueries.insertMedia({
                    message_id: msg.id,
                    twilio_media_sid: item.Sid,
                    filename: item.Filename,
                    content_type: item.ContentType,
                    size_bytes: item.Size,
                    preview_kind: guessPreviewKind(item.ContentType),
                });
                console.log(`[ConvService] Saved media ${item.Sid} for message ${msg.id}`);
            }
        } catch (e) {
            console.error('[ConvService] Failed to parse/save media:', e);
        }
    }

    await convQueries.updateConversationPreview(conv.id, {
        body: payload.Body || '[media]',
        direction,
        timestamp: payload.DateCreated || new Date().toISOString(),
        isInbound,
    });

    // Mark contact unread for inbound SMS
    if (isInbound && conv.customer_e164) {
        try {
            const contact = await queries.findOrCreateContact(conv.customer_e164);
            if (contact) {
                await queries.markContactUnread(contact.id, new Date(payload.DateCreated || Date.now()));
            }
        } catch (e) {
            console.error('[ConvService] Failed to mark contact unread for SMS:', e.message);
        }
    }

    // SSE push
    realtimeService.publishMessageAdded(msg, conv);
    const updatedConv = await convQueries.getConversationById(conv.id);
    if (updatedConv) realtimeService.publishConversationUpdate(updatedConv);
}

async function handleDeliveryUpdated(payload) {
    if (payload.MessageSid) {
        const status = payload.DeliveryStatus || payload.Status;
        const errorCode = payload.ErrorCode ? parseInt(payload.ErrorCode) : null;
        await convQueries.updateDeliveryStatus(
            payload.MessageSid, status, errorCode, payload.ErrorMessage
        );
        realtimeService.publishMessageDelivery(payload.MessageSid, status, errorCode);
    }
}

async function handleConversationStateUpdated(payload) {
    const conv = await convQueries.getConversationBySid(payload.ConversationSid);
    if (conv) {
        await convQueries.updateConversationState(conv.id, payload.StateTo || 'closed');
        const updated = await convQueries.getConversationById(conv.id);
        if (updated) realtimeService.publishConversationUpdate(updated);
    }
}

function guessPreviewKind(contentType) {
    if (!contentType) return 'generic';
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    if (contentType === 'application/pdf') return 'pdf';
    return 'generic';
}

/**
 * Get media temporary URL from Twilio.
 * Fetches the media resource from Conversations API, caches URL for 4 hours.
 */
async function getMediaTemporaryUrl(mediaId, forceRefresh = false) {
    const media = await convQueries.getMediaById(mediaId);
    if (!media) throw new Error(`Media ${mediaId} not found`);

    // Check cache (4-hour TTL) — skip if force refresh
    if (!forceRefresh && media.temporary_url && media.temporary_url_expires_at && new Date(media.temporary_url_expires_at) > new Date()) {
        return { url: media.temporary_url, expiresAt: media.temporary_url_expires_at, contentType: media.content_type };
    }

    // Get the message to find the conversation sid
    const message = await db.query('SELECT conversation_sid, twilio_message_sid FROM sms_messages WHERE id = $1', [media.message_id]);
    if (!message.rows[0]) throw new Error(`Message not found for media ${mediaId}`);

    const { conversation_sid, twilio_message_sid } = message.rows[0];

    // Fetch media list from Twilio Conversations API
    const mediaList = await client.conversations.v1
        .services(SERVICE_SID)
        .conversations(conversation_sid)
        .messages(twilio_message_sid)
        .fetch();

    // Find the matching media URL from the attachedMedia links
    let tempUrl = null;
    if (mediaList.media) {
        const mediaItems = typeof mediaList.media === 'string' ? JSON.parse(mediaList.media) : mediaList.media;
        for (const item of mediaItems) {
            if (item.sid === media.twilio_media_sid || item.Sid === media.twilio_media_sid) {
                tempUrl = item.url || item.temporary_url;
                break;
            }
        }
    }

    // If not found from message.media, try direct fetch via MCS (Media Content Service)
    if (!tempUrl) {
        try {
            // Twilio MCS URL pattern for Conversations media
            const url = `https://mcs.us1.twilio.com/v1/Services/${SERVICE_SID}/Media/${media.twilio_media_sid}`;
            const response = await fetch(url, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
                },
                redirect: 'manual',
            });
            const mcsData = await response.json();
            if (mcsData.links && mcsData.links.content_direct_temporary) {
                tempUrl = mcsData.links.content_direct_temporary;
            } else if (mcsData.url) {
                tempUrl = mcsData.url;
            }
        } catch (e) {
            console.error('[ConvService] MCS fetch failed:', e.message);
        }
    }

    if (!tempUrl) throw new Error(`Could not get media URL for ${media.twilio_media_sid}`);

    // Cache for 4 hours
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    await db.query(
        'UPDATE sms_media SET temporary_url = $2, temporary_url_expires_at = $3, updated_at = now() WHERE id = $1',
        [mediaId, tempUrl, expiresAt]
    );

    return { url: tempUrl, expiresAt, contentType: media.content_type };
}

module.exports = {
    getOrCreateConversation,
    sendMessage,
    uploadMediaToMCS,
    processWebhookEvent,
    getMediaTemporaryUrl,
};
