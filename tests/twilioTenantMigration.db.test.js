'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');

const migration = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '226_twilio_tenant_natural_keys.sql'),
    'utf8'
);
const rollback = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_226_twilio_tenant_natural_keys.sql'),
    'utf8'
);

jest.setTimeout(60000);

describe('migration 226 real PostgreSQL tenant-paired Twilio keys', () => {
    test('T-blast, re-apply dedup, and rollback preflight preserve both tenants', async () => {
        const client = await db.pool.connect();
        const schema = `twilio_tenant_${randomUUID().replaceAll('-', '')}`;
        const companyA = '00000000-0000-0000-0000-000000000001';
        const companyB = randomUUID();
        const sharedTranscriptSid = `TR-${randomUUID()}`;
        const sharedEventKey = `event-${randomUUID()}`;

        try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            await client.query(`
                CREATE TABLE transcripts (
                    id BIGSERIAL PRIMARY KEY,
                    company_id UUID NOT NULL,
                    transcription_sid TEXT,
                    call_sid TEXT,
                    status TEXT,
                    text TEXT,
                    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    is_final BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    CONSTRAINT transcripts_transcription_sid_key UNIQUE (transcription_sid)
                );
                CREATE TABLE webhook_inbox (
                    id BIGSERIAL PRIMARY KEY,
                    company_id UUID NOT NULL,
                    event_key TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'received',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    processed_at TIMESTAMPTZ,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    CONSTRAINT webhook_inbox_event_key_key UNIQUE (event_key)
                );
                CREATE TABLE company_telephony (
                    company_id UUID NOT NULL,
                    twilio_subaccount_sid TEXT
                );
            `);

            await client.query(
                `INSERT INTO company_telephony (company_id, twilio_subaccount_sid)
                 VALUES ($1, 'AC-sub-b')`,
                [companyB]
            );
            await client.query(
                `INSERT INTO transcripts
                    (company_id, transcription_sid, call_sid, status, text, is_final, raw_payload)
                 VALUES ($1, 'TR-leaked', 'CA-leaked', 'completed', 'subaccount text', true,
                         '{"AccountSid":"AC-sub-b"}')`,
                [companyA]
            );
            await client.query(
                `INSERT INTO webhook_inbox (company_id, event_key, payload)
                 VALUES ($1, 'event-leaked', '{"AccountSid":"AC-sub-b"}')`,
                [companyA]
            );

            await client.query(migration);
            const repaired = await client.query(
                `SELECT
                    (SELECT company_id FROM transcripts WHERE transcription_sid = 'TR-leaked') AS transcript_company,
                    (SELECT company_id FROM webhook_inbox WHERE event_key = 'event-leaked') AS inbox_company`
            );
            expect(repaired.rows[0]).toEqual({
                transcript_company: companyB,
                inbox_company: companyB,
            });
            await client.query(
                `INSERT INTO transcripts
                    (company_id, transcription_sid, call_sid, status, text, is_final)
                 VALUES ($1, $3, 'CA-shared', 'completed', 'master text', true),
                        ($2, $3, 'CA-shared', 'completed', 'tenant B text', true)`,
                [companyA, companyB, sharedTranscriptSid]
            );
            await client.query(
                `INSERT INTO webhook_inbox (company_id, event_key, status, attempts, processed_at)
                 VALUES ($1, $3, 'processed', 1, now()),
                        ($2, $3, 'processed', 1, now())`,
                [companyA, companyB, sharedEventKey]
            );

            const beforeB = await client.query(
                `SELECT to_jsonb(t) AS snapshot FROM transcripts t
                 WHERE company_id = $1 AND transcription_sid = $2`,
                [companyB, sharedTranscriptSid]
            );
            const beforeBInbox = await client.query(
                `SELECT to_jsonb(i) AS snapshot FROM webhook_inbox i
                 WHERE company_id = $1 AND event_key = $2`,
                [companyB, sharedEventKey]
            );

            // Simulate a drifted database with duplicate default-company rows,
            // then prove re-apply keeps the most complete row and restores keys.
            await client.query(`
                ALTER TABLE transcripts DROP CONSTRAINT uq_transcripts_company_transcription_sid;
                ALTER TABLE webhook_inbox DROP CONSTRAINT uq_webhook_inbox_company_event_key;
            `);
            await client.query(
                `INSERT INTO transcripts
                    (company_id, transcription_sid, call_sid, status, text, is_final, updated_at)
                 VALUES ($1, $2, 'CA-shared', 'processing', NULL, false, now() - interval '1 day')`,
                [companyA, sharedTranscriptSid]
            );
            await client.query(
                `INSERT INTO webhook_inbox
                    (company_id, event_key, status, attempts, received_at)
                 VALUES ($1, $2, 'received', 0, now())`,
                [companyA, sharedEventKey]
            );

            await client.query(migration);
            await client.query(migration);

            const rows = await client.query(
                `SELECT company_id, transcription_sid, text
                 FROM transcripts WHERE transcription_sid = $1 ORDER BY company_id`,
                [sharedTranscriptSid]
            );
            expect(rows.rows).toHaveLength(2);
            expect(rows.rows).toEqual(expect.arrayContaining([
                { company_id: companyA, transcription_sid: sharedTranscriptSid, text: 'master text' },
                { company_id: companyB, transcription_sid: sharedTranscriptSid, text: 'tenant B text' },
            ]));

            const afterB = await client.query(
                `SELECT to_jsonb(t) AS snapshot FROM transcripts t
                 WHERE company_id = $1 AND transcription_sid = $2`,
                [companyB, sharedTranscriptSid]
            );
            expect(afterB.rows[0].snapshot).toStrictEqual(beforeB.rows[0].snapshot);
            const afterBInbox = await client.query(
                `SELECT to_jsonb(i) AS snapshot FROM webhook_inbox i
                 WHERE company_id = $1 AND event_key = $2`,
                [companyB, sharedEventKey]
            );
            expect(afterBInbox.rows[0].snapshot)
                .toStrictEqual(beforeBInbox.rows[0].snapshot);

            await client.query('BEGIN');
            await client.query('SAVEPOINT same_tenant_duplicate');
            await expect(client.query(
                `INSERT INTO transcripts
                    (company_id, transcription_sid, status, is_final)
                 VALUES ($1, $2, 'completed', true)`,
                [companyA, sharedTranscriptSid]
            )).rejects.toMatchObject({ code: '23505' });
            await client.query('ROLLBACK TO SAVEPOINT same_tenant_duplicate');
            await client.query('COMMIT');

            await expect(client.query(rollback)).rejects.toThrow(/ROLLBACK_226_BLOCKED/);
            await client.query('ROLLBACK');
            await client.query(`SET search_path TO "${schema}"`);
            const stillPaired = await client.query(
                `SELECT COUNT(*)::int AS n FROM transcripts WHERE transcription_sid = $1`,
                [sharedTranscriptSid]
            );
            expect(stillPaired.rows[0].n).toBe(2);
        } finally {
            try { await client.query('ROLLBACK'); } catch { /* no active transaction */ }
            try { await client.query('SET search_path TO public'); } catch { /* connection failed */ }
            try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* cleanup best effort */ }
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* already closed */ }
});
