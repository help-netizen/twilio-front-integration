'use strict';

const {
    _buildAttributions,
    _buildMatchResults,
    normalizeUsPhone,
    parseProviderCreationDateTime,
} = require('../backend/src/services/googleLsaAttributionService');

const NOW = new Date('2026-08-11T16:00:00.000Z');

function lsaLead(id, overrides = {}) {
    return {
        id,
        lead_type: 'PHONE_CALL',
        normalized_phone: '6175550101',
        provider_created_at: new Date('2026-08-10T14:00:00.000Z'),
        ...overrides,
    };
}

function evidence(lsaLeadId, overrides = {}) {
    return {
        lsa_lead_id: lsaLeadId,
        contact_id: 10,
        crm_lead_id: null,
        call_id: 20,
        match_method: 'nearby_call_contact',
        match_confidence: 100,
        delta_seconds: '30',
        ...overrides,
    };
}

describe('Google LSA deterministic matcher', () => {
    test('normalizes last-ten US phones and parses timezone-less provider timestamps', () => {
        expect(normalizeUsPhone('+1 (617) 555-0101')).toEqual({
            normalizedPhone: '6175550101',
            phoneE164: '+16175550101',
        });
        expect(normalizeUsPhone('555-0101')).toBeNull();
        expect(parseProviderCreationDateTime(
            '2026-01-10 09:30:15.123456',
            'America/New_York'
        ).toISOString()).toBe('2026-01-10T14:30:15.123Z');
    });

    test('uses confidence priority, preserves diagnostics, and excludes MESSAGE leads', () => {
        const results = _buildMatchResults([
            lsaLead('call-contact'),
            lsaLead('call-phone'),
            lsaLead('crm-lead'),
            lsaLead('phone-only'),
            lsaLead('message', { lead_type: 'MESSAGE' }),
        ], [
            evidence('call-contact'),
            evidence('call-contact', {
                contact_id: 99,
                call_id: null,
                match_method: 'nearby_crm_lead_contact',
                match_confidence: 90,
            }),
            evidence('call-phone', {
                call_id: 21,
                match_method: 'nearby_call_phone',
                match_confidence: 95,
            }),
            evidence('crm-lead', {
                crm_lead_id: 30,
                call_id: null,
                match_method: 'nearby_crm_lead_contact',
                match_confidence: 90,
            }),
            evidence('phone-only', {
                call_id: null,
                match_method: 'phone_only',
                match_confidence: 60,
                delta_seconds: null,
            }),
        ], NOW);

        expect(results.map(result => ({
            id: result.lsaLeadId,
            status: result.matchStatus,
            method: result.matchMethod,
            contact: result.matchedContactId,
        }))).toEqual([
            {
                id: 'call-contact',
                status: 'matched',
                method: 'nearby_call_contact',
                contact: 10,
            },
            {
                id: 'call-phone',
                status: 'matched',
                method: 'nearby_call_phone',
                contact: 10,
            },
            {
                id: 'crm-lead',
                status: 'matched',
                method: 'nearby_crm_lead_contact',
                contact: 10,
            },
            {
                id: 'phone-only',
                status: 'diagnostic',
                method: 'phone_only',
                contact: null,
            },
            {
                id: 'message',
                status: 'ineligible',
                method: null,
                contact: null,
            },
        ]);
    });

    test('fails closed when equal best evidence points at different contacts', () => {
        const results = _buildMatchResults([lsaLead('ambiguous')], [
            evidence('ambiguous', { contact_id: 10 }),
            evidence('ambiguous', { contact_id: 11 }),
        ], NOW);
        expect(results[0]).toMatchObject({
            matchStatus: 'ambiguous',
            matchedContactId: null,
            matchConfidence: null,
        });
    });

    test('attributes duplicate-contact jobs inside the window to one nearest LSA owner', () => {
        const first = _buildMatchResults([lsaLead('first')], [
            evidence('first'),
        ], NOW)[0];
        const second = _buildMatchResults([lsaLead('second', {
            provider_created_at: new Date('2026-08-12T14:00:00.000Z'),
        })], [evidence('second', { call_id: 21 })], NOW)[0];
        const attributions = _buildAttributions([first, second], [
            {
                normalized_phone: '6175550101',
                job_id: 100,
                contact_id: 10,
                acquired_at: new Date('2026-08-10T15:00:00.000Z'),
            },
            {
                normalized_phone: '6175550101',
                job_id: 101,
                contact_id: 11,
                acquired_at: new Date('2026-08-12T13:00:00.000Z'),
            },
            {
                normalized_phone: '6175550101',
                job_id: 102,
                contact_id: 11,
                acquired_at: new Date('2026-05-01T00:00:00.000Z'),
            },
        ]);

        expect(attributions.map(row => ({
            job: row.matchedJobId,
            owner: row.lsaLeadId,
            contact: row.matchedContactId,
        }))).toEqual([
            { job: 100, owner: 'first', contact: 10 },
            { job: 101, owner: 'second', contact: 11 },
        ]);
    });
});
