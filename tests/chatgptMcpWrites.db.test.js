'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const marketplaceService = require('../backend/src/services/marketplaceService');
const permissions = require('../backend/src/services/chatgptMcpPermissions');
const registry = require('../backend/src/services/agentSkillsMcpRegistry');
const protocol = require('../backend/src/services/agentSkillsMcpProtocolService');
const executor = require('../backend/src/services/agentSkillsMcpExecutor');
const estimatesService = require('../backend/src/services/estimatesService');
const invoicesService = require('../backend/src/services/invoicesService');

const AVATARS = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '200_avatars_per_user_identity.sql'),
    'utf8'
);
const ROLE_SEED = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '050_seed_role_configs.sql'),
    'utf8'
);

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
    test('ChatGPT MCP S2a write DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`ChatGPT MCP S2a write DB tests are pending: ${DATABASE.reason}`);
    });
}

const state = {};
const oldIssuer = process.env.KEYCLOAK_REALM_URL;
const oldClientId = process.env.CHATGPT_MCP_CLIENT_ID;

function workflow(machineKey) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:blanc="https://albusto.com/fsm"
       initial="submitted"
       blanc:machine="${machineKey}">
  <state id="submitted" blanc:label="Submitted" blanc:statusName="Submitted">
    <transition event="advance" target="review"
                blanc:action="true" blanc:label="Advance"
                blanc:roles="tenant_admin, manager, dispatcher, provider" />
  </state>
  <final id="review" blanc:label="Review" blanc:statusName="Review" />
</scxml>`;
}

async function seedWorkflow(client, companyId, machineKey) {
    const machine = await client.query(
        `INSERT INTO fsm_machines (company_id, machine_key, title)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [companyId, machineKey, `${machineKey} test workflow`]
    );
    const version = await client.query(
        `INSERT INTO fsm_versions
            (machine_id, company_id, version_number, status, scxml_source, published_by, published_at)
         VALUES ($1, $2, 1, 'published', $3, 's2a-test', NOW())
         RETURNING id`,
        [machine.rows[0].id, companyId, workflow(machineKey)]
    );
    await client.query(
        `UPDATE fsm_machines
         SET active_version_id = $1
         WHERE id = $2 AND company_id = $3`,
        [version.rows[0].id, machine.rows[0].id, companyId]
    );
}

async function setup() {
    process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';
    process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
    state.companyA = randomUUID();
    state.companyB = randomUUID();
    state.sharedPhone = `+1555${String(Date.now()).slice(-7)}`;
    state.sharedEmail = `s2a-shared-${Date.now()}@example.test`;

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(AVATARS);
        await client.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'S2a Tenant A', $2, 'active', 'America/New_York'),
                    ($3, 'S2a Tenant B', $4, 'active', 'America/Chicago')`,
            [
                state.companyA,
                `s2a-a-${state.companyA}`,
                state.companyB,
                `s2a-b-${state.companyB}`,
            ]
        );
        await client.query(ROLE_SEED);
        const humans = await client.query(
            `INSERT INTO crm_users
                (keycloak_sub, email, full_name, role, status, company_id,
                 platform_role, onboarding_status, kind)
             VALUES
                ($1,$2,'S2a Admin A','company_member','active',$3,'none','active','user'),
                ($4,$5,'S2a Admin B','company_member','active',$6,'none','active','user')
             RETURNING id, keycloak_sub, company_id`,
            [
                `s2a-human-a-${state.companyA}`,
                `s2a-a-${state.companyA}@example.test`,
                state.companyA,
                `s2a-human-b-${state.companyB}`,
                `s2a-b-${state.companyB}@example.test`,
                state.companyB,
            ]
        );
        state.humanA = humans.rows.find((row) => row.company_id === state.companyA);
        state.humanB = humans.rows.find((row) => row.company_id === state.companyB);
        await client.query(
            `INSERT INTO company_memberships (user_id, company_id, role, role_key, status)
             VALUES
                ($1,$2,'company_admin','tenant_admin','active'),
                ($3,$4,'company_admin','tenant_admin','active')`,
            [state.humanA.id, state.companyA, state.humanB.id, state.companyB]
        );
        // A prod-shaped DB carries the LAST_ADMIN_REQUIRED guard, so the consent
        // The prod-shaped LAST_ADMIN_REQUIRED trigger needs a second admin
        // while this test proves the avatar owner's self-consent survives a
        // role change. That second admin must not control the owner's tiers.
        const spareAdmin = await client.query(
            `INSERT INTO crm_users
                (keycloak_sub, email, full_name, role, status, company_id,
                 platform_role, onboarding_status, kind)
             VALUES ($1,$2,'S2a Admin A2','company_member','active',$3,'none','active','user')
             RETURNING id`,
            [
                `s2a-human-a2-${state.companyA}`,
                `s2a-a2-${state.companyA}@example.test`,
                state.companyA,
            ]
        );
        await client.query(
            `INSERT INTO company_memberships (user_id, company_id, role, role_key, status)
             VALUES ($1,$2,'company_admin','tenant_admin','active')`,
            [spareAdmin.rows[0].id, state.companyA]
        );
        state.spareAdminA = spareAdmin.rows[0];
        const app = await client.query(
            `SELECT id FROM marketplace_apps
             WHERE app_key = 'chatgpt-crm-mcp' AND status = 'published'`
        );
        const installations = await client.query(
            `INSERT INTO marketplace_installations
                (company_id, app_id, status, installed_by, installed_at)
             VALUES ($1,$3,'connected',$4,NOW()), ($2,$3,'connected',$5,NOW())
             RETURNING id, company_id`,
            [state.companyA, state.companyB, app.rows[0].id, state.humanA.id, state.humanB.id]
        );
        state.installA = installations.rows.find((row) => row.company_id === state.companyA);
        state.installB = installations.rows.find((row) => row.company_id === state.companyB);
        state.identityA = await identityService.provisionInstallation({
            companyId: state.companyA,
            installationId: state.installA.id,
            actorId: state.humanA.id,
        }, client);
        state.identityB = await identityService.provisionInstallation({
            companyId: state.companyB,
            installationId: state.installB.id,
            actorId: state.humanB.id,
        }, client);

        // contacts.email carries a GLOBAL unique index (uq_contacts_email), so the
        // column itself cannot repeat across tenants. The shared-email natural-key
        // collision is preserved through contact_emails below, whose uniqueness is
        // per-contact only — same lesson as the S1 tenancy suite.
        const contacts = await client.query(
            `INSERT INTO contacts
                (company_id, full_name, first_name, last_name, phone_e164, email)
             VALUES
                ($1,'Shared Person','Shared','Person',$3,$4),
                ($2,'Shared Person','Shared','Person',$3,$5)
             RETURNING id, company_id`,
            [
                state.companyA,
                state.companyB,
                state.sharedPhone,
                `s2a-contact-a-${state.companyA}@example.test`,
                `s2a-contact-b-${state.companyB}@example.test`,
            ]
        );
        state.contactA = Number(contacts.rows.find((row) => row.company_id === state.companyA).id);
        state.contactB = Number(contacts.rows.find((row) => row.company_id === state.companyB).id);
        await client.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             SELECT c.id, $3, LOWER($3), true
             FROM contacts c
             WHERE (c.id=$1 AND c.company_id=$4) OR (c.id=$2 AND c.company_id=$5)`,
            [state.contactA, state.contactB, state.sharedEmail, state.companyA, state.companyB]
        );
        const leads = await client.query(
            `INSERT INTO leads
                (company_id, uuid, status, first_name, last_name, phone, email,
                 contact_id, comments, structured_notes)
             VALUES
                ($1,$3,'Submitted','Shared','Person',$5,$6,$7,'A-before','[]'::jsonb),
                ($2,$4,'Submitted','Shared','Person',$5,$6,$8,'B-before','[]'::jsonb)
             RETURNING id, uuid, company_id`,
            [
                state.companyA,
                state.companyB,
                `A${String(Date.now()).slice(-8)}`,
                `B${String(Date.now()).slice(-8)}`,
                state.sharedPhone,
                state.sharedEmail,
                state.contactA,
                state.contactB,
            ]
        );
        state.leadA = leads.rows.find((row) => row.company_id === state.companyA);
        state.leadB = leads.rows.find((row) => row.company_id === state.companyB);
        const jobs = await client.query(
            `INSERT INTO jobs
                (company_id, contact_id, blanc_status, zb_status, customer_name,
                 customer_phone, customer_email, service_name, description, notes, zb_raw)
             VALUES
                ($1,$3,'Submitted','scheduled','Shared Person',$5,$6,'A service','A-before','[]'::jsonb,'{}'::jsonb),
                ($2,$4,'Submitted','scheduled','Shared Person',$5,$6,'B service','B-before','[]'::jsonb,'{}'::jsonb)
             RETURNING id, company_id`,
            [
                state.companyA,
                state.companyB,
                state.contactA,
                state.contactB,
                state.sharedPhone,
                state.sharedEmail,
            ]
        );
        state.jobA = Number(jobs.rows.find((row) => row.company_id === state.companyA).id);
        state.jobB = Number(jobs.rows.find((row) => row.company_id === state.companyB).id);
        await seedWorkflow(client, state.companyA, 'lead');
        await seedWorkflow(client, state.companyA, 'job');
        await seedWorkflow(client, state.companyB, 'lead');
        await seedWorkflow(client, state.companyB, 'job');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function snapshotCompany(companyId) {
    const { rows } = await db.query(
        `SELECT
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]')
             FROM contacts x WHERE x.company_id=$1) AS contacts,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]')
             FROM leads x WHERE x.company_id=$1) AS leads,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]')
             FROM jobs x WHERE x.company_id=$1) AS jobs,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ce) ORDER BY ce.id), '[]')
             FROM contact_emails ce
             JOIN contacts c ON c.id=ce.contact_id AND c.company_id=$1
             WHERE c.company_id=$1) AS contact_emails,
            (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]')
             FROM estimates e WHERE e.company_id=$1) AS estimates,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ei) ORDER BY ei.id), '[]')
             FROM estimate_items ei
             JOIN estimates e ON e.id=ei.estimate_id AND e.company_id=$1
             WHERE e.company_id=$1) AS estimate_items,
            (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]')
             FROM invoices i WHERE i.company_id=$1) AS invoices,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ii) ORDER BY ii.id), '[]')
             FROM invoice_items ii
             JOIN invoices i ON i.id=ii.invoice_id AND i.company_id=$1
             WHERE i.company_id=$1) AS invoice_items,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ee) ORDER BY ee.id), '[]')
             FROM estimate_events ee
             JOIN estimates e ON e.id=ee.estimate_id AND e.company_id=$1
             WHERE e.company_id=$1) AS estimate_events,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ie) ORDER BY ie.id), '[]')
             FROM invoice_events ie
             JOIN invoices i ON i.id=ie.invoice_id AND i.company_id=$1
             WHERE i.company_id=$1) AS invoice_events`,
        [companyId]
    );
    return JSON.stringify(rows[0]);
}

function writeContext(resolved) {
    return {
        companyId: resolved.company_id,
        actorId: resolved.ai_user_id,
        actorName: resolved.ai_full_name,
        authorizerId: resolved.authorized_by_user_id,
        ownerUserId: resolved.owner_user_id,
        bindingId: resolved.binding_id,
        oauthScopes: [permissions.READ_SCOPE, permissions.WRITE_SCOPE],
        permissions: resolved.permissions,
        requestId: `s2a-${randomUUID()}`,
    };
}

function protocolRequest(resolved, oauthScopes = [permissions.READ_SCOPE, permissions.WRITE_SCOPE]) {
    return {
        companyFilter: { company_id: resolved.company_id },
        user: {
            kind: 'agent',
            oauthAuthorizerId: resolved.authorized_by_user_id,
            avatarOwnerId: resolved.owner_user_id,
            crmUser: {
                id: resolved.ai_user_id,
                full_name: resolved.ai_full_name,
            },
        },
        authz: {
            permissions: resolved.permissions,
            oauthScopes,
            company: { timezone: 'America/New_York' },
            avatarOwner: {
                id: resolved.owner_user_id,
                role_key: resolved.owner_role_key,
                scopes: resolved.owner_scopes,
            },
        },
        chatgptMcpBinding: {
            id: resolved.binding_id,
            authorizerId: resolved.authorized_by_user_id,
            ownerUserId: resolved.owner_user_id,
        },
        requestId: `s2a-protocol-${randomUUID()}`,
    };
}

function requiredValue(name, schema) {
    if (schema.enum) return schema.enum[0];
    if (schema.type === 'integer' || schema.type === 'number') return Math.max(1, schema.minimum || 1);
    if (schema.type === 'boolean') return true;
    if (schema.type === 'array') {
        return schema.minItems > 0 ? [requiredValue(`${name}_item`, schema.items)] : [];
    }
    if (schema.type === 'object') {
        return Object.fromEntries(
            (schema.required || []).map((key) => [
                key,
                requiredValue(key, schema.properties[key]),
            ])
        );
    }
    if (name === 'action') return 'advance';
    if (name === 'parent_id') return '1';
    if (schema.format === 'date') return '2026-07-24';
    return `${name}-value`;
}

function validArgumentsFor(tool) {
    return Object.fromEntries(
        (tool.inputSchema.required || []).map((key) => [
            key,
            requiredValue(key, tool.inputSchema.properties[key]),
        ])
    );
}

function expectedAvatarTool(tool, resolved) {
    const granted = new Set(resolved.owner_permissions || []);
    let required;
    let any = [];
    if (tool.name === 'svc.list_entity_tasks') {
        required = ['tasks.view'];
        any = ['jobs.view', 'leads.view'];
    } else if (tool.name === 'svc.add_note') {
        required = [];
        any = ['jobs.edit', 'leads.edit', 'contacts.edit'];
    } else {
        required = permissions.READ_TOOL_PERMISSIONS[tool.name]
            || permissions.WRITE_TOOL_PERMISSIONS[tool.name]
            || permissions.SEND_TOOL_PERMISSIONS[tool.name]
            || [];
    }
    const permissionAllowed = required.every((key) => granted.has(key))
        && (any.length === 0 || any.some((key) => granted.has(key)));
    const tierAllowed = permissions.READ_TOOL_PERMISSIONS[tool.name]
        || (permissions.WRITE_TOOL_PERMISSIONS[tool.name] && resolved.writes_enabled === true)
        || (permissions.SEND_TOOL_PERMISSIONS[tool.name] && resolved.sends_enabled === true);
    return Boolean(permissionAllowed && tierAllowed);
}

async function setConsent(enabled) {
    return marketplaceService.setChatgptMcpWrites(
        state.companyA,
        state.humanA.id,
        enabled,
        { requestId: `consent-${randomUUID()}` }
    );
}

async function resolveA() {
    return identityService.resolveOAuthContext({
        issuer: process.env.KEYCLOAK_REALM_URL,
        subject: state.humanA.keycloak_sub,
        clientId: process.env.CHATGPT_MCP_CLIENT_ID,
    });
}

async function invokeDirect(context, name, args, options) {
    return executor._dispatchDispatcherWrite(registry.getTool(name), context, args, options);
}

async function invoke(resolved, name, args) {
    return executor.execute(
        protocolRequest(resolved),
        name,
        args,
        { confirmed: true, confirmation_id: `confirmed-${randomUUID()}` }
    );
}

beforeAll(async () => {
    if (DATABASE.ready) await setup();
});

describe('CHATGPT-CRM-MCP S2a real-PostgreSQL consent and race contract', () => {
    databaseTest('consent is owner-only, idempotent, and filters 19 → 30 → 19 tools', async () => {
        let resolved = await resolveA();
        let response = await protocol.handleJsonRpc(protocolRequest(resolved), {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
        });
        expect(response.result.tools).toHaveLength(19);

        await expect(marketplaceService.setChatgptMcpWrites(
            state.companyA,
            state.spareAdminA.id,
            true,
            { requestId: `foreign-consent-${randomUUID()}` }
        )).rejects.toMatchObject({
            code: 'MCP_BINDING_INVALID',
            httpStatus: 403,
        });
        await db.query(
            `UPDATE company_memberships
             SET role='company_member', role_key='manager'
             WHERE user_id=$1 AND company_id=$2`,
            [state.humanA.id, state.companyA]
        );
        await expect(setConsent(true)).resolves.toMatchObject({
            enabled: true,
            grant_version: 3,
        });
        await expect(identityService.getWriteConsent(state.companyA)).resolves.toEqual({
            writes_enabled: true,
            sends_enabled: false,
            grant_version: 3,
        });
        await expect(setConsent(false)).resolves.toMatchObject({
            enabled: false,
            grant_version: 2,
        });
        await db.query(
            `UPDATE company_memberships
             SET role='company_admin', role_key='tenant_admin'
             WHERE user_id=$1 AND company_id=$2`,
            [state.humanA.id, state.companyA]
        );

        // Settings-surface read used by the connect panel's write toggle.
        await expect(identityService.getWriteConsent(state.companyA)).resolves.toEqual({
            writes_enabled: false,
            sends_enabled: false,
            grant_version: 2,
        });

        await expect(setConsent(true)).resolves.toMatchObject({ enabled: true, grant_version: 3 });
        await expect(setConsent(true)).resolves.toMatchObject({ enabled: true, grant_version: 3 });
        await expect(identityService.getWriteConsent(state.companyA)).resolves.toEqual({
            writes_enabled: true,
            sends_enabled: false,
            grant_version: 3,
        });
        resolved = await resolveA();
        response = await protocol.handleJsonRpc(protocolRequest(resolved), {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
        });
        expect(response.result.tools).toHaveLength(31);
        expect(response.result.tools.filter((tool) => tool.annotations.kind === 'write')).toHaveLength(12);

        await expect(setConsent(false)).resolves.toMatchObject({ enabled: false, grant_version: 2 });
        await expect(setConsent(false)).resolves.toMatchObject({ enabled: false, grant_version: 2 });
        await expect(identityService.getWriteConsent(state.companyA)).resolves.toEqual({
            writes_enabled: false,
            sends_enabled: false,
            grant_version: 2,
        });
        resolved = await resolveA();
        response = await protocol.handleJsonRpc(protocolRequest(resolved), {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/list',
            params: {},
        });
        expect(response.result.tools).toHaveLength(19);
        await setConsent(true);
    });

    databaseTest('SAB-MCP-DISCONNECT-RACE: stale auth followed by disconnect leaves zero rows', async () => {
        const context = writeContext(await resolveA());
        const marker = `race-${randomUUID()}`;
        await expect(invokeDirect(context, 'svc.create_lead', {
            first_name: 'Race',
            last_name: 'Rejected',
            phone: '+16175550199',
            comments: marker,
        }, {
            beforeLiveRecheck: async () => {
                await db.query(
                    `UPDATE marketplace_installations
                     SET status='disconnected'
                     WHERE id=$1 AND company_id=$2`,
                    [state.installA.id, state.companyA]
                );
            },
        })).rejects.toMatchObject({ code: 'MCP_BINDING_INVALID', httpStatus: 403 });
        const persisted = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM leads
             WHERE company_id=$1 AND comments=$2`,
            [state.companyA, marker]
        );
        expect(persisted.rows[0].count).toBe(0);
        await db.query(
            `UPDATE marketplace_installations
             SET status='connected'
             WHERE id=$1 AND company_id=$2`,
            [state.installA.id, state.companyA]
        );

        const active = await invokeDirect(writeContext(await resolveA()), 'svc.create_lead', {
            first_name: 'Race',
            last_name: 'Allowed',
            phone: '+16175550198',
            comments: `${marker}-active`,
        });
        expect(active.lead_uuid).toBeTruthy();
    });
});

describe('CHATGPT-CRM-MCP S2a real-PostgreSQL per-tool tenancy contract', () => {
    databaseTest('T-own / T-foreign / T-blast, idempotency, FSM action-only, and CRM actor hold for all 7 writes', async () => {
        const resolved = await resolveA();
        const cases = [
            {
                name: 'svc.create_lead',
                own: {
                    first_name: 'Shared',
                    last_name: 'Person',
                    phone: state.sharedPhone,
                    email: state.sharedEmail,
                    comments: 'created by A',
                },
                foreign: {
                    contact_id: state.contactB,
                    first_name: 'Foreign',
                    last_name: 'Contact',
                },
            },
            {
                name: 'svc.update_lead',
                own: { lead_uuid: state.leadA.uuid, comments: 'A-updated' },
                foreign: { lead_uuid: state.leadB.uuid, comments: 'must-not-write' },
            },
            {
                name: 'svc.transition_lead',
                own: { lead_uuid: state.leadA.uuid, action: 'advance' },
                foreign: { lead_uuid: state.leadB.uuid, action: 'advance' },
            },
            {
                name: 'svc.create_job',
                own: {
                    customer_name: 'Shared Person',
                    customer_phone: state.sharedPhone,
                    customer_email: state.sharedEmail,
                    service_name: 'A-created',
                },
                foreign: {
                    contact_id: state.contactB,
                    customer_name: 'Foreign Contact',
                },
            },
            {
                name: 'svc.update_job',
                own: { job_id: state.jobA, description: 'A-updated' },
                foreign: { job_id: state.jobB, description: 'must-not-write' },
            },
            {
                name: 'svc.transition_job',
                own: { job_id: state.jobA, action: 'advance' },
                foreign: { job_id: state.jobB, action: 'advance' },
            },
            {
                name: 'svc.add_note',
                own: { parent_type: 'job', parent_id: String(state.jobA), text: 'A note' },
                foreign: { parent_type: 'job', parent_id: String(state.jobB), text: 'must-not-write' },
            },
        ];

        const results = new Map();
        for (const entry of cases) {
            const beforeB = await snapshotCompany(state.companyB);
            results.set(entry.name, await invoke(resolved, entry.name, entry.own));
            await expect(invoke(resolved, entry.name, entry.foreign))
                .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            expect(await snapshotCompany(state.companyB)).toBe(beforeB);
        }

        const replay = await invoke(resolved, 'svc.create_lead', cases[0].own);
        expect(replay).toEqual(results.get('svc.create_lead'));
        const leadCount = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM leads
             WHERE id=$1 AND company_id=$2`,
            [results.get('svc.create_lead').lead_id, state.companyA]
        );
        expect(leadCount.rows[0].count).toBe(1);

        const jobReplay = await invoke(resolved, 'svc.create_job', cases[3].own);
        expect(jobReplay).toEqual(results.get('svc.create_job'));
        const jobCount = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM jobs
             WHERE id=$1 AND company_id=$2`,
            [results.get('svc.create_job').job_id, state.companyA]
        );
        expect(jobCount.rows[0].count).toBe(1);

        const emptyContact = await db.query(
            `INSERT INTO contacts (company_id, full_name, first_name, last_name)
             VALUES ($1, 'Empty Contact', 'Empty', 'Contact')
             RETURNING id`,
            [state.companyA]
        );
        const enrichedPhone = '+16175550177';
        const enrichedEmail = `enriched-${randomUUID()}@example.test`;
        await invoke(resolved, 'svc.create_lead', {
            contact_id: Number(emptyContact.rows[0].id),
            first_name: 'Empty',
            last_name: 'Contact',
            phone: enrichedPhone,
            email: enrichedEmail,
        });
        await expect(db.query(
            `SELECT phone_e164, email
             FROM contacts
             WHERE id=$1 AND company_id=$2`,
            [emptyContact.rows[0].id, state.companyA]
        )).resolves.toMatchObject({
            rows: [{ phone_e164: enrichedPhone, email: enrichedEmail }],
        });

        const noStealContact = await db.query(
            `INSERT INTO contacts (company_id, full_name, first_name, last_name)
             VALUES ($1, 'No Steal', 'No', 'Steal')
             RETURNING id`,
            [state.companyA]
        );
        await invoke(resolved, 'svc.create_lead', {
            contact_id: Number(noStealContact.rows[0].id),
            first_name: 'No',
            last_name: 'Steal',
            phone: state.sharedPhone,
            email: state.sharedEmail,
        });
        const noSteal = await db.query(
            `SELECT phone_e164, email
             FROM contacts
             WHERE id=$1 AND company_id=$2`,
            [noStealContact.rows[0].id, state.companyA]
        );
        expect(noSteal.rows).toEqual([{ phone_e164: null, email: null }]);

        await expect(invoke(resolved, 'svc.transition_lead', {
            lead_uuid: state.leadA.uuid,
            action: 'ignore_fsm_and_close',
        })).rejects.toMatchObject({ code: 'FSM_TRANSITION_DENIED', httpStatus: 403 });

        await invoke(resolved, 'svc.add_note', {
            parent_type: 'lead',
            parent_id: state.leadA.uuid,
            text: 'Lead note by AI',
        });
        await invoke(resolved, 'svc.add_note', {
            parent_type: 'contact',
            parent_id: String(state.contactA),
            text: 'Contact note by AI',
        });
        const actors = await db.query(
            `SELECT
                (SELECT structured_notes->-1->>'created_by'
                 FROM leads WHERE uuid=$1 AND company_id=$4) AS lead_actor,
                (SELECT structured_notes->-1->>'created_by'
                 FROM contacts WHERE id=$2 AND company_id=$4) AS contact_actor,
                (SELECT notes->-1->>'created_by'
                 FROM jobs WHERE id=$3 AND company_id=$4) AS job_actor`,
            [state.leadA.uuid, state.contactA, state.jobA, state.companyA]
        );
        expect(actors.rows[0]).toEqual({
            lead_actor: state.identityA.aiUser.id,
            contact_actor: state.identityA.aiUser.id,
            job_actor: state.identityA.aiUser.id,
        });
    });
});

describe('CHATGPT-CRM-MCP S2b real-PostgreSQL financial write contract', () => {
    databaseTest('legacy grant rows cannot narrow or widen the live-owner write tier', async () => {
        const s2bNames = [
            'svc.create_estimate',
            'svc.update_estimate',
            'svc.create_invoice',
            'svc.update_invoice',
        ];
        await db.query(
            `DELETE FROM mcp_agent_permission_grants
             WHERE company_id=$1
               AND agent_user_id=$2
               AND permission_key = ANY($3::text[])`,
            [
                state.companyA,
                state.identityA.aiUser.id,
                [
                    'estimates.create',
                    'invoices.create',
                    ...s2bNames.map((name) => `mcp.tool.${name}`),
                ],
            ]
        );
        let resolved = await resolveA();
        let response = await protocol.handleJsonRpc(protocolRequest(resolved), {
            jsonrpc: '2.0',
            id: 41,
            method: 'tools/list',
            params: {},
        });
        expect(response.result.tools).toHaveLength(31);
        expect(response.result.tools.map((tool) => tool.name))
            .toEqual(expect.arrayContaining(s2bNames));

        await expect(setConsent(true)).resolves.toMatchObject({
            enabled: true,
            grant_version: 3,
        });
        resolved = await resolveA();
        response = await protocol.handleJsonRpc(protocolRequest(resolved), {
            jsonrpc: '2.0',
            id: 42,
            method: 'tools/list',
            params: {},
        });
        expect(response.result.tools).toHaveLength(31);
        expect(response.result.tools.map((tool) => tool.name))
            .toEqual(expect.arrayContaining(s2bNames));
    });

    databaseTest('T-own / T-foreign / T-blast, item ownership, replay, and server totals hold for all 4 tools', async () => {
        const seedClient = await db.pool.connect();
        try {
            await seedClient.query('BEGIN');
            const estimateB = await estimatesService.createEstimate(
                state.companyB,
                state.identityB.aiUser.id,
                {
                    job_id: state.jobB,
                    summary: 'B estimate',
                    items: [{ name: 'B item', quantity: 1, unit_price: 700, taxable: true }],
                },
                seedClient
            );
            state.estimateB = estimateB;
            const invoiceB = await invoicesService.createInvoice(
                state.companyB,
                state.identityB.aiUser.id,
                {
                    contact_id: state.contactB,
                    job_id: state.jobB,
                    title: 'B invoice',
                    due_date: '2026-08-31',
                    items: [{ name: 'B item', quantity: 1, unit_price: 900, taxable: true }],
                },
                seedClient
            );
            state.invoiceB = invoiceB;
            await seedClient.query('COMMIT');
        } catch (err) {
            await seedClient.query('ROLLBACK');
            throw err;
        } finally {
            seedClient.release();
        }

        const resolved = await resolveA();
        const estimateArgs = {
            job_id: state.jobA,
            summary: 'A canonical totals',
            tax_rate: 6,
            discount_type: 'fixed',
            discount_value: 90,
            items: [
                { name: 'Taxable part', quantity: 1, unit_price: 95, taxable: true },
                { name: 'Non-taxable labor', quantity: 1, unit_price: 100, taxable: false },
            ],
        };
        let beforeB = await snapshotCompany(state.companyB);
        const createdEstimate = await invoke(
            resolved,
            'svc.create_estimate',
            estimateArgs
        );
        await expect(invoke(resolved, 'svc.create_estimate', {
            contact_id: state.contactB,
            job_id: state.jobA,
            summary: 'must-not-write',
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);
        expect({
            subtotal: Number(createdEstimate.subtotal),
            discount: Number(createdEstimate.discount_amount),
            tax: Number(createdEstimate.tax_amount),
            total: Number(createdEstimate.total),
        }).toEqual({ subtotal: 195, discount: 90, tax: 0.3, total: 105.3 });

        beforeB = await snapshotCompany(state.companyB);
        const updatedEstimate = await invoke(resolved, 'svc.update_estimate', {
            estimate_id: Number(createdEstimate.id),
            notes: 'A updated',
            items_update: [{
                item_id: Number(createdEstimate.items[0].id),
                unit_price: 100,
            }],
        });
        expect(updatedEstimate.notes).toBe('A updated');
        await expect(invoke(resolved, 'svc.update_estimate', {
            estimate_id: Number(state.estimateB.id),
            notes: 'must-not-write',
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        await expect(invoke(resolved, 'svc.update_estimate', {
            estimate_id: Number(createdEstimate.id),
            items_update: [{
                item_id: Number(state.estimateB.items[0].id),
                unit_price: 1,
            }],
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);

        const estimateReplay = await invoke(
            resolved,
            'svc.create_estimate',
            estimateArgs
        );
        expect(estimateReplay).toEqual(JSON.parse(JSON.stringify(createdEstimate)));
        const estimateCount = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM estimates
             WHERE id=$1 AND company_id=$2`,
            [createdEstimate.id, state.companyA]
        );
        expect(estimateCount.rows[0].count).toBe(1);

        const invoiceArgs = {
            contact_id: state.contactA,
            job_id: state.jobA,
            title: 'A canonical totals',
            due_date: '2026-08-31',
            tax_rate: 6,
            discount_amount: 90,
            items: [
                { name: 'Taxable part', quantity: 1, unit_price: 95, taxable: true },
                { name: 'Non-taxable labor', quantity: 1, unit_price: 100, taxable: false },
            ],
        };
        beforeB = await snapshotCompany(state.companyB);
        const createdInvoice = await invoke(resolved, 'svc.create_invoice', invoiceArgs);
        await expect(invoke(resolved, 'svc.create_invoice', {
            contact_id: state.contactB,
            due_date: '2026-08-31',
            items: [{ name: 'must-not-write', quantity: 1, unit_price: 1 }],
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);
        expect({
            subtotal: Number(createdInvoice.subtotal),
            discount: Number(createdInvoice.discount_amount),
            tax: Number(createdInvoice.tax_amount),
            total: Number(createdInvoice.total),
            balance: Number(createdInvoice.balance_due),
        }).toEqual({
            subtotal: 195,
            discount: 90,
            tax: 0.3,
            total: 105.3,
            balance: 105.3,
        });

        beforeB = await snapshotCompany(state.companyB);
        const updatedInvoice = await invoke(resolved, 'svc.update_invoice', {
            invoice_id: Number(createdInvoice.id),
            notes: 'A updated',
            items_update: [{
                item_id: Number(createdInvoice.items[0].id),
                quantity: 2,
            }],
        });
        expect(updatedInvoice.notes).toBe('A updated');
        await expect(invoke(resolved, 'svc.update_invoice', {
            invoice_id: Number(state.invoiceB.id),
            notes: 'must-not-write',
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        await expect(invoke(resolved, 'svc.update_invoice', {
            invoice_id: Number(createdInvoice.id),
            items_update: [{
                item_id: Number(state.invoiceB.items[0].id),
                unit_price: 1,
            }],
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);

        const invoiceReplay = await invoke(resolved, 'svc.create_invoice', invoiceArgs);
        expect(invoiceReplay).toEqual(JSON.parse(JSON.stringify(createdInvoice)));
        const invoiceCount = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM invoices
             WHERE id=$1 AND company_id=$2`,
            [createdInvoice.id, state.companyA]
        );
        expect(invoiceCount.rows[0].count).toBe(1);
    });
});

describe('CHATGPT-CRM-MCP S2c-b Estimate-to-Invoice conversion contract', () => {
    const TOOL_NAME = 'svc.convert_estimate_to_invoice';

    async function createEstimate(companyId, actorId, jobId, suffix, approved = true) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const estimate = await estimatesService.createEstimate(
                companyId,
                actorId,
                {
                    job_id: jobId,
                    summary: `${suffix} canonical conversion`,
                    tax_rate: 6,
                    discount_type: 'fixed',
                    discount_value: 90,
                    items: [
                        {
                            name: `${suffix} taxable part`,
                            quantity: 1,
                            unit_price: 95,
                            taxable: true,
                        },
                        {
                            name: `${suffix} non-taxable labor`,
                            quantity: 1,
                            unit_price: 100,
                            taxable: false,
                        },
                    ],
                },
                client
            );
            if (approved) {
                await client.query(
                    `UPDATE estimates
                     SET status='approved', updated_at=NOW()
                     WHERE id=$1 AND company_id=$2`,
                    [estimate.id, companyId]
                );
            }
            await client.query('COMMIT');
            return estimatesService.getEstimate(companyId, estimate.id);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    databaseTest('missing legacy exact grant cannot hide a live-owner/tier-authorized tool', async () => {
        await setConsent(true);
        await db.query(
            `DELETE FROM mcp_agent_permission_grants
             WHERE company_id=$1
               AND agent_user_id=$2
               AND permission_key=$3`,
            [
                state.companyA,
                state.identityA.aiUser.id,
                `mcp.tool.${TOOL_NAME}`,
            ]
        );

        let resolved = await resolveA();
        let response = await protocol.handleJsonRpc(protocolRequest(resolved), {
            jsonrpc: '2.0',
            id: 51,
            method: 'tools/list',
            params: {},
        });
        expect(response.result.tools).toHaveLength(31);
        expect(response.result.tools.map((tool) => tool.name)).toContain(TOOL_NAME);

        await expect(setConsent(true)).resolves.toMatchObject({
            enabled: true,
            grant_version: 3,
        });
        resolved = await resolveA();
        response = await protocol.handleJsonRpc(protocolRequest(resolved), {
            jsonrpc: '2.0',
            id: 52,
            method: 'tools/list',
            params: {},
        });
        expect(response.result.tools).toHaveLength(31);
        expect(response.result.tools.map((tool) => tool.name)).toContain(TOOL_NAME);
    });

    databaseTest('T-own / T-foreign / T-blast, canonical totals, replay, and status rules hold', async () => {
        await setConsent(true);
        const estimateA = await createEstimate(
            state.companyA,
            state.identityA.aiUser.id,
            state.jobA,
            'A'
        );
        const estimateB = await createEstimate(
            state.companyB,
            state.identityB.aiUser.id,
            state.jobB,
            'B'
        );
        const resolved = await resolveA();

        let beforeB = await snapshotCompany(state.companyB);
        const converted = await invoke(resolved, TOOL_NAME, {
            estimate_id: Number(estimateA.id),
        });
        expect(converted).toMatchObject({
            already_converted: false,
            status: 'draft',
        });
        expect(Number(converted.estimate_id)).toBe(Number(estimateA.id));
        expect(converted).not.toHaveProperty('public_token');
        expect(converted.items.map((item) => ({
            name: item.name,
            quantity: Number(item.quantity),
            unit_price: Number(item.unit_price),
            amount: Number(item.amount),
            taxable: item.taxable,
        }))).toEqual(estimateA.items.map((item) => ({
            name: item.name,
            quantity: Number(item.quantity),
            unit_price: Number(item.unit_price),
            amount: Number(item.amount),
            taxable: item.taxable,
        })));
        expect({
            subtotal: Number(converted.subtotal),
            discount: Number(converted.discount_amount),
            tax: Number(converted.tax_amount),
            total: Number(converted.total),
            balance: Number(converted.balance_due),
        }).toEqual({
            subtotal: Number(estimateA.subtotal),
            discount: Number(estimateA.discount_amount),
            tax: Number(estimateA.tax_amount),
            total: Number(estimateA.total),
            balance: Number(estimateA.total),
        });
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);

        beforeB = await snapshotCompany(state.companyB);
        await expect(invoke(resolved, TOOL_NAME, {
            estimate_id: Number(estimateB.id),
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);

        const replay = await invoke(resolved, TOOL_NAME, {
            estimate_id: Number(estimateA.id),
        });
        expect(replay).toMatchObject({
            id: converted.id,
            already_converted: true,
        });
        const counts = await db.query(
            `SELECT
                (SELECT COUNT(*)::int
                 FROM invoices
                 WHERE company_id=$1 AND estimate_id=$2) AS invoices,
                (SELECT COUNT(*)::int
                 FROM mcp_tool_idempotency
                 WHERE company_id=$1
                   AND agent_user_id=$3
                   AND tool_name=$4
                   AND state='succeeded') AS claims`,
            [
                state.companyA,
                estimateA.id,
                state.identityA.aiUser.id,
                TOOL_NAME,
            ]
        );
        expect(counts.rows[0]).toEqual({ invoices: 1, claims: 1 });

        const draft = await createEstimate(
            state.companyA,
            state.identityA.aiUser.id,
            state.jobA,
            'Draft',
            false
        );
        await expect(invoke(resolved, TOOL_NAME, {
            estimate_id: Number(draft.id),
        })).rejects.toMatchObject({
            code: 'INVALID_STATUS',
            httpStatus: 400,
        });
        const draftInvoices = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM invoices
             WHERE company_id=$1 AND estimate_id=$2`,
            [state.companyA, draft.id]
        );
        expect(draftInvoices.rows[0].count).toBe(0);
    });

    databaseTest('parallel MCP replay and direct canonical-service replay each create one Invoice', async () => {
        await setConsent(true);
        const resolved = await resolveA();
        const mcpEstimate = await createEstimate(
            state.companyA,
            state.identityA.aiUser.id,
            state.jobA,
            'Parallel MCP'
        );
        const mcpResults = await Promise.all([
            invoke(resolved, TOOL_NAME, { estimate_id: Number(mcpEstimate.id) }),
            invoke(resolved, TOOL_NAME, { estimate_id: Number(mcpEstimate.id) }),
        ]);
        expect(new Set(mcpResults.map((row) => Number(row.id))).size).toBe(1);
        expect(mcpResults.map((row) => row.already_converted).sort())
            .toEqual([false, true]);

        const serviceEstimate = await createEstimate(
            state.companyA,
            state.identityA.aiUser.id,
            state.jobA,
            'Parallel service'
        );
        const serviceResults = await Promise.all([
            estimatesService.convertToInvoice(
                state.companyA,
                state.identityA.aiUser.id,
                serviceEstimate.id
            ),
            estimatesService.convertToInvoice(
                state.companyA,
                state.identityA.aiUser.id,
                serviceEstimate.id
            ),
        ]);
        expect(new Set(serviceResults.map((row) => Number(row.id))).size).toBe(1);
        expect(serviceResults.map((row) => row.already_converted).sort())
            .toEqual([false, true]);

        const counts = await db.query(
            `SELECT estimate_id, COUNT(*)::int AS count
             FROM invoices
             WHERE company_id=$1 AND estimate_id=ANY($2::bigint[])
             GROUP BY estimate_id
             ORDER BY estimate_id`,
            [
                state.companyA,
                [Number(mcpEstimate.id), Number(serviceEstimate.id)],
            ]
        );
        expect(counts.rows).toEqual([
            { estimate_id: String(mcpEstimate.id), count: 1 },
            { estimate_id: String(serviceEstimate.id), count: 1 },
        ]);
    });
});

describe('AVATARS-001 Phase B real-PostgreSQL parity and scope contract', () => {
    const allOauthScopes = [
        permissions.READ_SCOPE,
        permissions.WRITE_SCOPE,
        permissions.SEND_SCOPE,
    ];

    databaseTest('33 tools × 4 roles: live tools/list and direct denied calls match the parity table', async () => {
        await marketplaceService.setChatgptMcpWrites(
            state.companyA,
            state.humanA.id,
            true,
            { requestId: `avatars-write-tier-${randomUUID()}` }
        );
        await marketplaceService.setChatgptMcpSends(
            state.companyA,
            state.humanA.id,
            true,
            { requestId: `avatars-send-tier-${randomUUID()}` }
        );
        const allTools = registry.listTools({
            includeDispatcher: true,
            dispatcherOnly: true,
        });
        expect(allTools).toHaveLength(33);

        for (const role of ['tenant_admin', 'manager', 'dispatcher', 'provider']) {
            await db.query(
                `UPDATE company_memberships
                 SET role = CASE WHEN $3='tenant_admin' THEN 'company_admin' ELSE 'company_member' END,
                     role_key=$3
                 WHERE user_id=$1 AND company_id=$2`,
                [state.humanA.id, state.companyA, role]
            );
            const resolved = await resolveA();
            expect(resolved.owner_role_key).toBe(role);
            const req = protocolRequest(resolved, allOauthScopes);
            const listed = await protocol.handleJsonRpc(req, {
                jsonrpc: '2.0',
                id: `list-${role}`,
                method: 'tools/list',
                params: {},
            });
            const visible = new Set(listed.result.tools.map((tool) => tool.name));
            for (const tool of allTools) {
                const expected = expectedAvatarTool(tool, resolved);
                expect(visible.has(tool.name)).toBe(expected);
                if (expected) continue;
                const denied = await protocol.handleJsonRpc(req, {
                    jsonrpc: '2.0',
                    id: `deny-${role}-${tool.name}`,
                    method: 'tools/call',
                    params: {
                        name: tool.name,
                        arguments: validArgumentsFor(tool),
                        ...(tool.kind === 'write' ? {
                            confirmation: {
                                confirmed: true,
                                confirmation_id: `deny-${role}-${tool.name}`,
                            },
                        } : {}),
                    },
                });
                expect(denied.error).toEqual(expect.objectContaining({
                    code: -32001,
                    data: expect.objectContaining({ code: 'access_denied' }),
                }));
            }
        }
        await db.query(
            `UPDATE company_memberships
             SET role='company_admin', role_key='tenant_admin'
             WHERE user_id=$1 AND company_id=$2`,
            [state.humanA.id, state.companyA]
        );
    });

    databaseTest('SAB-AVATAR-RECORD-SCOPE: provider avatar sees and mutates only owner-assigned records', async () => {
        const membership = await db.query(
            `UPDATE company_memberships
             SET role='company_member', role_key='provider'
             WHERE user_id=$1 AND company_id=$2
             RETURNING id`,
            [state.humanA.id, state.companyA]
        );
        for (const permission of ['jobs.edit', 'jobs.close', 'contacts.view', 'contacts.edit']) {
            await db.query(
                `INSERT INTO company_membership_permission_overrides
                    (membership_id, permission_key, override_mode)
                 VALUES ($1,$2,'allow')
                 ON CONFLICT (membership_id, permission_key)
                 DO UPDATE SET override_mode='allow'`,
                [membership.rows[0].id, permission]
            );
        }
        await db.query(
            `UPDATE jobs
             SET assigned_provider_user_ids=$1::jsonb,
                 start_date=NOW()+INTERVAL '1 day',
                 end_date=NOW()+INTERVAL '1 day 2 hours'
             WHERE id=$2 AND company_id=$3`,
            [JSON.stringify([state.humanA.id]), state.jobA, state.companyA]
        );
        const unassignedContact = await db.query(
            `INSERT INTO contacts (company_id, full_name, phone_e164, email)
             VALUES ($1,'Provider Hidden Contact',$2,$3)
             RETURNING id`,
            [
                state.companyA,
                `+1555${String(Date.now() + 1).slice(-7)}`,
                `provider-hidden-${randomUUID()}@example.test`,
            ]
        );
        const unassignedJob = await db.query(
            `INSERT INTO jobs
                (company_id, contact_id, blanc_status, customer_name, service_name,
                 description, start_date, end_date, assigned_provider_user_ids)
             VALUES ($1,$2,'Submitted','Provider Hidden','Hidden service','before',
                     NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day 2 hours','[]'::jsonb)
             RETURNING id`,
            [state.companyA, unassignedContact.rows[0].id]
        );
        const callRows = await db.query(
            `INSERT INTO calls
                (call_sid, company_id, contact_id, direction, from_number, to_number,
                 status, started_at, is_final)
             VALUES
                ($1,$2,$3,'inbound','+16175550100','+16175550200','completed',NOW(),true),
                ($4,$2,$5,'inbound','+16175550101','+16175550200','completed',NOW(),true),
                ($6,$2,NULL,'inbound','+16175550102','+16175550200','completed',NOW(),true)
             RETURNING id, contact_id`,
            [
                `CA-AVATAR-ASSIGNED-${randomUUID()}`,
                state.companyA,
                state.contactA,
                `CA-AVATAR-HIDDEN-${randomUUID()}`,
                unassignedContact.rows[0].id,
                `CA-AVATAR-ORPHAN-${randomUUID()}`,
            ]
        );
        await db.query(
            `INSERT INTO tasks
                (company_id,title,status,created_by,job_id,owner_user_id,author_user_id)
             VALUES
                ($1,'Assigned task','open','user',$2,$3,$4),
                ($1,'Authored task','open','user',$2,$4,$3),
                ($1,'Hidden task','open','user',$5,$4,$4)`,
            [
                state.companyA,
                state.jobA,
                state.humanA.id,
                state.spareAdminA.id,
                unassignedJob.rows[0].id,
            ]
        );
        const beforeB = await snapshotCompany(state.companyB);
        const resolved = await resolveA();
        expect(resolved.owner_scopes).toMatchObject({ job_visibility: 'assigned_only' });
        const req = protocolRequest(resolved, allOauthScopes);
        const call = async (name, args) => protocol.handleJsonRpc(req, {
            jsonrpc: '2.0',
            id: `scope-${name}-${randomUUID()}`,
            method: 'tools/call',
            params: { name, arguments: args },
        });

        const jobs = await call('svc.list_jobs', { limit: 100 });
        expect(jobs.result.structuredContent.results.map((row) => Number(row.id)))
            .toContain(state.jobA);
        expect(jobs.result.structuredContent.results.map((row) => Number(row.id)))
            .not.toContain(Number(unassignedJob.rows[0].id));
        for (const [name, args] of [
            ['svc.get_job', { job_id: Number(unassignedJob.rows[0].id) }],
            ['svc.get_schedule_item', {
                entity_type: 'job',
                entity_id: Number(unassignedJob.rows[0].id),
            }],
            ['svc.get_contact', { contact_id: Number(unassignedContact.rows[0].id) }],
            ['svc.list_entity_tasks', {
                parent_type: 'job',
                parent_id: String(unassignedJob.rows[0].id),
            }],
        ]) {
            const denied = await call(name, args);
            expect(denied.error).toEqual(expect.objectContaining({
                code: -32004,
                data: expect.objectContaining({ code: 'not_found' }),
            }));
        }
        const schedule = await call('svc.list_schedule', { limit: 100 });
        expect(schedule.result.structuredContent.items.map((row) => Number(row.entity_id)))
            .toContain(state.jobA);
        expect(schedule.result.structuredContent.items.map((row) => Number(row.entity_id)))
            .not.toContain(Number(unassignedJob.rows[0].id));
        const calls = await call('svc.list_calls', { limit: 50 });
        expect(calls.result.structuredContent.rows.map((row) => Number(row.id)))
            .toEqual([Number(callRows.rows[0].id)]);
        const tasks = await call('svc.list_tasks', { status: 'open', limit: 100 });
        expect(tasks.result.structuredContent.tasks.map((row) => row.description))
            .toEqual(expect.arrayContaining(['Assigned task', 'Authored task']));
        expect(tasks.result.structuredContent.tasks.map((row) => row.description))
            .not.toContain('Hidden task');

        const scopedContext = writeContext(resolved);
        await expect(invokeDirect(
            scopedContext,
            'svc.update_job',
            { job_id: state.jobA, description: 'provider-owned' }
        )).resolves.toMatchObject({ job_id: String(state.jobA) });
        await expect(invokeDirect(
            scopedContext,
            'svc.update_job',
            { job_id: Number(unassignedJob.rows[0].id), description: 'must-not-write' }
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        await expect(invokeDirect(
            scopedContext,
            'svc.add_note',
            {
                parent_type: 'contact',
                parent_id: String(state.contactA),
                text: 'provider-visible contact',
            }
        )).resolves.toMatchObject({ parent_type: 'contact' });
        await expect(invokeDirect(
            scopedContext,
            'svc.add_note',
            {
                parent_type: 'contact',
                parent_id: String(unassignedContact.rows[0].id),
                text: 'must-not-write',
            }
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        const unchanged = await db.query(
            `SELECT description
             FROM jobs
             WHERE id=$1 AND company_id=$2`,
            [unassignedJob.rows[0].id, state.companyA]
        );
        expect(unchanged.rows[0].description).toBe('before');
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);

        await db.query(
            `DELETE FROM company_membership_permission_overrides
             WHERE membership_id=$1`,
            [membership.rows[0].id]
        );
        await db.query(
            `UPDATE company_memberships
             SET role='company_admin', role_key='tenant_admin'
             WHERE id=$1`,
            [membership.rows[0].id]
        );
    });

    databaseTest('role/tier changes between discovery and call/write fail with zero side effects', async () => {
        await db.query(
            `UPDATE company_memberships
             SET role='company_admin', role_key='tenant_admin'
             WHERE user_id=$1 AND company_id=$2`,
            [state.humanA.id, state.companyA]
        );
        await marketplaceService.setChatgptMcpWrites(
            state.companyA,
            state.humanA.id,
            true,
            { requestId: `avatars-race-enable-${randomUUID()}` }
        );
        let resolved = await resolveA();
        let req = protocolRequest(resolved, allOauthScopes);
        const beforeList = await protocol.handleJsonRpc(req, {
            jsonrpc: '2.0',
            id: 'before-demotion',
            method: 'tools/list',
            params: {},
        });
        expect(beforeList.result.tools.map((tool) => tool.name)).toContain('svc.get_lead');
        await db.query(
            `UPDATE company_memberships
             SET role='company_member', role_key='provider'
             WHERE user_id=$1 AND company_id=$2`,
            [state.humanA.id, state.companyA]
        );
        const demotedCall = await protocol.handleJsonRpc(req, {
            jsonrpc: '2.0',
            id: 'after-demotion',
            method: 'tools/call',
            params: {
                name: 'svc.get_lead',
                arguments: { lead_uuid: state.leadA.uuid },
            },
        });
        expect(demotedCall.error).toEqual(expect.objectContaining({
            code: -32001,
            data: expect.objectContaining({ code: 'access_denied' }),
        }));
        await db.query(
            `UPDATE company_memberships
             SET role='company_admin', role_key='tenant_admin'
             WHERE user_id=$1 AND company_id=$2`,
            [state.humanA.id, state.companyA]
        );

        resolved = await resolveA();
        const beforeLead = await db.query(
            `SELECT comments FROM leads WHERE uuid=$1 AND company_id=$2`,
            [state.leadA.uuid, state.companyA]
        );
        await expect(invokeDirect(
            writeContext(resolved),
            'svc.update_lead',
            { lead_uuid: state.leadA.uuid, comments: 'race-must-rollback' },
            {
                beforeLiveRecheck: async (client) => {
                    await client.query(
                        `UPDATE company_memberships
                         SET role='company_member', role_key='provider'
                         WHERE user_id=$1 AND company_id=$2`,
                        [state.humanA.id, state.companyA]
                    );
                },
            }
        )).rejects.toMatchObject({ mcpCode: 'access_denied' });
        const afterLead = await db.query(
            `SELECT comments FROM leads WHERE uuid=$1 AND company_id=$2`,
            [state.leadA.uuid, state.companyA]
        );
        expect(afterLead.rows[0]).toEqual(beforeLead.rows[0]);

        await marketplaceService.setChatgptMcpWrites(
            state.companyA,
            state.humanA.id,
            false,
            { requestId: `avatars-race-disable-${randomUUID()}` }
        );
        req = protocolRequest(await resolveA(), allOauthScopes);
        const tierList = await protocol.handleJsonRpc(req, {
            jsonrpc: '2.0',
            id: 'tier-off',
            method: 'tools/list',
            params: {},
        });
        expect(tierList.result.tools.map((tool) => tool.name)).not.toContain('svc.update_lead');
        const tierCall = await protocol.handleJsonRpc(req, {
            jsonrpc: '2.0',
            id: 'tier-off-call',
            method: 'tools/call',
            params: {
                name: 'svc.update_lead',
                arguments: { lead_uuid: state.leadA.uuid, comments: 'denied' },
                confirmation: { confirmed: true, confirmation_id: 'tier-off' },
            },
        });
        expect(tierCall.error).toEqual(expect.objectContaining({
            code: -32001,
            data: expect.objectContaining({ code: 'access_denied' }),
        }));
        await marketplaceService.setChatgptMcpWrites(
            state.companyA,
            state.humanA.id,
            true,
            { requestId: `avatars-race-restore-${randomUUID()}` }
        );
    });
});

afterAll(async () => {
    if (oldIssuer === undefined) delete process.env.KEYCLOAK_REALM_URL;
    else process.env.KEYCLOAK_REALM_URL = oldIssuer;
    if (oldClientId === undefined) delete process.env.CHATGPT_MCP_CLIENT_ID;
    else process.env.CHATGPT_MCP_CLIENT_ID = oldClientId;
    try { await db.pool.end(); } catch { /* ignore */ }
});
