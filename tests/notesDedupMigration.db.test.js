'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');

jest.setTimeout(60000);

const migrationsDir = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const migration = fs.readFileSync(path.join(migrationsDir, '194_notes_dedup_backfill.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(migrationsDir, 'rollback_194_notes_dedup_backfill.sql'), 'utf8');

const DUPLICATE_ID = '1784577133566x501798706937856000';
const CREATED_LESS_ID = '1784577134566x501798706937856001';
const ENTITY_CREATED = '2026-01-15T10:30:00.000Z';

function brokenNotesFixture() {
    return [
        {
            id: DUPLICATE_ID,
            zb_note_id: DUPLICATE_ID,
            text: 'bare Zenbooker copy',
            source: 'zenbooker',
        },
        {
            id: DUPLICATE_ID,
            zb_note_id: DUPLICATE_ID,
            text: 'locally edited survivor',
            source: 'zenbooker',
            created: '2026-07-20T10:00:00.000Z',
            attachments: [{ id: 7, fileName: 'receipt.pdf' }],
            created_by: 'crm-user-1',
            edited_at: '2026-07-21T10:00:00.000Z',
        },
        { id: CREATED_LESS_ID, text: 'timestamp comes from Bubble id' },
        { id: 'local-note', text: 'timestamp falls back to entity creation' },
    ];
}

function expectRepaired(notes) {
    expect(notes).toHaveLength(3);
    const duplicate = notes.find(note => note.id === DUPLICATE_ID);
    expect(duplicate).toMatchObject({
        text: 'locally edited survivor',
        created_by: 'crm-user-1',
        edited_at: '2026-07-21T10:00:00.000Z',
    });
    expect(duplicate.attachments).toHaveLength(1);

    const fromBubble = notes.find(note => note.id === CREATED_LESS_ID);
    expect(fromBubble.created).toBe(new Date(Number(CREATED_LESS_ID.split('x')[0])).toISOString());
    expect(notes.find(note => note.id === 'local-note').created).toBe(ENTITY_CREATED);
    for (const note of notes) expect(Number.isFinite(Date.parse(note.created))).toBe(true);
}

describe('migration 194 — note identity deduplication and created backfill', () => {
    test('SAB-NOTES-MIGRATION-DEDUPE-BACKFILL: repairs all three note arrays and is re-runnable', async () => {
        let client;
        try {
            client = await db.pool.connect();
            await client.query('SELECT id, notes, created_at FROM jobs LIMIT 0');
            await client.query('SELECT id, structured_notes, created_at FROM leads LIMIT 0');
            await client.query('SELECT id, structured_notes, created_at FROM contacts LIMIT 0');
        } catch (error) {
            if (client) client.release();
            console.warn(`SAB-NOTES-MIGRATION-DEDUPE-BACKFILL SKIPPED-NEEDS-DB — ${error.message}`);
            return;
        }

        const companyId = randomUUID();
        const fixture = JSON.stringify(brokenNotesFixture());
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug)
                 VALUES ($1, 'Notes dedup migration fixture', $2)`,
                [companyId, `notes-dedup-${companyId}`],
            );
            const job = await client.query(
                `INSERT INTO jobs (company_id, notes, created_at)
                 VALUES ($1, $2::jsonb, $3) RETURNING id`,
                [companyId, fixture, ENTITY_CREATED],
            );
            const lead = await client.query(
                `INSERT INTO leads (company_id, uuid, structured_notes, created_at)
                 VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
                [companyId, `nd-${randomUUID().slice(0, 16)}`, fixture, ENTITY_CREATED],
            );
            const contact = await client.query(
                `INSERT INTO contacts (company_id, full_name, structured_notes, created_at)
                 VALUES ($1, 'Notes Dedup Contact', $2::jsonb, $3) RETURNING id`,
                [companyId, fixture, ENTITY_CREATED],
            );

            const before = brokenNotesFixture();
            expect(before).toHaveLength(4);
            expect(before.filter(note => note.id === DUPLICATE_ID)).toHaveLength(2);
            expect(before.some(note => !note.created)).toBe(true);

            await client.query(migration);

            const first = await Promise.all([
                client.query('SELECT notes FROM jobs WHERE id = $1', [job.rows[0].id]),
                client.query('SELECT structured_notes AS notes FROM leads WHERE id = $1', [lead.rows[0].id]),
                client.query('SELECT structured_notes AS notes FROM contacts WHERE id = $1', [contact.rows[0].id]),
            ]);
            for (const result of first) expectRepaired(result.rows[0].notes);

            const snapshot = first.map(result => result.rows[0].notes);
            await client.query(migration);
            await client.query(rollback);

            const second = await Promise.all([
                client.query('SELECT notes FROM jobs WHERE id = $1', [job.rows[0].id]),
                client.query('SELECT structured_notes AS notes FROM leads WHERE id = $1', [lead.rows[0].id]),
                client.query('SELECT structured_notes AS notes FROM contacts WHERE id = $1', [contact.rows[0].id]),
            ]);
            expect(second.map(result => result.rows[0].notes)).toEqual(snapshot);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* ignore */ }
});
