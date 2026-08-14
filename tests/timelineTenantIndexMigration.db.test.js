'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../backend/src/db/connection');
const timelinesQueries = require('../backend/src/db/timelinesQueries');

const COMPANY_A = '00000000-0000-0000-0000-000000000001';
const COMPANY_B = '00000000-0000-0000-0000-0000000000b2';
const TAG = `tti-${Date.now()}`;
const stage262 = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/262_timeline_company_backfill_and_composite.sql'),
    'utf8'
);
const stage263 = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/263_drop_global_timeline_orphan_phone.sql'),
    'utf8'
);

jest.setTimeout(30000);

async function seedCompanies(client, suffix) {
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES
            ($1, 'Timeline Tenant A', $2),
            ($3, 'Timeline Tenant B', $4)
         ON CONFLICT (id) DO NOTHING`,
        [COMPANY_A, `${TAG}-a-${suffix}`, COMPANY_B, `${TAG}-b-${suffix}`]
    );
}

async function apply262WithNotices(client) {
    const notices = [];
    const onNotice = notice => notices.push(notice.message || String(notice));
    client.on('notice', onNotice);
    try {
        await client.query(stage262);
    } finally {
        client.removeListener('notice', onNotice);
    }
    return notices;
}

afterAll(async () => {
    await db.pool.end();
});

describe('TENANT-ISO-002 staged timeline migration and T-blast invariants', () => {
    it('SAB-PHONE-HEURISTIC: ambiguous phone-only evidence falls through to ABC with NOTICE and no failure', async () => {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await seedCompanies(client, 'ambiguous-phone');
            const sharedPhone = `+1202${String(Date.now()).slice(-7)}`;
            await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164)
                 VALUES ($1, 'Shared Customer A', $3),
                        ($2, 'Shared Customer B', $3)`,
                [COMPANY_A, COMPANY_B, sharedPhone]
            );
            const timelineId = (await client.query(
                `INSERT INTO timelines (phone_e164, company_id)
                 VALUES ($1, NULL) RETURNING id`,
                [sharedPhone]
            )).rows[0].id;

            const notices = await apply262WithNotices(client);

            expect(notices).toEqual(expect.arrayContaining([
                expect.stringMatching(/TENANT_ISO_262_PHONE_AMBIGUOUS: 1 timeline\(s\)/),
            ]));
            await expect(client.query(
                'SELECT company_id FROM timelines WHERE id = $1',
                [timelineId]
            )).resolves.toMatchObject({ rows: [{ company_id: COMPANY_A }] });

            // The data assignment and both schema changes remain replay-safe.
            await expect(client.query(stage262)).resolves.toBeDefined();
            await expect(client.query(
                'SELECT company_id FROM timelines WHERE id = $1',
                [timelineId]
            )).resolves.toMatchObject({ rows: [{ company_id: COMPANY_A }] });

            await client.query('ROLLBACK');
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    it('authoritative ownership wins over another tenant phone match without conflict', async () => {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await seedCompanies(client, 'link-over-phone');
            const foreignPhone = `+1312${String(Date.now()).slice(-7)}`;
            const uniquePhone = `+1415${String(Date.now()).slice(-7)}`;
            await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164)
                 VALUES ($1, 'Foreign Phone Match', $2),
                        ($1, 'Unique Phone Match', $3)`,
                [COMPANY_B, foreignPhone, uniquePhone]
            );
            const authoritativeTimeline = (await client.query(
                `INSERT INTO timelines (phone_e164, company_id)
                 VALUES ($1, $2) RETURNING id`,
                [foreignPhone, COMPANY_A]
            )).rows[0];
            const heuristicTimeline = (await client.query(
                `INSERT INTO timelines (phone_e164, company_id)
                 VALUES ($1, NULL) RETURNING id`,
                [uniquePhone]
            )).rows[0];

            await expect(client.query(stage262)).resolves.toBeDefined();
            const ownership = await client.query(
                `SELECT id, company_id FROM timelines
                 WHERE id = ANY($1::bigint[]) ORDER BY id`,
                [[authoritativeTimeline.id, heuristicTimeline.id]]
            );
            expect(ownership.rows).toEqual([
                { id: authoritativeTimeline.id, company_id: COMPANY_A },
                { id: heuristicTimeline.id, company_id: COMPANY_B },
            ]);

            await client.query('ROLLBACK');
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    it('keeps global uniqueness in 2a, then permits independent A/B orphan phones and ANONYMOUS in 2b', async () => {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await seedCompanies(client, 'phone');

            await client.query(stage262);
            await expect(client.query(stage262)).resolves.toBeDefined();
            const indexes2a = await client.query(
                `SELECT indexname FROM pg_indexes
                 WHERE schemaname = current_schema()
                   AND indexname = ANY($1::text[])`,
                [['uq_timelines_orphan_phone', 'uq_timelines_company_orphan_phone']]
            );
            expect(indexes2a.rows.map(row => row.indexname).sort()).toEqual([
                'uq_timelines_company_orphan_phone',
                'uq_timelines_orphan_phone',
            ]);

            const stagedPhone = `+1508${String(Date.now()).slice(-7)}`;
            await timelinesQueries.findOrCreateTimeline(stagedPhone, COMPANY_A, client);
            await client.query('SAVEPOINT stage2a_duplicate');
            await expect(timelinesQueries.findOrCreateTimeline(stagedPhone, COMPANY_B, client))
                .rejects.toMatchObject({ code: '23505' });
            await client.query('ROLLBACK TO SAVEPOINT stage2a_duplicate');

            // The repository runner scans every .sql file, so stage 2b is an
            // explicit operator gate rather than an automatic same-deploy drop.
            await client.query(stage263);
            const gatedIndexes = await client.query(
                `SELECT indexname FROM pg_indexes
                 WHERE schemaname = current_schema()
                   AND indexname = ANY($1::text[])`,
                [['uq_timelines_orphan_phone', 'uq_timelines_company_orphan_phone']]
            );
            expect(gatedIndexes.rows.map(row => row.indexname).sort()).toEqual([
                'uq_timelines_company_orphan_phone',
                'uq_timelines_orphan_phone',
            ]);
            await client.query("SET LOCAL albusto.tenant_iso_263_approved = 'on'");
            await client.query(stage263);
            await expect(client.query(stage263)).resolves.toBeDefined();

            const aPhone = await timelinesQueries.findOrCreateTimeline(stagedPhone, COMPANY_A, client);
            const bPhone = await timelinesQueries.findOrCreateTimeline(stagedPhone, COMPANY_B, client);
            expect(aPhone.id).not.toBe(bPhone.id);
            expect(aPhone.company_id).toBe(COMPANY_A);
            expect(bPhone.company_id).toBe(COMPANY_B);

            const beforeB = await client.query(
                `SELECT id, company_id, phone_e164, contact_id, created_at, updated_at
                 FROM timelines WHERE id = $1`,
                [bPhone.id]
            );
            await timelinesQueries.findOrCreateTimeline(stagedPhone, COMPANY_A, client);
            const afterB = await client.query(
                `SELECT id, company_id, phone_e164, contact_id, created_at, updated_at
                 FROM timelines WHERE id = $1`,
                [bPhone.id]
            );
            expect(afterB.rows[0]).toStrictEqual(beforeB.rows[0]);

            const anonymousA = await timelinesQueries.findOrCreateAnonymousTimeline(COMPANY_A, client);
            const anonymousB = await timelinesQueries.findOrCreateAnonymousTimeline(COMPANY_B, client);
            expect(anonymousA.id).not.toBe(anonymousB.id);
            expect(anonymousA.company_id).toBe(COMPANY_A);
            expect(anonymousB.company_id).toBe(COMPANY_B);

            await client.query('ROLLBACK');
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    it('T-own/T-foreign contact id and T-blast Yelp conversation stay tenant-scoped after 2b', async () => {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await seedCompanies(client, 'contact');
            await client.query(stage262);
            await client.query("SET LOCAL albusto.tenant_iso_263_approved = 'on'");
            await client.query(stage263);

            const contactA = (await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164)
                 VALUES ($1, 'Contact A', $2) RETURNING id`,
                [COMPANY_A, `+1617${String(Date.now()).slice(-7)}`]
            )).rows[0];
            const contactB = (await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164)
                 VALUES ($1, 'Contact B', $2) RETURNING id`,
                [COMPANY_B, `+1781${String(Date.now()).slice(-7)}`]
            )).rows[0];

            const own = await timelinesQueries.findOrCreateTimelineByContact(contactA.id, COMPANY_A, client);
            expect(own).toMatchObject({ company_id: COMPANY_A });

            const foreignBefore = await client.query(
                `SELECT * FROM timelines WHERE contact_id = $1 AND company_id = $2`,
                [contactB.id, COMPANY_B]
            );
            await expect(timelinesQueries.findOrCreateTimelineByContact(contactB.id, COMPANY_A, client))
                .resolves.toBeNull();
            const foreignAfter = await client.query(
                `SELECT * FROM timelines WHERE contact_id = $1 AND company_id = $2`,
                [contactB.id, COMPANY_B]
            );
            expect(foreignAfter.rows).toStrictEqual(foreignBefore.rows);

            const convId = `${TAG}-shared-conversation`;
            const yelpA = await timelinesQueries.resolveYelpTimeline(COMPANY_A, convId, {}, client);
            const yelpB = await timelinesQueries.resolveYelpTimeline(COMPANY_B, convId, {}, client);
            expect(yelpA.id).not.toBe(yelpB.id);
            expect(yelpA.company_id).toBe(COMPANY_A);
            expect(yelpB.company_id).toBe(COMPANY_B);

            await client.query('ROLLBACK');
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    it('aborts stage 2a when two authoritative ownership sources disagree', async () => {
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await seedCompanies(client, 'conflict');
            const contactB = (await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164)
                 VALUES ($1, 'Conflicting Contact B', $2) RETURNING id`,
                [COMPANY_B, `+1857${String(Date.now()).slice(-7)}`]
            )).rows[0];
            await client.query(
                `INSERT INTO timelines (company_id, contact_id)
                 VALUES ($1, $2)`,
                [COMPANY_A, contactB.id]
            );

            await expect(client.query(stage262)).rejects.toThrow(/TENANT_ISO_262_CONFLICT/);
            await client.query('ROLLBACK');
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
