'use strict';

const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const avatarsService = require('../backend/src/services/avatarsService');

jest.setTimeout(90000);

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
    test('AVATARS Phase C DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`AVATARS Phase C DB tests are pending: ${DATABASE.reason}`);
    });
}

const fixture = {
    companyA: randomUUID(),
    companyB: randomUUID(),
    selfA: null,
    otherA: null,
    disconnectedA: null,
    noAvatarA: null,
    ownerB: null,
    installationA: null,
    installationB: null,
    bindingSelfA: null,
    bindingOtherA: null,
    bindingDisconnectedA: null,
    bindingB: null,
};

async function provision(client, companyId, installationId, ownerUserId) {
    return require('../backend/src/services/chatgptMcpIdentityService').provisionAvatar({
        companyId,
        installationId,
        ownerUserId,
        actorId: ownerUserId,
    }, client);
}

async function setInstallationStatus(companyId, status) {
    await db.query(
        `UPDATE marketplace_installations
         SET status=$2, updated_at=NOW()
         WHERE company_id=$1 AND id IN ($3,$4)`,
        [companyId, status, fixture.installationA, fixture.installationB]
    );
}

async function snapshotCompany(companyId) {
    const { rows } = await db.query(
        `SELECT
            (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
             FROM chatgpt_mcp_bindings x
             WHERE x.company_id=$1) AS bindings,
            (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
             FROM mcp_agent_permission_grants x
             WHERE x.company_id=$1) AS grants,
            (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
             FROM crm_users x
             WHERE x.company_id=$1) AS users,
            (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
             FROM marketplace_installations x
             WHERE x.company_id=$1) AS installations`,
        [companyId]
    );
    return rows[0];
}

beforeAll(async () => {
    if (!DATABASE.ready) return;
    const oldIssuer = process.env.KEYCLOAK_REALM_URL;
    const oldClientId = process.env.CHATGPT_MCP_CLIENT_ID;
    fixture.oldIssuer = oldIssuer;
    fixture.oldClientId = oldClientId;
    process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';
    process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO companies (id,name,slug,status,timezone)
             VALUES
                ($1,'Avatar Roster A',$2,'active','America/New_York'),
                ($3,'Avatar Roster B',$4,'active','America/Chicago')`,
            [
                fixture.companyA,
                `avatar-roster-a-${fixture.companyA}`,
                fixture.companyB,
                `avatar-roster-b-${fixture.companyB}`,
            ]
        );
        const humans = await client.query(
            `INSERT INTO crm_users
                (keycloak_sub,email,full_name,role,status,company_id,
                 platform_role,onboarding_status,kind)
             VALUES
                ($1,$2,'Roster Shared Owner','company_member','active',$3,'none','active','user'),
                ($4,$5,'Roster Other A','company_member','active',$3,'none','active','user'),
                ($6,$7,'Roster Disconnected A','company_member','active',$3,'none','active','user'),
                ($8,$9,'Roster No Avatar A','company_member','active',$3,'none','active','user'),
                ($10,$11,'Roster Shared Owner','company_member','active',$12,'none','active','user')
             RETURNING id,company_id,keycloak_sub,full_name`,
            [
                `avatar-roster-self-a-${fixture.companyA}`,
                `avatar-roster-self-a-${fixture.companyA}@example.test`,
                fixture.companyA,
                `avatar-roster-other-a-${fixture.companyA}`,
                `avatar-roster-other-a-${fixture.companyA}@example.test`,
                `avatar-roster-disconnected-a-${fixture.companyA}`,
                `avatar-roster-disconnected-a-${fixture.companyA}@example.test`,
                `avatar-roster-no-avatar-a-${fixture.companyA}`,
                `avatar-roster-no-avatar-a-${fixture.companyA}@example.test`,
                `avatar-roster-owner-b-${fixture.companyB}`,
                `avatar-roster-owner-b-${fixture.companyB}@example.test`,
                fixture.companyB,
            ]
        );
        const bySubject = new Map(humans.rows.map((row) => [row.keycloak_sub, row]));
        fixture.selfA = bySubject.get(`avatar-roster-self-a-${fixture.companyA}`);
        fixture.otherA = bySubject.get(`avatar-roster-other-a-${fixture.companyA}`);
        fixture.disconnectedA = bySubject.get(
            `avatar-roster-disconnected-a-${fixture.companyA}`
        );
        fixture.noAvatarA = bySubject.get(`avatar-roster-no-avatar-a-${fixture.companyA}`);
        fixture.ownerB = bySubject.get(`avatar-roster-owner-b-${fixture.companyB}`);

        await client.query(
            `INSERT INTO company_memberships
                (user_id,company_id,role,role_key,status)
             VALUES
                ($1,$6,'company_member','dispatcher','active'),
                ($2,$6,'company_member','provider','active'),
                ($3,$6,'company_member','manager','active'),
                ($4,$6,'company_member','dispatcher','active'),
                ($5,$7,'company_member','dispatcher','active')`,
            [
                fixture.selfA.id,
                fixture.otherA.id,
                fixture.disconnectedA.id,
                fixture.noAvatarA.id,
                fixture.ownerB.id,
                fixture.companyA,
                fixture.companyB,
            ]
        );
        await client.query(
            `INSERT INTO company_role_configs
                (company_id,role_key,display_name,is_locked)
             VALUES
                ($1,'dispatcher','Dispatcher',true),
                ($1,'provider','Provider',true),
                ($1,'manager','Manager',true),
                ($2,'dispatcher','Dispatcher',true)`,
            [fixture.companyA, fixture.companyB]
        );

        const app = await client.query(
            `SELECT id
             FROM marketplace_apps
             WHERE app_key='chatgpt-crm-mcp' AND status='published'`
        );
        if (app.rows.length !== 1) {
            throw new Error('Published chatgpt-crm-mcp marketplace app is required.');
        }
        const installations = await client.query(
            `INSERT INTO marketplace_installations
                (company_id,app_id,status,installed_by,installed_at)
             VALUES
                ($1,$3,'connected',$4,NOW()),
                ($2,$3,'connected',$5,NOW())
             RETURNING id,company_id`,
            [
                fixture.companyA,
                fixture.companyB,
                app.rows[0].id,
                fixture.selfA.id,
                fixture.ownerB.id,
            ]
        );
        fixture.installationA = installations.rows.find(
            (row) => row.company_id === fixture.companyA
        ).id;
        fixture.installationB = installations.rows.find(
            (row) => row.company_id === fixture.companyB
        ).id;

        const own = await provision(
            client,
            fixture.companyA,
            fixture.installationA,
            fixture.selfA.id
        );
        const other = await provision(
            client,
            fixture.companyA,
            fixture.installationA,
            fixture.otherA.id
        );
        const disconnected = await provision(
            client,
            fixture.companyA,
            fixture.installationA,
            fixture.disconnectedA.id
        );
        const foreign = await provision(
            client,
            fixture.companyB,
            fixture.installationB,
            fixture.ownerB.id
        );
        fixture.bindingSelfA = own.binding;
        fixture.bindingOtherA = other.binding;
        fixture.bindingDisconnectedA = disconnected.binding;
        fixture.bindingB = foreign.binding;

        await client.query(
            `INSERT INTO mcp_tool_invocations
                (company_id,binding_id,created_by,authorized_by_user_id,
                 tool_name,stage,request_id,confirmation_class,status,
                 safe_metadata,started_at,completed_at)
             VALUES
                ($1,$2,$3,$4,'svc.list_jobs','S1','avatar-roster-active',
                 'R','succeeded','{}'::jsonb,NOW()-INTERVAL '10 minutes',NOW()),
                ($1,$5,$6,$7,'svc.list_jobs','S1','avatar-roster-idle',
                 'R','succeeded','{}'::jsonb,NOW()-INTERVAL '16 minutes',NOW()),
                ($8,$9,$10,$11,'svc.list_jobs','S1','avatar-roster-foreign',
                 'R','succeeded','{}'::jsonb,NOW()-INTERVAL '1 minute',NOW())`,
            [
                fixture.companyA,
                own.binding.id,
                own.aiUser.id,
                fixture.selfA.id,
                other.binding.id,
                other.aiUser.id,
                fixture.otherA.id,
                fixture.companyB,
                foreign.binding.id,
                foreign.aiUser.id,
                fixture.ownerB.id,
            ]
        );
        await require('../backend/src/services/chatgptMcpIdentityService').revokeAvatar({
            companyId: fixture.companyA,
            ownerUserId: fixture.disconnectedA.id,
            actorId: fixture.disconnectedA.id,
        }, client);
        await client.query(
            `UPDATE crm_users
             SET full_name='Roster Self A (Live)'
             WHERE id=$1 AND company_id=$2`,
            [fixture.selfA.id, fixture.companyA]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
});

describe('AVATARS-001 Phase C roster and self-service tenancy', () => {
    databaseTest('GET contract uses live names, exact public fields, presence threshold, and T-blast isolation', async () => {
        const overview = await avatarsService.getOverview(
            fixture.companyA,
            fixture.selfA.id
        );
        expect(overview.installation_enabled).toBe(true);
        expect(overview.me).toEqual({
            connected: true,
            base: 'chatgpt',
            mode: 'mcp',
            writes_enabled: false,
            sends_enabled: false,
        });
        expect(overview.roster).toHaveLength(3);
        for (const row of overview.roster) {
            expect(Object.keys(row).sort()).toEqual([
                'base',
                'connection_status',
                'is_me',
                'owner_name',
                'owner_user_id',
                'presence',
            ]);
            expect(JSON.stringify(row)).not.toMatch(
                /email|keycloak|sub|permission|tool_name|svc\.list_jobs/
            );
        }
        expect(overview.roster).toEqual(expect.arrayContaining([
            {
                owner_user_id: fixture.selfA.id,
                owner_name: 'Roster Self A (Live)',
                base: 'chatgpt',
                connection_status: 'connected',
                presence: 'active',
                is_me: true,
            },
            {
                owner_user_id: fixture.otherA.id,
                owner_name: 'Roster Other A',
                base: 'chatgpt',
                connection_status: 'connected',
                presence: 'idle',
                is_me: false,
            },
            {
                owner_user_id: fixture.disconnectedA.id,
                owner_name: 'Roster Disconnected A',
                base: 'chatgpt',
                connection_status: 'disconnected',
                presence: 'idle',
                is_me: false,
            },
        ]));
        expect(overview.roster.map((row) => row.owner_user_id))
            .not.toContain(fixture.ownerB.id);
        expect(overview.roster.filter((row) => row.owner_name === 'Roster Shared Owner'))
            .toHaveLength(0);

        const memberWithoutAvatar = await avatarsService.getOverview(
            fixture.companyA,
            fixture.noAvatarA.id
        );
        expect(memberWithoutAvatar.me).toBeNull();
        expect(memberWithoutAvatar.roster).toHaveLength(3);
        expect(memberWithoutAvatar.roster.some((row) => row.is_me)).toBe(false);

        await expect(avatarsService.getOverview(
            fixture.companyB,
            fixture.selfA.id
        )).rejects.toMatchObject({
            code: 'AVATAR_MEMBER_REQUIRED',
            httpStatus: 403,
        });
    });

    databaseTest('installation disable is reflected without exposing stale connected presence', async () => {
        await setInstallationStatus(fixture.companyA, 'disconnected');
        try {
            const overview = await avatarsService.getOverview(
                fixture.companyA,
                fixture.selfA.id
            );
            expect(overview.installation_enabled).toBe(false);
            expect(overview.me).toEqual({
                connected: false,
                base: 'chatgpt',
                mode: 'mcp',
                writes_enabled: false,
                sends_enabled: false,
            });
            expect(overview.roster.every(
                (row) => row.connection_status === 'disconnected'
                    && row.presence === 'idle'
            )).toBe(true);
        } finally {
            await setInstallationStatus(fixture.companyA, 'connected');
        }
    });

    databaseTest('self-consent changes only the actor binding and preserves the foreign tenant byte-for-byte', async () => {
        const beforeB = await snapshotCompany(fixture.companyB);
        expect(await avatarsService.setWrites(
            fixture.companyA,
            fixture.selfA.id,
            true
        )).toEqual({
            writes_enabled: true,
            sends_enabled: false,
        });
        expect(await avatarsService.setSends(
            fixture.companyA,
            fixture.selfA.id,
            true
        )).toEqual({
            writes_enabled: true,
            sends_enabled: true,
        });
        const bindings = await db.query(
            `SELECT owner_user_id,writes_enabled,sends_enabled
             FROM chatgpt_mcp_bindings
             WHERE company_id=$1 AND status='active'
             ORDER BY owner_user_id`,
            [fixture.companyA]
        );
        expect(bindings.rows.find(
            (row) => row.owner_user_id === fixture.selfA.id
        )).toMatchObject({
            writes_enabled: true,
            sends_enabled: true,
        });
        expect(bindings.rows.find(
            (row) => row.owner_user_id === fixture.otherA.id
        )).toMatchObject({
            writes_enabled: false,
            sends_enabled: false,
        });
        expect(await snapshotCompany(fixture.companyB)).toStrictEqual(beforeB);

        await avatarsService.setSends(fixture.companyA, fixture.selfA.id, false);
        await avatarsService.setWrites(fixture.companyA, fixture.selfA.id, false);
    });

    databaseTest('connect is installation-gated, idempotent, and read-only by default', async () => {
        await setInstallationStatus(fixture.companyA, 'disconnected');
        try {
            await expect(avatarsService.connectSelf(
                fixture.companyA,
                fixture.noAvatarA.id
            )).rejects.toMatchObject({
                code: 'AVATARS_NOT_ENABLED',
                httpStatus: 409,
            });
            const absent = await db.query(
                `SELECT COUNT(*)::int AS count
                 FROM chatgpt_mcp_bindings
                 WHERE company_id=$1 AND owner_user_id=$2 AND status='active'`,
                [fixture.companyA, fixture.noAvatarA.id]
            );
            expect(absent.rows[0].count).toBe(0);
        } finally {
            await setInstallationStatus(fixture.companyA, 'connected');
        }

        const first = await avatarsService.connectSelf(
            fixture.companyA,
            fixture.noAvatarA.id
        );
        const replay = await avatarsService.connectSelf(
            fixture.companyA,
            fixture.noAvatarA.id
        );
        expect(first).toEqual({
            connected: true,
            base: 'chatgpt',
            mode: 'mcp',
            writes_enabled: false,
            sends_enabled: false,
        });
        expect(replay).toStrictEqual(first);
        const active = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM chatgpt_mcp_bindings
             WHERE company_id=$1 AND owner_user_id=$2 AND status='active'`,
            [fixture.companyA, fixture.noAvatarA.id]
        );
        expect(active.rows[0].count).toBe(1);
    });

    databaseTest('self-disconnect is idempotent, self-only, and T-blast safe', async () => {
        const beforeB = await snapshotCompany(fixture.companyB);
        expect(await avatarsService.disconnectSelf(
            fixture.companyA,
            fixture.selfA.id
        )).toEqual({ connected: false });
        expect(await avatarsService.disconnectSelf(
            fixture.companyA,
            fixture.selfA.id
        )).toEqual({ connected: false });
        const states = await db.query(
            `SELECT owner_user_id,status
             FROM chatgpt_mcp_bindings
             WHERE company_id=$1
               AND owner_user_id IN ($2,$3)
             ORDER BY owner_user_id,status`,
            [fixture.companyA, fixture.selfA.id, fixture.otherA.id]
        );
        expect(states.rows).toEqual(expect.arrayContaining([
            { owner_user_id: fixture.selfA.id, status: 'revoked' },
            { owner_user_id: fixture.otherA.id, status: 'active' },
        ]));
        expect(await snapshotCompany(fixture.companyB)).toStrictEqual(beforeB);

        await avatarsService.connectSelf(fixture.companyA, fixture.selfA.id);
    });
});

afterAll(async () => {
    if (DATABASE.ready) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `DELETE FROM marketplace_installation_events
                 WHERE company_id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query(
                `DELETE FROM mcp_tool_invocations
                 WHERE company_id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query(
                `DELETE FROM mcp_tool_idempotency
                 WHERE company_id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query(
                `DELETE FROM mcp_agent_permission_grants
                 WHERE company_id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query(
                `DELETE FROM chatgpt_mcp_bindings
                 WHERE company_id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query(
                `DELETE FROM marketplace_installations
                 WHERE company_id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query(
                `DELETE FROM company_memberships
                 WHERE company_id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query(
                `DELETE FROM crm_users
                 WHERE company_id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query(
                `DELETE FROM companies
                 WHERE id IN ($1,$2)`,
                [fixture.companyA, fixture.companyB]
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        if (fixture.oldIssuer === undefined) delete process.env.KEYCLOAK_REALM_URL;
        else process.env.KEYCLOAK_REALM_URL = fixture.oldIssuer;
        if (fixture.oldClientId === undefined) delete process.env.CHATGPT_MCP_CLIENT_ID;
        else process.env.CHATGPT_MCP_CLIENT_ID = fixture.oldClientId;
    }
    try { await db.pool.end(); } catch { /* ignore */ }
});
