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
        const sharedCallSid = `CA-${randomUUID()}`;
        const sharedRecordingSid = `RE-${randomUUID()}`;
        const sharedEventKey = `event-${randomUUID()}`;

        try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            await client.query(`
                CREATE TABLE calls (
                    id BIGSERIAL PRIMARY KEY,
                    company_id UUID NOT NULL,
                    call_sid TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'initiated',
                    is_final BOOLEAN NOT NULL DEFAULT false,
                    last_event_time TIMESTAMPTZ,
                    raw_last_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    CONSTRAINT calls_call_sid_key UNIQUE (call_sid)
                );
                CREATE TABLE recordings (
                    id BIGSERIAL PRIMARY KEY,
                    company_id UUID NOT NULL,
                    recording_sid TEXT NOT NULL,
                    call_sid TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'in-progress',
                    completed_at TIMESTAMPTZ,
                    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    CONSTRAINT recordings_recording_sid_key UNIQUE (recording_sid),
                    CONSTRAINT recordings_call_sid_fkey FOREIGN KEY (call_sid) REFERENCES calls(call_sid)
                );
                CREATE TABLE transcripts (
                    id BIGSERIAL PRIMARY KEY,
                    company_id UUID NOT NULL,
                    transcription_sid TEXT,
                    call_sid TEXT,
                    recording_sid TEXT,
                    status TEXT,
                    text TEXT,
                    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    is_final BOOLEAN NOT NULL DEFAULT false,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    CONSTRAINT transcripts_transcription_sid_key UNIQUE (transcription_sid),
                    CONSTRAINT transcripts_call_sid_fkey FOREIGN KEY (call_sid) REFERENCES calls(call_sid),
                    CONSTRAINT transcripts_recording_sid_fkey FOREIGN KEY (recording_sid) REFERENCES recordings(recording_sid)
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
                CREATE TABLE call_flow_executions (
                    id TEXT PRIMARY KEY,
                    company_id TEXT NOT NULL,
                    call_sid TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                );
                CREATE UNIQUE INDEX uq_call_flow_executions_call_sid
                    ON call_flow_executions(call_sid);
            `);

            await client.query(
                `INSERT INTO company_telephony (company_id, twilio_subaccount_sid)
                 VALUES ($1, 'AC-sub-b')`,
                [companyB]
            );
            await client.query(
                `INSERT INTO calls
                    (company_id, call_sid, status, is_final, raw_last_payload)
                 VALUES ($1, 'CA-leaked', 'completed', true, '{"AccountSid":"AC-sub-b"}')`,
                [companyA]
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
                `INSERT INTO calls (company_id, call_sid, status, is_final, last_event_time)
                 VALUES ($1, $3, 'completed', true, now()),
                        ($2, $3, 'completed', true, now())`,
                [companyA, companyB, sharedCallSid]
            );
            await client.query(
                `INSERT INTO recordings
                    (company_id, recording_sid, call_sid, status, completed_at)
                 VALUES ($1, $3, $4, 'completed', now()),
                        ($2, $3, $4, 'completed', now())`,
                [companyA, companyB, sharedRecordingSid, sharedCallSid]
            );
            await client.query(
                `INSERT INTO call_flow_executions (id, company_id, call_sid, status)
                 VALUES ('flow-a', $1, $3, 'active'),
                        ('flow-b', $2, $3, 'active')`,
                [companyA, companyB, sharedCallSid]
            );
            await client.query(
                `INSERT INTO transcripts
                    (company_id, transcription_sid, call_sid, status, text, is_final)
                 VALUES ($1, $3, $4, 'completed', 'master text', true),
                        ($2, $3, $4, 'completed', 'tenant B text', true)`,
                [companyA, companyB, sharedTranscriptSid, sharedCallSid]
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
            const beforeBCall = await client.query(
                `SELECT to_jsonb(c) AS snapshot FROM calls c
                 WHERE company_id = $1 AND call_sid = $2`,
                [companyB, sharedCallSid]
            );
            const beforeBRecording = await client.query(
                `SELECT to_jsonb(r) AS snapshot FROM recordings r
                 WHERE company_id = $1 AND recording_sid = $2`,
                [companyB, sharedRecordingSid]
            );
            const beforeBFlow = await client.query(
                `SELECT to_jsonb(f) AS snapshot FROM call_flow_executions f
                 WHERE company_id = $1 AND call_sid = $2`,
                [companyB, sharedCallSid]
            );

            // Simulate a drifted database with duplicate default-company rows,
            // then prove re-apply keeps the most complete row and restores keys.
            await client.query(`
                ALTER TABLE recordings DROP CONSTRAINT recordings_company_call_sid_fkey;
                ALTER TABLE transcripts DROP CONSTRAINT transcripts_company_call_sid_fkey;
                ALTER TABLE transcripts DROP CONSTRAINT transcripts_company_recording_sid_fkey;
                ALTER TABLE calls DROP CONSTRAINT uq_calls_company_call_sid;
                ALTER TABLE recordings DROP CONSTRAINT uq_recordings_company_recording_sid;
                ALTER TABLE transcripts DROP CONSTRAINT uq_transcripts_company_transcription_sid;
                ALTER TABLE webhook_inbox DROP CONSTRAINT uq_webhook_inbox_company_event_key;
                DROP INDEX uq_call_flow_executions_company_call_sid;
            `);
            await client.query(
                `INSERT INTO calls
                    (company_id, call_sid, status, is_final, last_event_time, updated_at)
                 VALUES ($1, $2, 'initiated', false, now() - interval '1 day', now() - interval '1 day')`,
                [companyA, sharedCallSid]
            );
            await client.query(
                `INSERT INTO recordings
                    (company_id, recording_sid, call_sid, status, updated_at)
                 VALUES ($1, $2, $3, 'in-progress', now() - interval '1 day')`,
                [companyA, sharedRecordingSid, sharedCallSid]
            );
            await client.query(
                `INSERT INTO call_flow_executions
                    (id, company_id, call_sid, status, updated_at)
                 VALUES ('flow-a-stale', $1, $2, 'completed', now() - interval '1 day')`,
                [companyA, sharedCallSid]
            );
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
            const afterBCall = await client.query(
                `SELECT to_jsonb(c) AS snapshot FROM calls c
                 WHERE company_id = $1 AND call_sid = $2`,
                [companyB, sharedCallSid]
            );
            const afterBRecording = await client.query(
                `SELECT to_jsonb(r) AS snapshot FROM recordings r
                 WHERE company_id = $1 AND recording_sid = $2`,
                [companyB, sharedRecordingSid]
            );
            const afterBFlow = await client.query(
                `SELECT to_jsonb(f) AS snapshot FROM call_flow_executions f
                 WHERE company_id = $1 AND call_sid = $2`,
                [companyB, sharedCallSid]
            );
            expect(afterBCall.rows[0].snapshot).toStrictEqual(beforeBCall.rows[0].snapshot);
            expect(afterBRecording.rows[0].snapshot).toStrictEqual(beforeBRecording.rows[0].snapshot);
            expect(afterBFlow.rows[0].snapshot).toStrictEqual(beforeBFlow.rows[0].snapshot);
            const pairedCounts = await client.query(
                `SELECT
                    (SELECT COUNT(*)::int FROM calls WHERE call_sid = $1) AS calls,
                    (SELECT COUNT(*)::int FROM recordings WHERE recording_sid = $2) AS recordings,
                    (SELECT COUNT(*)::int FROM call_flow_executions WHERE call_sid = $1) AS flows`,
                [sharedCallSid, sharedRecordingSid]
            );
            expect(pairedCounts.rows[0]).toEqual({ calls: 2, recordings: 2, flows: 2 });

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
