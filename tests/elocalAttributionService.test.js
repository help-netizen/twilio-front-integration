'use strict';

const {
    _buildAttributions,
    _buildMatchResults,
} = require('../backend/src/services/elocalAttributionService');

const NOW = new Date('2026-08-11T16:00:00.000Z');

function providerLead(id, overrides = {}) {
    return {
        id,
        normalized_phone: '6175550101',
        provider_created_at: new Date('2026-08-10T14:00:00.000Z'),
        ...overrides,
    };
}

function evidence(elocalLeadId, overrides = {}) {
    return {
        elocal_lead_id: elocalLeadId,
        contact_id: 10,
        crm_lead_id: null,
        call_id: 20,
        match_method: 'nearby_call_contact',
        match_confidence: 100,
        delta_seconds: '30',
        ...overrides,
    };
}

describe('eLocal deterministic matcher using the shared phone core', () => {
    test('uses confidence tiers and fails closed on equal-contact ambiguity', () => {
        const results = _buildMatchResults([
            providerLead('direct'),
            providerLead('diagnostic'),
            providerLead('ambiguous'),
        ], [
            evidence('direct'),
            evidence('diagnostic', {
                call_id: null,
                match_method: 'phone_only',
                match_confidence: 60,
                delta_seconds: null,
            }),
            evidence('ambiguous', { contact_id: 10 }),
            evidence('ambiguous', { contact_id: 11 }),
        ], NOW);

        expect(results.map(result => ({
            id: result.elocalLeadId,
            status: result.matchStatus,
            contact: result.matchedContactId,
        }))).toEqual([
            { id: 'direct', status: 'matched', contact: 10 },
            { id: 'diagnostic', status: 'diagnostic', contact: null },
            { id: 'ambiguous', status: 'ambiguous', contact: null },
        ]);
    });

    test('enforces 24h lookback, next-call cutoff, and 90d window', () => {
        const first = _buildMatchResults(
            [providerLead('first')],
            [evidence('first')],
            NOW
        )[0];
        const second = _buildMatchResults([providerLead('second', {
            provider_created_at: new Date('2026-08-12T14:00:00.000Z'),
        })], [evidence('second', { call_id: 21 })], NOW)[0];
        const attributions = _buildAttributions([first, second], [
            {
                normalized_phone: '6175550101',
                job_id: 100,
                contact_id: 10,
                acquired_at: new Date('2026-08-09T13:59:59.999Z'),
            },
            {
                normalized_phone: '6175550101',
                job_id: 101,
                contact_id: 10,
                acquired_at: new Date('2026-08-10T15:00:00.000Z'),
            },
            {
                normalized_phone: '6175550101',
                job_id: 102,
                contact_id: 11,
                acquired_at: new Date('2026-08-12T14:00:00.000Z'),
            },
            {
                normalized_phone: '6175550101',
                job_id: 103,
                contact_id: 11,
                acquired_at: new Date('2026-11-11T14:00:00.000Z'),
            },
        ]);

        expect(attributions.map(row => ({
            job: row.matchedJobId,
            owner: row.elocalLeadId,
        }))).toEqual([
            { job: 101, owner: 'first' },
            { job: 102, owner: 'second' },
        ]);
    });
});
