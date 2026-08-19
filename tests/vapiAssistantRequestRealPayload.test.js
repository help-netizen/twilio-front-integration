/**
 * The payload below is not invented — it is the body Vapi actually POSTed to
 * /api/vapi/call-status/assistant-request on 2026-08-19, copied out of
 * `GET /logs?type=Webhook`. Every earlier probe of this contract was synthetic and
 * supplied an `orgId` the provider never sends, so the suite stayed green while
 * production answered "Invalid Vapi message" and callers heard Vapi's error prompt
 * instead of the assistant.
 */
const { parseVapiServerMessageJson } = require('../backend/src/services/vapiProviderContracts');

const REAL_ASSISTANT_REQUEST = {
    message: {
        timestamp: 1787160264307,
        type: 'assistant-request',
        call: {
            id: '01a01b0d-7e5c-7334-9ba5-123475abcce8',
            assistantId: null,
            customerId: null,
            phoneNumberId: 'd446b324-f016-48ba-b536-78c61652184d',
            type: 'inboundPhoneCall',
            startedAt: null,
            endedAt: null,
        },
    },
};

describe('assistant-request accepts what Vapi actually sends', () => {
    test('a real inbound assistant-request parses without an orgId', () => {
        const parsed = parseVapiServerMessageJson(JSON.stringify(REAL_ASSISTANT_REQUEST));
        expect(parsed.kind).toBe('assistant-request');
        expect(parsed.call.id).toBe('01a01b0d-7e5c-7334-9ba5-123475abcce8');
        expect(parsed.call.type).toBe('inboundPhoneCall');
    });

    test('an orgId is still carried through when the provider does send one', () => {
        const withOrg = JSON.parse(JSON.stringify(REAL_ASSISTANT_REQUEST));
        withOrg.message.call.orgId = '243930a0-b2f1-4a84-b511-916f5d1f6a3b';
        expect(parseVapiServerMessageJson(JSON.stringify(withOrg)).call.orgId)
            .toBe('243930a0-b2f1-4a84-b511-916f5d1f6a3b');
    });
});
