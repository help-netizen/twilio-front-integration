'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const membershipQueries = require('../backend/src/db/membershipQueries');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const rosterService = require('../backend/src/services/technicianRosterService');

jest.setTimeout(30000);

function probeMigratedDatabase() {
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
            try {
                await client.connect();
                const result = await client.query(
                    \`SELECT to_regclass('public.technicians') IS NOT NULL
                            AND to_regclass('public.technician_external_identities') IS NOT NULL AS ready\`
                );
                await client.end();
                process.exit(result.rows[0].ready ? 0 : 3);
            } catch (error) {
                process.stderr.write(String(error.message || error));
                try { await client.end(); } catch {}
                process.exit(2);
            }
        })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv,
        encoding: 'utf8',
        timeout: 6000,
    });
    return result.status === 0;
}

const databaseTest = probeMigratedDatabase() ? test : test.skip;

describe('native technician roster mode against real PostgreSQL', () => {
    databaseTest('returns mapped compatibility ids plus native-only technicians during a forced ZB outage', async () => {
        const companyId = randomUUID();
        const mappedTechnicianId = randomUUID();
        const nativeOnlyTechnicianId = randomUUID();
        const inactiveTechnicianId = randomUUID();
        const zenbookerId = `zb-roster-${randomUUID()}`;
        const suffix = randomUUID();
        const getTeamMembers = jest.spyOn(zenbookerClient, 'getTeamMembers')
            .mockRejectedValue(new Error('forced Zenbooker outage'));

        process.env.TECHNICIAN_DIRECTORY_MODE = 'native';
        process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS = companyId;
        try {
            await db.query(
                `INSERT INTO companies (id, name, slug, status, timezone)
                 VALUES ($1, 'Native roster DB', $2, 'active', 'America/New_York')`,
                [companyId, `native-roster-${suffix}`]
            );
            await db.query(
                `INSERT INTO technicians (id, company_id, display_name, active)
                 VALUES ($1, $4, 'Mapped Provider', TRUE),
                        ($2, $4, 'Native Only Provider', TRUE),
                        ($3, $4, 'Inactive Provider', FALSE)`,
                [mappedTechnicianId, nativeOnlyTechnicianId, inactiveTechnicianId, companyId]
            );
            await db.query(
                `INSERT INTO technician_external_identities
                    (company_id, source, external_id, technician_id)
                 VALUES ($1, 'zenbooker', $2, $3)`,
                [companyId, zenbookerId, mappedTechnicianId]
            );

            const roster = await rosterService.listActive(companyId);

            expect(roster).toEqual([
                {
                    id: zenbookerId,
                    name: 'Mapped Provider',
                    active: true,
                    technician_uuid: mappedTechnicianId,
                },
                {
                    id: nativeOnlyTechnicianId,
                    name: 'Native Only Provider',
                    active: true,
                    technician_uuid: nativeOnlyTechnicianId,
                },
            ]);
            expect(roster.map(technician => technician.id)).toContain(nativeOnlyTechnicianId);
            expect(getTeamMembers).not.toHaveBeenCalled();
        } finally {
            getTeamMembers.mockRestore();
            delete process.env.TECHNICIAN_DIRECTORY_MODE;
            delete process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS;
            await db.query('DELETE FROM technicians WHERE company_id = $1', [companyId]).catch(() => {});
            await db.query('DELETE FROM companies WHERE id = $1', [companyId]).catch(() => {});
        }
    });

    databaseTest('native technician assignment resolves to crm_users.id without crossing the auth planes', async () => {
        const companyId = randomUUID();
        const foreignCompanyId = randomUUID();
        const technicianId = randomUUID();
        const suffix = randomUUID();
        let crmUserId = null;
        try {
            await db.query(
                `INSERT INTO companies (id, name, slug, status, timezone)
                 VALUES ($1, 'Native auth DB', $2, 'active', 'America/New_York'),
                        ($3, 'Foreign auth DB', $4, 'active', 'America/New_York')`,
                [
                    companyId,
                    `native-auth-${suffix}`,
                    foreignCompanyId,
                    `foreign-auth-${suffix}`,
                ]
            );
            const user = await db.query(
                `INSERT INTO crm_users
                    (keycloak_sub, email, full_name, role, status, company_id,
                     platform_role, onboarding_status, kind)
                 VALUES ($1, $2, 'Native Provider', 'company_member', 'active', $3,
                         'none', 'active', 'user')
                 RETURNING id`,
                [`native-auth-${suffix}`, `native-auth-${suffix}@test.invalid`, companyId]
            );
            crmUserId = user.rows[0].id;
            await db.query(
                `INSERT INTO company_memberships
                    (user_id, company_id, role, role_key, status)
                 VALUES ($1, $2, 'company_member', 'provider', 'active')`,
                [crmUserId, companyId]
            );
            await db.query(
                `INSERT INTO technicians (id, company_id, display_name, active, crm_user_id)
                 VALUES ($1, $2, 'Native Provider', TRUE, $3)`,
                [technicianId, companyId, crmUserId]
            );

            await expect(membershipQueries.resolveProviderUserIds(companyId, [technicianId]))
                .resolves.toEqual([String(crmUserId)]);
            await expect(membershipQueries.resolveProviderUserIds(foreignCompanyId, [technicianId]))
                .resolves.toEqual([]);
        } finally {
            await db.query('DELETE FROM technicians WHERE company_id = $1', [companyId]).catch(() => {});
            await db.query('DELETE FROM company_memberships WHERE company_id = $1', [companyId]).catch(() => {});
            if (crmUserId) {
                await db.query('DELETE FROM crm_users WHERE id = $1', [crmUserId]).catch(() => {});
            }
            await db.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [
                [companyId, foreignCompanyId],
            ]).catch(() => {});
        }
    });
});

afterAll(async () => {
    delete process.env.TECHNICIAN_DIRECTORY_MODE;
    delete process.env.TECHNICIAN_DIRECTORY_COMPANY_IDS;
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});
