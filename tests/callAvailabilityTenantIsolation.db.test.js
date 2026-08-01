'use strict';

const { randomUUID } = require('crypto');

const mockGetClientForCompany = jest.fn();
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    getClientForCompany: (...args) => mockGetClientForCompany(...args),
}));

const db = require('../backend/src/db/connection');
const callAvailability = require('../backend/src/services/callAvailability');

jest.setTimeout(60000);

describe('call availability tenant-paired stale reconciliation', () => {
    beforeEach(() => jest.clearAllMocks());

    test('missing company fails closed before provider or database access', async () => {
        await expect(callAvailability.verifyAndFixStaleCalls(
            ['CA-unscoped'], null, 'missing-company'
        )).rejects.toMatchObject({ code: 'TWILIO_TENANT_UNRESOLVED' });
        expect(mockGetClientForCompany).not.toHaveBeenCalled();
    });

    test('T-blast: reconciling a shared CallSid for B leaves A byte-unchanged', async () => {
        const client = await db.pool.connect();
        const schema = `call_availability_${randomUUID().replaceAll('-', '')}`;
        const companyA = randomUUID();
        const companyB = randomUUID();
        const sharedCallSid = `CA-${randomUUID()}`;
        let querySpy;

        try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            await client.query(`
                CREATE TABLE calls (
                    id BIGSERIAL PRIMARY KEY,
                    company_id UUID NOT NULL,
                    call_sid TEXT NOT NULL,
                    status TEXT NOT NULL,
                    is_final BOOLEAN NOT NULL DEFAULT false,
                    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    ended_at TIMESTAMPTZ,
                    from_number TEXT,
                    to_number TEXT,
                    parent_call_sid TEXT,
                    UNIQUE (company_id, call_sid)
                )
            `);
            await client.query(
                `INSERT INTO calls (company_id, call_sid, status, from_number, to_number)
                 VALUES ($1, $3, 'in-progress', '+15550000001', 'client:tenant-a'),
                        ($2, $3, 'in-progress', '+15550000002', 'client:tenant-b')`,
                [companyA, companyB, sharedCallSid]
            );

            querySpy = jest.spyOn(db, 'query').mockImplementation(
                (text, params) => client.query(text, params)
            );
            const fetch = jest.fn().mockResolvedValue({
                status: 'completed',
                endTime: new Date('2026-08-01T12:00:00.000Z'),
            });
            const calls = jest.fn(sid => {
                expect(sid).toBe(sharedCallSid);
                return { fetch };
            });
            mockGetClientForCompany.mockResolvedValue({
                companyId: companyB,
                accountSid: 'AC-sub-b',
                mode: 'subaccount',
                client: { calls },
            });

            const beforeA = await client.query(
                `SELECT to_jsonb(c) AS snapshot FROM calls c
                 WHERE company_id = $1 AND call_sid = $2`,
                [companyA, sharedCallSid]
            );
            const resolved = await callAvailability.verifyAndFixStaleCalls(
                [sharedCallSid], companyB, 't-blast'
            );

            const afterA = await client.query(
                `SELECT to_jsonb(c) AS snapshot FROM calls c
                 WHERE company_id = $1 AND call_sid = $2`,
                [companyA, sharedCallSid]
            );
            const afterB = await client.query(
                `SELECT status, is_final, ended_at FROM calls
                 WHERE company_id = $1 AND call_sid = $2`,
                [companyB, sharedCallSid]
            );

            expect(mockGetClientForCompany).toHaveBeenCalledWith(companyB);
            expect(resolved).toEqual(new Set([sharedCallSid]));
            expect(afterA.rows[0].snapshot).toStrictEqual(beforeA.rows[0].snapshot);
            expect(afterB.rows[0]).toEqual({
                status: 'completed',
                is_final: true,
                ended_at: new Date('2026-08-01T12:00:00.000Z'),
            });
        } finally {
            querySpy?.mockRestore();
            try { await client.query('SET search_path TO public'); } catch { /* cleanup best effort */ }
            try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* cleanup best effort */ }
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
