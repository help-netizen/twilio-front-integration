'use strict';

const mockGetActiveSettings = jest.fn();
jest.mock('../backend/src/services/callMaskingService', () => ({
    getActiveSettings: (...args) => mockGetActiveSettings(...args),
}));

const {
    resolveMaskViewer,
    getMaskViewer,
    redactPulsePayload,
    buildMaskedSmsTargets,
} = require('../backend/src/services/pulseMaskingService');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const CUSTOMER = '+15085550100';
const SECONDARY = '+15085550199';
const PROXY = '+16175550123';

function viewer(permissions = ['pulse.view', 'call_masking.use']) {
    return {
        user: { crmUser: { id: 'provider-1' } },
        authz: { permissions },
        companyFilter: { company_id: COMPANY_A },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('MASK-REDACTION-001 viewer predicate', () => {
    test('effective call_masking.use + active company settings masks the viewer', async () => {
        mockGetActiveSettings.mockResolvedValue({
            call_masking_enabled: true,
            call_masking_number: PROXY,
        });

        await expect(resolveMaskViewer(viewer())).resolves.toBe(true);
        expect(mockGetActiveSettings).toHaveBeenCalledWith(COMPANY_A);
    });

    // MASK-REDACTION-002: call_masking.use only grants PLACING masked calls.
    // A viewer who also holds contacts.view (admin/dispatcher/manager) reads
    // raw customer data in Contacts anyway — their Pulse must stay unredacted.
    test('admin with call_masking.use AND contacts.view is not a masked viewer', async () => {
        await expect(resolveMaskViewer(viewer(['pulse.view', 'call_masking.use', 'contacts.view'])))
            .resolves.toBe(false);
    });

    test('admin/dispatcher without call_masking.use is unchanged and skips settings lookup', async () => {
        await expect(resolveMaskViewer(viewer(['pulse.view']))).resolves.toBe(false);
        expect(mockGetActiveSettings).not.toHaveBeenCalled();
    });

    test('masking off leaves a provider unchanged', async () => {
        mockGetActiveSettings.mockResolvedValue(null);
        await expect(resolveMaskViewer(viewer())).resolves.toBe(false);
    });

    test('unknown auth/settings state fails closed and request resolution is cached', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockGetActiveSettings.mockRejectedValue(new Error('settings unavailable'));
        const req = viewer();

        await expect(Promise.all([getMaskViewer(req), getMaskViewer(req)])).resolves.toEqual([true, true]);
        expect(mockGetActiveSettings).toHaveBeenCalledTimes(1);
        await expect(resolveMaskViewer({ companyFilter: { company_id: COMPANY_A } })).resolves.toBe(true);
        warn.mockRestore();
    });
});

describe('MASK-REDACTION-001 shared Pulse response projector', () => {
    const payload = {
        contact: {
            id: 42,
            full_name: 'Golden Customer',
            phone_e164: CUSTOMER,
            secondary_phone: SECONDARY,
            secondary_phone_name: 'After hours',
            zenbooker_data: { phone: CUSTOMER, secondary_phone: SECONDARY },
        },
        conversations: [{
            id: 'conversation-1',
            customer_e164: CUSTOMER,
            proxy_e164: PROXY,
            friendly_name: CUSTOMER,
        }],
        messages: [{
            id: 'message-1',
            direction: 'inbound',
            from_number: CUSTOMER,
            to_number: PROXY,
            body: 'Appointment confirmed',
        }],
        calls: [{
            id: 9,
            call_sid: 'CA-secret',
            parent_call_sid: null,
            direction: 'inbound',
            from_number: CUSTOMER,
            to_number: PROXY,
            status: 'completed',
            started_at: '2026-07-31T12:00:00.000Z',
            duration_sec: 73,
            answered_by: 'ai',
            price: '-0.02',
            flow_path: [{ node: 'private-route' }],
            audioUrl: '/private-audio.mp3',
            recording: { recording_sid: 'RE-secret', playback_url: '/recording.mp3' },
            transcript: {
                text: 'Private transcript',
                gemini_summary: 'Private summary',
                sentimentScore: -0.8,
            },
        }],
        leads_map: {
            5085550100: { Phone: CUSTOMER, SecondPhone: SECONDARY },
        },
    };

    test('provider DTO contains no customer/proxy digits or call internals (sabotage: bypass projector => red)', () => {
        const redacted = redactPulsePayload(payload, true);
        const json = JSON.stringify(redacted);

        expect(json).not.toContain(CUSTOMER);
        expect(json).not.toContain(SECONDARY);
        expect(json).not.toContain(PROXY);
        expect(json).not.toContain('Private transcript');
        expect(json).not.toContain('Private summary');
        expect(json).not.toContain('RE-secret');
        expect(json).not.toContain('CA-secret');
        expect(redacted.calls[0]).toMatchObject({
            id: 9,
            direction: 'inbound',
            status: 'completed',
            duration_sec: 73,
            details_redacted: true,
        });
        expect(redacted.calls[0]).not.toHaveProperty('recording');
        expect(redacted.calls[0]).not.toHaveProperty('transcript');
        expect(redacted.calls[0]).not.toHaveProperty('flow_path');
        expect(redacted.calls[0]).not.toHaveProperty('audioUrl');
        expect(redacted.leads_map).toEqual({});
        expect(redacted.contact.secondary_phone_name).toBe('After hours');
    });

    test('admin/masking-off projector is byte-for-byte unchanged', () => {
        expect(redactPulsePayload(payload, false)).toBe(payload);
    });

    test('composer targets contain labels and opaque refs, never phone digits', () => {
        const targets = buildMaskedSmsTargets(payload.contact, [{
            id: 'conversation-primary',
            customer_e164: CUSTOMER,
        }]);
        const json = JSON.stringify(targets);

        expect(targets).toEqual([
            {
                channel: 'sms',
                target_ref: 'contact:primary',
                conversation_id: 'conversation-primary',
                label: 'Main number',
            },
            {
                channel: 'sms',
                target_ref: 'contact:secondary',
                conversation_id: null,
                label: 'After hours',
            },
        ]);
        expect(json).not.toContain(CUSTOMER);
        expect(json).not.toContain(SECONDARY);
    });
});
