'use strict';

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const CUSTOMER = '+15085550100';
const PROXY = '+16175550123';

let conversations;
let messages;
let mediaRows;
const mockDbQuery = jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();

    if (text.includes('FROM sms_conversations') && text.includes('customer_e164 = $1')) {
        const scoped = text.includes('company_id = $3');
        const row = conversations.find(row => (
            row.customer_e164 === params[0]
            && row.proxy_e164 === params[1]
            && row.state === 'active'
            && (!scoped || row.company_id === params[2])
        ));
        return { rows: row ? [{ ...row }] : [] };
    }

    if (text === 'SELECT * FROM sms_conversations WHERE id = $1 AND company_id = $2') {
        const row = conversations.find(item => item.id === params[0] && item.company_id === params[1]);
        return { rows: row ? [{ ...row }] : [] };
    }

    if (text.startsWith('UPDATE sms_conversations SET') && text.includes('last_message_preview')) {
        const scoped = text.includes('company_id = $5');
        const row = conversations.find(item => item.id === params[0] && (!scoped || item.company_id === params[4]));
        if (row) {
            row.last_message_preview = params[1];
            row.last_message_direction = params[2];
        }
        return { rows: [] };
    }

    if (text.startsWith('UPDATE sms_conversations SET') && text.includes('last_read_at')) {
        const scoped = text.includes('company_id = $2');
        const row = conversations.find(item => item.id === params[0] && (!scoped || item.company_id === params[1]));
        if (row) row.has_unread = false;
        return { rows: row ? [{ ...row }] : [] };
    }

    if (text.startsWith('UPDATE sms_messages SET delivery_status')) {
        const scoped = text.includes('company_id = $2');
        const row = messages.find(item => item.twilio_message_sid === params[0] && (!scoped || item.company_id === params[1]));
        if (row) row.delivery_status = params[2];
        return { rows: row ? [{ company_id: row.company_id }] : [] };
    }

    if (text.startsWith('INSERT INTO sms_media')) {
        const scoped = text.includes('message.company_id = $10') && text.includes('conversation.company_id = $10');
        const message = messages.find(item => item.id === params[0]);
        const conversation = message && conversations.find(item => item.id === message.conversation_id);
        const allowed = message && conversation
            && (!scoped || (message.company_id === params[9] && conversation.company_id === params[9]));
        if (!allowed) return { rows: [] };
        const row = {
            id: `media-${mediaRows.length + 1}`,
            message_id: params[0],
            twilio_media_sid: params[1],
        };
        mediaRows.push(row);
        return { rows: [{ ...row }] };
    }

    if (text.startsWith('SELECT media.*, message.company_id')) {
        const media = mediaRows.find(item => item.id === params[0]);
        const message = media && messages.find(item => item.id === media.message_id);
        const conversation = message && conversations.find(item => item.id === message.conversation_id);
        if (!media || !message || !conversation
            || message.company_id !== conversation.company_id
            || message.company_id !== params[1]) {
            return { rows: [] };
        }
        return {
            rows: [{
                ...media,
                company_id: message.company_id,
                conversation_sid: message.conversation_sid,
                twilio_message_sid: message.twilio_message_sid,
            }],
        };
    }

    return { rows: [] };
});

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

jest.mock('../backend/src/middleware/providerScope', () => ({
    PULSE_INACTIVE_JOB_STATUSES: [],
}));

const queries = require('../backend/src/db/conversationsQueries');

beforeEach(() => {
    jest.clearAllMocks();
    conversations = [
        {
            id: 'conv-b', company_id: COMPANY_B, customer_e164: CUSTOMER,
            proxy_e164: PROXY, state: 'active', has_unread: true, last_message_preview: 'B original',
        },
        {
            id: 'conv-a', company_id: COMPANY_A, customer_e164: CUSTOMER,
            proxy_e164: PROXY, state: 'active', has_unread: true, last_message_preview: 'A original',
        },
    ];
    messages = [
        {
            id: 'msg-a', conversation_id: 'conv-a', company_id: COMPANY_A,
            conversation_sid: 'CH-A', twilio_message_sid: 'IM-A', delivery_status: 'sent',
        },
        {
            id: 'msg-b', conversation_id: 'conv-b', company_id: COMPANY_B,
            conversation_sid: 'CH-B', twilio_message_sid: 'IM-B', delivery_status: 'sent',
        },
    ];
    mediaRows = [];
});

test('T-own/T-blast: shared active phone pair resolves only inside the requested company', async () => {
    const beforeB = { ...conversations[0] };

    const result = await queries.findActiveConversation(CUSTOMER, PROXY, COMPANY_A);

    expect(result).toMatchObject({ id: 'conv-a', company_id: COMPANY_A });
    expect(conversations[0]).toEqual(beforeB);
});

test('T-foreign: conversation ID read returns not-found for another company', async () => {
    await expect(queries.getConversationById('conv-b', COMPANY_A)).resolves.toBeNull();
});

test('T-own/T-foreign/T-blast: preview, read-state, delivery, and media writes cannot touch B', async () => {
    const beforeConversationB = { ...conversations[0] };
    const beforeMessageB = { ...messages[1] };

    await queries.updateConversationPreview('conv-b', COMPANY_A, {
        body: 'A overwrite', direction: 'outbound', timestamp: new Date().toISOString(),
    });
    await expect(queries.markConversationRead('conv-b', COMPANY_A)).resolves.toBeNull();
    await expect(queries.updateDeliveryStatus('IM-B', COMPANY_A, 'delivered', null, null)).resolves.toBeNull();
    await expect(queries.insertMedia({
        message_id: 'msg-b', twilio_media_sid: 'ME-cross', company_id: COMPANY_A,
    })).resolves.toBeNull();

    expect(conversations[0]).toEqual(beforeConversationB);
    expect(messages[1]).toEqual(beforeMessageB);
    expect(mediaRows).toEqual([]);

    await queries.updateConversationPreview('conv-a', COMPANY_A, {
        body: 'A own update', direction: 'outbound', timestamp: new Date().toISOString(),
    });
    await expect(queries.markConversationRead('conv-a', COMPANY_A)).resolves.toMatchObject({ has_unread: false });
    await expect(queries.updateDeliveryStatus('IM-A', COMPANY_A, 'delivered', null, null))
        .resolves.toEqual({ company_id: COMPANY_A });
    await expect(queries.insertMedia({
        message_id: 'msg-a', twilio_media_sid: 'ME-own', company_id: COMPANY_A,
    })).resolves.toMatchObject({ message_id: 'msg-a' });
});

test('media UUID lookup returns only a same-company message/conversation chain', async () => {
    mediaRows.push({ id: 'media-own', message_id: 'msg-a', twilio_media_sid: 'ME-own' });
    messages.push({
        id: 'msg-mismatch', conversation_id: 'conv-b', company_id: COMPANY_A,
        conversation_sid: 'CH-mismatch', twilio_message_sid: 'IM-mismatch',
    });
    mediaRows.push({ id: 'media-mismatch', message_id: 'msg-mismatch', twilio_media_sid: 'ME-mismatch' });

    await expect(queries.getMediaById('media-own', COMPANY_A))
        .resolves.toMatchObject({ company_id: COMPANY_A });
    await expect(queries.getMediaById('media-own', COMPANY_B)).resolves.toBeNull();
    await expect(queries.getMediaById('media-mismatch', COMPANY_A)).resolves.toBeNull();
});

test('company-scoped helpers reject a missing company before querying', async () => {
    await expect(queries.findActiveConversation(CUSTOMER, PROXY)).rejects.toThrow('companyId is required');
    await expect(queries.getConversationById('conv-a')).rejects.toThrow('companyId is required');
    await expect(queries.markConversationRead('conv-a')).rejects.toThrow('companyId is required');
    await expect(queries.updateDeliveryStatus('IM-A', null, 'delivered')).rejects.toThrow('companyId is required');
    await expect(queries.upsertConversation({ twilio_conversation_sid: 'CH-new' }))
        .rejects.toThrow('companyId is required');
    await expect(queries.upsertMessage({ twilio_message_sid: 'IM-new' }))
        .rejects.toThrow('companyId is required');
    await expect(queries.insertMedia({ message_id: 'msg-a', twilio_media_sid: 'ME-new' }))
        .rejects.toThrow('companyId is required');
    await expect(queries.getMediaById('media-own'))
        .rejects.toThrow('companyId is required');
    expect(mockDbQuery).not.toHaveBeenCalled();
});
