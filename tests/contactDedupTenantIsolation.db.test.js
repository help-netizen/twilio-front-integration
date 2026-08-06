'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const contactIdentityQueries = require('../backend/src/db/contactIdentityQueries');
const { resolveOrCreateContact } = require('../backend/src/services/contactResolverService');
const mergeService = require('../backend/src/services/contactEmailMergeService');
const contactsRouter = require('../backend/src/routes/contacts');
const auditService = require('../backend/src/services/auditService');
const {
    applyPlan,
    buildPlan,
    discoverDuplicateSets,
} = require('../scripts/bulkMergeContacts');

jest.setTimeout(60000);

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({
            connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
            connectionTimeoutMillis: 2000,
        });
        (async () => {
            try { await client.connect(); await client.query('SELECT 1'); await client.end(); process.exit(0); }
            catch (error) { process.stderr.write(String(error.message || error)); try { await client.end(); } catch {} process.exit(2); }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return {
        ready: result.status === 0,
        reason: String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim(),
    };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('ZB-DECOUPLE-001 B5 DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`ZB-DECOUPLE-001 B5 DB tests are pending: ${DATABASE.reason}`);
    });
}

describe('ZB-DECOUPLE-001 B5 contact-dedup tenant/RBAC red-team', () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const sharedPhone = '6175558801';
    const bulkPhone = '6175558802';
    const foreignOnlyPhone = '6175558803';
    const sharedExternalId = `zb-shared-${suffix}`;
    const foreignOnlyExternalId = `zb-foreign-only-${suffix}`;
    const ids = {};

    function sortedIds(values) {
        return values.map(String).sort((left, right) => {
            const a = BigInt(left);
            const b = BigInt(right);
            return a < b ? -1 : a > b ? 1 : 0;
        });
    }

    async function insertContact(companyId, fields = {}) {
        const { rows } = await db.query(
            `INSERT INTO contacts
                (company_id, full_name, phone_e164, email, zenbooker_customer_id, created_at)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
             RETURNING id`,
            [
                companyId,
                fields.fullName || null,
                fields.phone || null,
                fields.email || null,
                fields.externalId || null,
                fields.createdAt || null,
            ]
        );
        return rows[0].id;
    }

    async function addIdentityAndPhone(companyId, contactId, externalId, phone) {
        await contactIdentityQueries.upsertExternalIdentity({
            companyId,
            source: 'zenbooker',
            externalId,
            contactId,
        });
        if (phone) {
            await contactIdentityQueries.upsertContactPhone({
                companyId,
                contactId,
                phoneE164: phone,
                isPrimary: true,
            });
        }
    }

    async function companySnapshot(companyId) {
        const { rows } = await db.query(
            `SELECT jsonb_build_object(
                'contacts', COALESCE((
                    SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
                      FROM contacts row_value WHERE row_value.company_id = $1
                ), '[]'::jsonb),
                'phones', COALESCE((
                    SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
                      FROM contact_phones row_value WHERE row_value.company_id = $1
                ), '[]'::jsonb),
                'identities', COALESCE((
                    SELECT jsonb_agg(to_jsonb(row_value)
                                     ORDER BY row_value.source, row_value.external_id)
                      FROM contact_external_identities row_value
                     WHERE row_value.company_id = $1
                ), '[]'::jsonb),
                'redirects', COALESCE((
                    SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.old_contact_id)
                      FROM contact_merge_redirects row_value WHERE row_value.company_id = $1
                ), '[]'::jsonb),
                'jobs', COALESCE((
                    SELECT jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id)
                      FROM jobs row_value WHERE row_value.company_id = $1
                ), '[]'::jsonb)
            )::text AS snapshot`,
            [companyId]
        );
        return rows[0].snapshot;
    }

    async function companyCounts(companyId) {
        const { rows } = await db.query(
            `SELECT
                (SELECT COUNT(*)::int FROM contacts WHERE company_id = $1) AS contacts,
                (SELECT COUNT(*)::int FROM contact_phones WHERE company_id = $1) AS phones,
                (SELECT COUNT(*)::int FROM contact_external_identities WHERE company_id = $1) AS identities,
                (SELECT COUNT(*)::int FROM contact_merge_redirects WHERE company_id = $1) AS redirects,
                (SELECT COUNT(*)::int FROM jobs WHERE company_id = $1) AS jobs`,
            [companyId]
        );
        return rows[0];
    }

    beforeAll(async () => {
        if (!DATABASE.ready) return;

        for (const migrationName of [
            '241_contact_identity_foundation.sql',
            '242_contact_merge_redirects.sql',
        ]) {
            const migration = fs.readFileSync(path.join(
                __dirname,
                '../backend/db/migrations',
                migrationName
            ), 'utf8');
            await db.query(migration);
        }

        await db.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'B5 tenant A', $2, 'active', 'America/New_York'),
                    ($3, 'B5 tenant B', $4, 'active', 'America/New_York')`,
            [companyA, `b5-a-${suffix}`, companyB, `b5-b-${suffix}`]
        );

        ids.sharedA = await insertContact(companyA, {
            fullName: 'Shared-key tenant A',
            phone: '+1 (617) 555-8801',
        });
        ids.sharedB = await insertContact(companyB, {
            fullName: 'Shared-key tenant B',
            phone: '617.555.8801',
        });
        await addIdentityAndPhone(
            companyA, ids.sharedA, sharedExternalId, '+1 (617) 555-8801'
        );
        await addIdentityAndPhone(
            companyB, ids.sharedB, sharedExternalId, '617.555.8801'
        );

        ids.foreignResolverB = await insertContact(companyB, {
            fullName: 'Foreign resolver owner',
            phone: '+1 (617) 555-8803',
            email: `foreign-${suffix}@example.test`,
            externalId: foreignOnlyExternalId,
        });
        await addIdentityAndPhone(
            companyB,
            ids.foreignResolverB,
            foreignOnlyExternalId,
            '+1 (617) 555-8803'
        );

        ids.bulkA1 = await insertContact(companyA, {
            fullName: 'Bulk Tenant A',
            phone: '+1 (617) 555-8802',
            createdAt: '2020-01-01T00:00:00Z',
        });
        ids.bulkA2 = await insertContact(companyA, {
            fullName: 'Bulk Tenant A',
            phone: '617-555-8802',
            createdAt: '2021-01-01T00:00:00Z',
        });
        ids.bulkB1 = await insertContact(companyB, {
            fullName: 'Bulk Tenant B',
            phone: '+1 (617) 555-8802',
            createdAt: '2020-01-01T00:00:00Z',
        });
        ids.bulkB2 = await insertContact(companyB, {
            fullName: 'Bulk Tenant B',
            phone: '617-555-8802',
            createdAt: '2021-01-01T00:00:00Z',
        });
        for (const [companyId, contactId, externalId] of [
            [companyA, ids.bulkA1, `zb-bulk-a1-${suffix}`],
            [companyA, ids.bulkA2, `zb-bulk-a2-${suffix}`],
            [companyB, ids.bulkB1, `zb-bulk-b1-${suffix}`],
            [companyB, ids.bulkB2, `zb-bulk-b2-${suffix}`],
        ]) {
            await addIdentityAndPhone(companyId, contactId, externalId, '+16175558802');
        }

        ids.redirectSurvivorA = await insertContact(companyA, {
            fullName: 'Redirect survivor A',
        });
        ids.redirectOldA = await insertContact(companyA, {
            fullName: 'Redirect old A',
        });
        await db.query(
            `INSERT INTO contact_merge_redirects
                (company_id, old_contact_id, survivor_contact_id, status, merged_at)
             VALUES ($1, $2, $3, 'merged', NOW())`,
            [companyA, ids.redirectOldA, ids.redirectSurvivorA]
        );

        ids.driftSurvivorA = await insertContact(companyA, {
            fullName: 'Drift survivor A',
        });
        ids.driftDonorA = await insertContact(companyA, {
            fullName: 'Drift donor A',
        });
        const { rows } = await db.query(
            `INSERT INTO jobs (company_id, contact_id, zenbooker_job_id)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [companyB, ids.driftDonorA, `b5-cross-owned-child-${suffix}`]
        );
        ids.foreignOwnedJob = rows[0].id;
    });

    databaseTest('B1 external resolvers cannot resolve a company-B identity/contact under company A', async () => {
        await expect(contactIdentityQueries.resolveExternalToContact(
            companyA, 'zenbooker', foreignOnlyExternalId
        )).resolves.toBeNull();
        await expect(contactIdentityQueries.resolveContactToExternal(
            companyA, 'zenbooker', ids.foreignResolverB
        )).resolves.toBeNull();

        await expect(contactIdentityQueries.resolveExternalToContact(
            companyA, 'zenbooker', sharedExternalId
        )).resolves.toBe(ids.sharedA);
        await expect(contactIdentityQueries.resolveExternalToContact(
            companyB, 'zenbooker', sharedExternalId
        )).resolves.toBe(ids.sharedB);
    });

    databaseTest('B1 normalized-phone lookup returns only company-A owners for an A/B shared phone', async () => {
        await expect(contactIdentityQueries.findContactIdsByNormalizedPhone(
            companyA, sharedPhone
        )).resolves.toEqual([ids.sharedA]);
        await expect(contactIdentityQueries.findContactIdsByNormalizedPhone(
            companyB, sharedPhone
        )).resolves.toEqual([ids.sharedB]);
    });

    databaseTest('B2 resolver fences a company-B external id and phone and leaves B byte-identical', async () => {
        const beforeCounts = await companyCounts(companyB);
        const beforeBytes = await companySnapshot(companyB);

        const result = await resolveOrCreateContact({
            companyId: companyA,
            externalId: foreignOnlyExternalId,
            contact: {
                name: 'Tenant A local resolution',
                phone: foreignOnlyPhone,
            },
        });

        expect(String(result.contact_id)).not.toBe(String(ids.foreignResolverB));
        expect(result.created).toBe(true);
        const { rows: localRows } = await db.query(
            `SELECT company_id, deleted_at FROM contacts WHERE id = $1`,
            [result.contact_id]
        );
        expect(localRows).toEqual([{ company_id: companyA, deleted_at: null }]);
        await expect(contactIdentityQueries.resolveExternalToContact(
            companyA, 'zenbooker', foreignOnlyExternalId
        )).resolves.toBe(result.contact_id);
        await expect(contactIdentityQueries.resolveExternalToContact(
            companyB, 'zenbooker', foreignOnlyExternalId
        )).resolves.toBe(ids.foreignResolverB);
        expect(await companyCounts(companyB)).toEqual(beforeCounts);
        expect(await companySnapshot(companyB)).toBe(beforeBytes);
    });

    databaseTest('B3 rejects an A-survivor/B-donor pair before mutating either company', async () => {
        const beforeA = await companySnapshot(companyA);
        const beforeB = await companySnapshot(companyB);

        await expect(mergeService.mergeContacts(
            ids.sharedA, ids.sharedB, companyA
        )).rejects.toThrow(/cross-tenant/i);

        expect(await companySnapshot(companyA)).toBe(beforeA);
        expect(await companySnapshot(companyB)).toBe(beforeB);
    });

    databaseTest('B4 discovery and apply select only A and leave every B row byte-identical', async () => {
        const args = {
            companyId: companyA,
            dryRun: false,
            apply: true,
            limit: null,
            set: bulkPhone,
        };
        const beforeB = await companySnapshot(companyB);
        const discovered = await discoverDuplicateSets(db, args);
        expect(discovered).toEqual([{
            normalized_phone: bulkPhone,
            member_ids: sortedIds([ids.bulkA1, ids.bulkA2]),
        }]);
        expect(discovered[0].member_ids).not.toEqual(
            expect.arrayContaining(sortedIds([ids.bulkB1, ids.bulkB2]))
        );

        const plan = await buildPlan(db, args, '2035-08-06T12:00:00.000Z');
        expect(plan.company_id).toBe(companyA);
        expect(plan.sets).toHaveLength(1);
        expect(plan.sets[0].disposition).toBe('mergeable');
        expect(sortedIds([
            plan.sets[0].survivor.id,
            ...plan.sets[0].donors.map(donor => donor.id),
        ])).toEqual(sortedIds([ids.bulkA1, ids.bulkA2]));

        const report = await applyPlan(db, plan, mergeService.mergeContacts);
        expect(report.exit_code).toBe(0);
        expect(report.failures).toEqual([]);
        expect(report.aggregate_apply_result).toMatchObject({
            merged_sets: 1,
            merged_donors: 1,
            failed_sets: 0,
        });
        expect(await companySnapshot(companyB)).toBe(beforeB);

        const { rows: foreignState } = await db.query(
            `SELECT id, deleted_at
               FROM contacts
              WHERE company_id = $1 AND id = ANY($2::bigint[])
              ORDER BY id`,
            [companyB, [ids.bulkB1, ids.bulkB2]]
        );
        expect(foreignState).toEqual([
            { id: ids.bulkB1, deleted_at: null },
            { id: ids.bulkB2, deleted_at: null },
        ]);
        const { rows: foreignRedirects } = await db.query(
            `SELECT old_contact_id FROM contact_merge_redirects
              WHERE company_id = $1
                AND old_contact_id = ANY($2::bigint[])`,
            [companyB, [ids.bulkB1, ids.bulkB2]]
        );
        expect(foreignRedirects).toEqual([]);
    });

    databaseTest('B3 redirect lookup is company-scoped and hides an A redirect from B', async () => {
        const { rows: ownRows } = await db.query(
            `SELECT survivor_contact_id, status
               FROM contact_merge_redirects
              WHERE company_id = $1 AND old_contact_id = $2`,
            [companyA, ids.redirectOldA]
        );
        expect(ownRows).toEqual([{
            survivor_contact_id: ids.redirectSurvivorA,
            status: 'merged',
        }]);

        const { rows: foreignRows } = await db.query(
            `SELECT survivor_contact_id, status
               FROM contact_merge_redirects
              WHERE company_id = $1 AND old_contact_id = $2`,
            [companyB, ids.redirectOldA]
        );
        expect(foreignRows).toEqual([]);
    });

    databaseTest('B3 drift/zero-reference guards refuse to archive an A donor referenced by a B-owned child', async () => {
        const { rows: liveFkRows } = await db.query(
            `SELECT DISTINCT child.relname AS table_name, child_col.attname AS column_name
               FROM pg_constraint constraint_row
               JOIN pg_class parent ON parent.oid = constraint_row.confrelid
               JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
               JOIN pg_class child ON child.oid = constraint_row.conrelid
               JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
                    WITH ORDINALITY AS keys(child_attnum, parent_attnum, ord) ON true
               JOIN pg_attribute child_col
                 ON child_col.attrelid = child.oid AND child_col.attnum = keys.child_attnum
               JOIN pg_attribute parent_col
                 ON parent_col.attrelid = parent.oid AND parent_col.attnum = keys.parent_attnum
              WHERE constraint_row.contype = 'f'
                AND parent_ns.nspname = 'public'
                AND parent.relname = 'contacts'
                AND parent_col.attname = 'id'
              ORDER BY child.relname, child_col.attname`
        );
        expect(liveFkRows.map(row => `${row.table_name}:${row.column_name}`)).toEqual(
            mergeService.CONTACT_FK_INVENTORY
                .map(row => `${row.table}:contact_id`)
                .sort()
        );

        let guardError = null;
        try {
            await mergeService.assertNoDonorReferences(db, companyA, ids.driftDonorA);
        } catch (error) {
            guardError = error;
        }
        let mergeError = null;
        let mergeResult = null;
        try {
            mergeResult = await mergeService.mergeContacts(
                ids.driftSurvivorA,
                ids.driftDonorA,
                companyA
            );
        } catch (error) {
            mergeError = error;
        }

        const { rows: [state] } = await db.query(
            `SELECT
                (SELECT deleted_at FROM contacts
                  WHERE company_id = $1 AND id = $2) AS donor_deleted_at,
                (SELECT contact_id FROM jobs
                  WHERE company_id = $3 AND id = $4) AS foreign_job_contact_id,
                (SELECT COUNT(*)::int FROM contact_merge_redirects
                  WHERE company_id = $1 AND old_contact_id = $2) AS redirect_count`,
            [companyA, ids.driftDonorA, companyB, ids.foreignOwnedJob]
        );
        expect({
            guard_error: guardError?.message || null,
            merge_error: mergeError?.message || null,
            merge_status: mergeResult?.status || null,
            donor_deleted_at: state.donor_deleted_at,
            foreign_job_contact_id: state.foreign_job_contact_id,
            redirect_count: state.redirect_count,
        }).toEqual({
            guard_error: expect.stringMatching(/zero donor references/i),
            merge_error: expect.stringMatching(/zero donor references/i),
            merge_status: null,
            donor_deleted_at: null,
            foreign_job_contact_id: ids.driftDonorA,
            redirect_count: 0,
        });
    });

    databaseTest('merge stays contacts.edit-protected and the bulk CLI is not mounted as a route', async () => {
        const patchRoute = contactsRouter.stack.find(layer => (
            layer.route?.path === '/:id' && layer.route.methods.patch
        ));
        expect(patchRoute).toBeDefined();
        const permissionMiddleware = patchRoute.route.stack[0].handle;
        const auditSpy = jest.spyOn(auditService, 'log').mockResolvedValue(undefined);
        const invokePermission = permissions => new Promise(resolve => {
            const result = { status: null, body: null, nextCalled: false };
            const request = {
                user: { crmUser: { id: randomUUID() }, email: 'b5@example.test' },
                authz: { permissions },
                method: 'PATCH',
                originalUrl: '/api/contacts/1',
                ip: '127.0.0.1',
            };
            const response = {
                status(code) { result.status = code; return this; },
                json(body) { result.body = body; resolve(result); },
            };
            permissionMiddleware(request, response, () => {
                result.nextCalled = true;
                resolve(result);
            });
        });
        try {
            await expect(invokePermission(['contacts.view'])).resolves.toMatchObject({
                status: 403,
                nextCalled: false,
            });
            await expect(invokePermission(['contacts.edit'])).resolves.toMatchObject({
                status: null,
                nextCalled: true,
            });
        } finally {
            auditSpy.mockRestore();
        }

        const serverSource = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
        expect(serverSource).toContain(
            "app.use('/api/contacts', authenticate, requireCompanyAccess, contactsRouter);"
        );
        const routeSources = fs.readdirSync(path.join(__dirname, '../backend/src/routes'))
            .filter(name => name.endsWith('.js'))
            .map(name => fs.readFileSync(path.join(__dirname, '../backend/src/routes', name), 'utf8'))
            .join('\n');
        expect(routeSources).not.toMatch(/bulkMergeContacts/);
        const cliSource = fs.readFileSync(
            path.join(__dirname, '../scripts/bulkMergeContacts.js'),
            'utf8'
        );
        expect(cliSource).toContain('if (require.main === module)');
    });

    afterAll(async () => {
        if (DATABASE.ready) {
            await db.query(
                'DELETE FROM companies WHERE id = ANY($1::uuid[])',
                [[companyA, companyB]]
            ).catch(() => {});
        }
        await db.pool.end().catch(() => {});
    });
});
