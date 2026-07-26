'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const userService = require('../backend/src/services/userService');

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
    test('OB-36 DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`OB-36 DB tests are pending: ${DATABASE.reason}`);
    });
}

const tag = `OB36-${Date.now().toString(36)}-${process.pid}`;
const fixture = {
    companyA: randomUUID(),
    companyB: randomUUID(),
    blastA: randomUUID(),
    blastB: randomUUID(),
    conflictTargetA: randomUUID(),
    conflictOtherA: randomUUID(),
    foreignB: randomUUID(),
    sharedIdentity: randomUUID(),
};

async function snapshot(userId, companyId) {
    const { rows } = await db.query(
        `SELECT jsonb_build_object(
            'user', to_jsonb(u),
            'membership', to_jsonb(m),
            'profile', to_jsonb(p)
         )::TEXT AS bytes
         FROM crm_users u
         JOIN company_memberships m
           ON m.user_id = u.id
          AND m.company_id = $2
         LEFT JOIN company_user_profiles p ON p.membership_id = m.id
         WHERE u.id = $1`,
        [userId, companyId]
    );
    return rows[0]?.bytes;
}

beforeAll(async () => {
    if (!DATABASE.ready) return;

    await db.query(
        `INSERT INTO companies (id, name, slug, status)
         VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
        [
            fixture.companyA, `${tag} Company A`, `${tag.toLowerCase()}-a`,
            fixture.companyB, `${tag} Company B`, `${tag.toLowerCase()}-b`,
        ]
    );
    await db.query(
        `INSERT INTO crm_users (id, keycloak_sub, email, full_name, role, company_id)
         VALUES
            ($1, $2, $3, 'Blast A', 'company_member', $4),
            ($5, $6, $3, 'Blast B', 'company_member', $7),
            ($8, $9, $10, 'Conflict Target A', 'company_member', $4),
            ($11, $12, $13, 'Conflict Other A', 'company_member', $4),
            ($14, $15, $16, 'Foreign B', 'company_member', $7),
            ($17, $18, $19, 'Shared Identity', 'company_member', $4)`,
        [
            fixture.blastA, `${tag}-blast-a`, `${tag}-shared@example.test`, fixture.companyA,
            fixture.blastB, `${tag}-blast-b`, fixture.companyB,
            fixture.conflictTargetA, `${tag}-conflict-target`, `${tag}-target@example.test`,
            fixture.conflictOtherA, `${tag}-conflict-other`, `${tag}-taken@example.test`,
            fixture.foreignB, `${tag}-foreign-b`, `${tag}-foreign@example.test`,
            fixture.sharedIdentity, `${tag}-shared-identity`, `${tag}-multi@example.test`,
        ]
    );
    await db.query(
        `INSERT INTO company_memberships (user_id, company_id, role, role_key, status)
         VALUES
            ($1, $2, 'company_member', 'dispatcher', 'active'),
            ($3, $4, 'company_member', 'dispatcher', 'active'),
            ($5, $2, 'company_member', 'dispatcher', 'active'),
            ($6, $2, 'company_member', 'dispatcher', 'active'),
            ($7, $4, 'company_member', 'dispatcher', 'active'),
            ($8, $2, 'company_member', 'dispatcher', 'active'),
            ($8, $4, 'company_member', 'dispatcher', 'active')`,
        [
            fixture.blastA, fixture.companyA,
            fixture.blastB, fixture.companyB,
            fixture.conflictTargetA,
            fixture.conflictOtherA,
            fixture.foreignB,
            fixture.sharedIdentity,
        ]
    );
    await db.query(
        `INSERT INTO company_user_profiles (membership_id, phone)
         SELECT id, CASE company_id
             WHEN $1 THEN '+1 617 555 0100'
             ELSE '+1 617 555 0200'
         END
         FROM company_memberships
         WHERE user_id = ANY($2::UUID[])`,
        [
            fixture.companyA,
            [
                fixture.blastA,
                fixture.blastB,
                fixture.conflictTargetA,
                fixture.conflictOtherA,
                fixture.foreignB,
                fixture.sharedIdentity,
            ],
        ]
    );
});

afterAll(async () => {
    if (DATABASE.ready) {
        const userIds = [
            fixture.blastA,
            fixture.blastB,
            fixture.conflictTargetA,
            fixture.conflictOtherA,
            fixture.foreignB,
            fixture.sharedIdentity,
        ];
        await db.query('DELETE FROM company_memberships WHERE user_id = ANY($1::UUID[])', [userIds]);
        await db.query('DELETE FROM crm_users WHERE id = ANY($1::UUID[])', [userIds]);
        await db.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [[
            fixture.companyA,
            fixture.companyB,
        ]]);
    }
    await db.pool.end();
});

describe('OB-36 real PostgreSQL tenant and uniqueness contract', () => {
    databaseTest('T-own/T-blast: A identity+phone update leaves same-email B byte-unchanged', async () => {
        const beforeB = await snapshot(fixture.blastB, fixture.companyB);

        const changes = await userService.updateMembershipAndProfile(
            fixture.blastA,
            fixture.companyA,
            {
                full_name: 'Blast A Renamed',
                email: `${tag}-renamed@example.test`.toLowerCase(),
                profile: { phone: '+1 617 555 0199' },
                expected_email: `${tag}-shared@example.test`.toLowerCase(),
            }
        );

        expect(changes.user).toEqual({
            email: `${tag}-renamed@example.test`.toLowerCase(),
            full_name: 'Blast A Renamed',
            phone: '+1 617 555 0199',
        });

        const staleTokenResult = await userService.findOrCreateUser({
            sub: `${tag}-blast-a`,
            email: `${tag}-shared@example.test`.toLowerCase(),
            name: 'Blast A',
            realm_roles: ['company_member'],
            issued_at: Math.floor(Date.now() / 1000) - 3600,
        });
        expect(staleTokenResult).toMatchObject({
            email: `${tag}-renamed@example.test`.toLowerCase(),
            full_name: 'Blast A Renamed',
        });
        expect(await snapshot(fixture.blastB, fixture.companyB)).toStrictEqual(beforeB);
    });

    databaseTest('T-foreign: a B member addressed through A is 404-equivalent and byte-unchanged', async () => {
        const beforeB = await snapshot(fixture.foreignB, fixture.companyB);

        await expect(userService.updateMembershipAndProfile(
            fixture.foreignB,
            fixture.companyA,
            { full_name: 'Should Not Change', profile: { phone: '+1 617 555 0999' } }
        )).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' });

        expect(await snapshot(fixture.foreignB, fixture.companyB)).toStrictEqual(beforeB);
    });

    databaseTest('email uniqueness rejects another member in the same company with no partial write', async () => {
        const before = await snapshot(fixture.conflictTargetA, fixture.companyA);

        await expect(userService.updateMembershipAndProfile(
            fixture.conflictTargetA,
            fixture.companyA,
            {
                full_name: 'Must Roll Back Too',
                email: `${tag}-taken@example.test`.toLowerCase(),
                profile: { phone: '+1 617 555 0999' },
            }
        )).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });

        expect(await snapshot(fixture.conflictTargetA, fixture.companyA)).toStrictEqual(before);
    });

    databaseTest('shared global identity cannot be renamed, but A phone remains membership-local', async () => {
        const beforeB = await snapshot(fixture.sharedIdentity, fixture.companyB);

        await expect(userService.updateMembershipAndProfile(
            fixture.sharedIdentity,
            fixture.companyA,
            { full_name: 'Cross Tenant Rename' }
        )).rejects.toMatchObject({ code: 'SHARED_IDENTITY_REQUIRES_PLATFORM_ADMIN' });

        const phoneOnly = await userService.updateMembershipAndProfile(
            fixture.sharedIdentity,
            fixture.companyA,
            { profile: { phone: '+1 617 555 0188' } }
        );
        expect(phoneOnly.user.phone).toBe('+1 617 555 0188');

        await userService.updateMembershipAndProfile(
            fixture.sharedIdentity,
            fixture.companyA,
            { role_key: 'manager' }
        );
        expect(await snapshot(fixture.sharedIdentity, fixture.companyB)).toStrictEqual(beforeB);
    });
});
