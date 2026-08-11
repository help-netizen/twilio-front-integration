'use strict';

const { buildWindowedJobAttributions } = require('../backend/src/services/phoneAttributionCore');

// Regression: a single job can be reachable through several duplicate contacts of
// the same person, so the resolved `jobs` array holds the same job_id more than
// once. buildWindowedJobAttributions must emit exactly ONE attribution per job —
// emitting duplicate (owner-lead, job) rows violates the *_job_attributions PK.
// (2026-08-11: the eLocal full-volume backfill hit this once the adapter stopped
// dropping records.)
describe('phoneAttributionCore.buildWindowedJobAttributions', () => {
    const result = {
        matchStatus: 'matched',
        normalizedPhone: '6175550101',
        providerCreatedAt: '2026-08-10T12:00:00.000Z',
        itemId: 'lead-1',
        selectedEvidence: { call_id: 'call-1', crm_lead_id: null, match_method: 'nearby_call_contact', match_confidence: 100 },
    };

    test('emits ONE attribution per job even when duplicate contacts share it', () => {
        const jobs = [
            { job_id: 'job-1', contact_id: 'contact-A', normalized_phone: '6175550101', acquired_at: '2026-08-10T13:00:00.000Z' },
            { job_id: 'job-1', contact_id: 'contact-B', normalized_phone: '6175550101', acquired_at: '2026-08-10T13:00:00.000Z' },
        ];
        const out = buildWindowedJobAttributions([result], jobs);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ itemId: 'lead-1', matchedJobId: 'job-1' });
    });

    test('still attributes multiple distinct jobs to their owner', () => {
        const jobs = [
            { job_id: 'job-1', contact_id: 'contact-A', normalized_phone: '6175550101', acquired_at: '2026-08-10T13:00:00.000Z' },
            { job_id: 'job-2', contact_id: 'contact-A', normalized_phone: '6175550101', acquired_at: '2026-08-11T13:00:00.000Z' },
        ];
        const out = buildWindowedJobAttributions([result], jobs);
        expect(out.map(a => a.matchedJobId).sort()).toEqual(['job-1', 'job-2']);
    });
});
