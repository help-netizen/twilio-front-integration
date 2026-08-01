/**
 * Conversations Service
 * Business logic for Twilio Conversations SMS.
 */
const { getTwilioClient } = require('./twilioClient');
const convQueries = require('../db/conversationsQueries');
const queries = require('../db/queries');
const realtimeService = require('./realtimeService');
const db = require('../db/connection');
const { toE164 } = require('../utils/phoneUtils');
const eventBus = require('./eventBus');

// Lazy proxy: every `client.x.y` access first resolves the shared singleton.
const client = new Proxy({}, {
    get(_t, prop) {
        return getTwilioClient()[prop];
    },
});
const SERVICE_SID = process.env.TWILIO_CONVERSATIONS_SERVICE_SID;

function requireCompanyId(companyId) {
    if (!companyId) {
        const err = new Error('companyId is required');
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
    }
    return companyId;
}

function unresolvedWebhookTenant(reference) {
    const err = new Error(`Unable to resolve SMS tenant for ${reference}`);
    err.code = 'SMS_TENANT_UNRESOLVED';
    return err;
}

async function resolveCompanyIdForProxy(proxyE164) {
    const normalizedProxy = toE164(proxyE164) || proxyE164;
    if (!normalizedProxy) return null;
    const { rows } = await db.query(
        `SELECT company_id
         FROM phone_number_settings
         WHERE phone_number = $1
         LIMIT 1`,
        [normalizedProxy]
    );
    return rows[0]?.company_id || null;
}

async function getPersistedWebhookConversation(conversationSid) {
    const companyId = await convQueries.resolveCompanyByConversationSid(conversationSid);
    if (!companyId) return null;
    return convQueries.getConversationBySid(conversationSid, companyId);
}

/**
 * Create or find a Twilio Conversation for a customer↔proxy pair.
 */
async function getOrCreateConversation(customerE164, proxyE164, companyId) {
    requireCompanyId(companyId);
    // Normalize phones to E.164 (defense-in-depth)
    customerE164 = toE164(customerE164) || customerE164;
    proxyE164 = toE164(proxyE164) || proxyE164;
    // Check DB first
    let dbConv = await convQueries.findActiveConversation(customerE164, proxyE164, companyId);
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
    if (!dbConv) throw new Error('Conversation belongs to another company');

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
async function sendMessage(conversationId, { companyId, body, author = 'agent', mediaSid, fileInfo }) {
    requireCompanyId(companyId);
    const conv = await convQueries.getConversationById(conversationId, companyId);
    if (!conv) throw new Error(`Conversation ${conversationId} not found`);

    // Wallet gate: block outbound SMS when the balance is at/below the grace floor.
    await require('./walletService').assertServiceActive(conv.company_id);

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
            company_id: companyId,
        });
        dbMsg.media = mediaRecord ? [mediaRecord] : [];
    } else {
        dbMsg.media = [];
    }

    await convQueries.updateConversationPreview(conv.id, companyId, {
        body: body || '[media]',
        direction: 'outbound',
        timestamp: twilioMsg.dateCreated || new Date().toISOString(),
    });

    // EMAIL-UNREAD-002: an outbound SMS reply marks the whole timeline read
    // (same owner rule as email replies). Resolution mirrors the inbound path:
    // phone → contact (no create) → timeline (upsert-safe). Non-blocking.
    if (conv.customer_e164 && conv.company_id) {
        try {
            const contact = await queries.findContactByPhoneOrSecondary(conv.customer_e164, conv.company_id);
            const timeline = await queries.findOrCreateTimeline(conv.customer_e164, conv.company_id);
            if (timeline && timeline.id) {
                const { markReadAfterReply } = require('./replyReadService');
                await markReadAfterReply(conv.company_id, {
                    timelineId: timeline.id,
                    contactId: contact ? contact.id : null,
                    replyAt: twilioMsg.dateCreated || null,
                });
            }
        } catch (e) {
            console.warn('[ConvService] reply-read after outbound SMS failed:', e.message);
        }
    }

    // SSE push
    realtimeService.publishMessageAdded(dbMsg, conv);
    const updatedConv = await convQueries.getConversationById(conv.id, companyId);
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
    let conv = await getPersistedWebhookConversation(conversationSid);
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

        const companyId = await resolveCompanyIdForProxy(proxyE164);
        if (!companyId) {
            throw unresolvedWebhookTenant(`proxy ${proxyE164 || 'missing'}`);
        }

        conv = await convQueries.upsertConversation({
            twilio_conversation_sid: conversationSid,
            service_sid: SERVICE_SID,
            customer_e164: customerE164,
            proxy_e164: proxyE164,
            friendly_name: customerE164 ? `SMS ${customerE164}` : twilioConv.friendlyName,
            company_id: companyId,
        });
        if (!conv) throw unresolvedWebhookTenant(`conversation ${conversationSid}`);
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
                    company_id: conv.company_id,
                });
                console.log(`[ConvService] Saved media ${item.Sid} for message ${msg.id}`);
            }
        } catch (e) {
            console.error('[ConvService] Failed to parse/save media:', e);
        }
    }

    await convQueries.updateConversationPreview(conv.id, conv.company_id, {
        body: payload.Body || '[media]',
        direction,
        timestamp: payload.DateCreated || new Date().toISOString(),
        isInbound,
    });

    // LIST-PAGINATION-001: guarantee every SMS conversation has a timeline at
    // INGEST time (inbound AND outbound). The Pulse sidebar query is now purely
    // read-only and no longer auto-creates timelines for SMS-only threads, so
    // the write must happen here or SMS-only conversations would never surface.
    // Idempotent (findOrCreateTimeline is upsert-safe); non-blocking.
    if (conv.customer_e164 && conv.company_id) {
        try {
            await queries.findOrCreateTimeline(conv.customer_e164, conv.company_id);
        } catch (e) {
            console.warn('[ConvService] SMS timeline ensure failed for', conv.customer_e164, e.message);
        }
    }

    // Mark contact unread for inbound SMS (if contact exists — do NOT create)
    if (isInbound && conv.customer_e164) {
        try {
            const contact = await queries.findContactByPhoneOrSecondary(conv.customer_e164, conv.company_id);
            if (contact) {
                await queries.markContactUnread(contact.id, new Date(payload.DateCreated || Date.now()));
            }
        } catch (e) {
            console.error('[ConvService] Failed to mark contact unread for SMS:', e.message);
        }

        // Typed, PII-safe event; message detail is fetched only after authorization.
        try {
            eventBus.emit(conv.company_id, 'sms.inbound', {
                message_id: msg.id,
                conversation_id: conv.id,
                contact_id: conv.contact_id || null,
                record_refs: [{ type: 'sms_message', id: msg.id }],
            }, {
                actorType: 'webhook',
                aggregateType: 'sms_message',
                aggregateId: msg.id,
                idempotencyKey: `sms.inbound:${payload.MessageSid || msg.id}`,
            }).catch(() => {});
        } catch (e) { /* non-blocking */ }

        // Legacy hardcoded AR path — superseded by rules engine when
        // FEATURE_RULES_ENGINE_AR is on (the seeded rule handles it).
        if (process.env.FEATURE_RULES_ENGINE_AR === 'true') { /* handled by rules engine */ } else
        // Action Required auto-trigger: check per-company settings before firing
        try {
            const { getTriggerConfig } = require('./arConfigHelper');
            const companyId = conv.company_id;
            const triggerCfg = await getTriggerConfig(companyId, 'inbound_sms');

            if (triggerCfg.enabled) {
                const timeline = await queries.findOrCreateTimeline(conv.customer_e164, conv.company_id);
                if (timeline && timeline.id) {
                    // Mark timeline unread too
                    await queries.markTimelineUnread(timeline.id);

                    // Set action_required (clears any snooze)
                    await queries.setActionRequired(timeline.id, 'new_message', 'system');

                    // Create task if configured
                    if (triggerCfg.create_task) {
                        const contactName = await (async () => {
                            const c = await queries.findContactByPhoneOrSecondary(conv.customer_e164, conv.company_id);
                            return c?.full_name || conv.customer_e164;
                        })();
                        const slaMs = (triggerCfg.task_sla_minutes || 10) * 60 * 1000;
                        const dueAt = new Date(Date.now() + slaMs).toISOString();
                        await queries.createTask({
                            companyId: conv.company_id || timeline.company_id,
                            threadId: timeline.id,
                            subjectType: 'contact',
                            subjectId: timeline.contact_id,
                            title: `New message from ${contactName}`,
                            priority: triggerCfg.task_priority || 'p1',
                            dueAt,
                            createdBy: 'system',
                        });
                    }

                    // SSE broadcast
                    realtimeService.broadcast('thread.action_required', {
                        company_id: conv.company_id || timeline.company_id,
                    });
                    console.log(`[ConvService] Action Required set on timeline ${timeline.id} for inbound SMS from ${conv.customer_e164}`);
                }
            }
        } catch (e) {
            console.error('[ConvService] Failed to set action_required for inbound SMS:', e.message);
        }
    }

    // Preserve the existing SSE deep link. Browser/native notification delivery
    // now comes only from the scoped sms.inbound event subscriber.
    let timelineId = null;
    if (isInbound && conv.company_id) {
        try {
            const timeline = await queries.findOrCreateTimeline(conv.customer_e164, conv.company_id);
            timelineId = timeline?.id || null;
        } catch (e) {
            console.error('[ConvService] Timeline deep-link resolution failed:', e.message);
        }
    }

    // SSE push (include timelineId for deep-linking)
    realtimeService.publishMessageAdded(msg, conv, timelineId);
    const updatedConv = await convQueries.getConversationById(conv.id, conv.company_id);
    if (updatedConv) realtimeService.publishConversationUpdate(updatedConv);
}

async function handleDeliveryUpdated(payload) {
    if (payload.MessageSid) {
        const companyId = payload.ConversationSid
            ? await convQueries.resolveCompanyByConversationSid(payload.ConversationSid)
            : await convQueries.resolveCompanyByMessageSid(payload.MessageSid);
        if (!companyId) throw unresolvedWebhookTenant(`message ${payload.MessageSid}`);
        const status = payload.DeliveryStatus || payload.Status;
        const errorCode = payload.ErrorCode ? parseInt(payload.ErrorCode) : null;
        const updatedMessage = await convQueries.updateDeliveryStatus(
            payload.MessageSid, companyId, status, errorCode, payload.ErrorMessage
        );
        if (updatedMessage
            && updatedMessage.direction === 'outbound'
            && ['failed', 'undelivered'].includes(String(status || '').toLowerCase())) {
            await eventBus.emit(companyId, 'message.delivery_failed', {
                message_id: updatedMessage.id,
                conversation_id: updatedMessage.conversation_id,
                record_refs: [{ type: 'sms_message', id: updatedMessage.id }],
            }, {
                actorType: 'webhook',
                aggregateType: 'sms_message',
                aggregateId: updatedMessage.id,
                idempotencyKey: `message.delivery_failed:${payload.MessageSid}:${String(status).toLowerCase()}`,
            });
        }
        realtimeService.publishMessageDelivery(
            payload.MessageSid, status, errorCode, updatedMessage?.company_id
        );
    }
}

async function handleConversationStateUpdated(payload) {
    const conv = await getPersistedWebhookConversation(payload.ConversationSid);
    if (conv) {
        await convQueries.updateConversationState(conv.id, conv.company_id, payload.StateTo || 'closed');
        const updated = await convQueries.getConversationById(conv.id, conv.company_id);
        if (updated) realtimeService.publishConversationUpdate(updated);
    } else {
        throw unresolvedWebhookTenant(`conversation ${payload.ConversationSid || 'missing'}`);
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

    const { conversation_sid, twilio_message_sid } = media;

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
        `UPDATE sms_media media
         SET temporary_url = $2, temporary_url_expires_at = $3, updated_at = now()
         FROM sms_messages message
         JOIN sms_conversations conversation
           ON conversation.id = message.conversation_id
          AND conversation.company_id = message.company_id
         WHERE media.id = $1
           AND media.message_id = message.id
           AND message.company_id = $4
           AND conversation.company_id = $4`,
        [mediaId, tempUrl, expiresAt, media.company_id]
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
