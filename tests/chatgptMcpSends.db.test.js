'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');

const mockGetMailboxStatus = jest.fn();
const mockSendEmail = jest.fn();
const mockRenderEstimatePdf = jest.fn();
const mockRenderInvoicePdf = jest.fn();
const mockRecordDocumentSendNote = jest.fn();

jest.mock('../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: (...args) => mockGetMailboxStatus(...args),
}));
jest.mock('../backend/src/services/emailService', () => ({
    sendEmail: (...args) => mockSendEmail(...args),
}));
jest.mock('../backend/src/services/estimatePdfService', () => ({
    renderEstimatePdf: (...args) => mockRenderEstimatePdf(...args),
}));
jest.mock('../backend/src/services/documentTemplatesService', () => ({
    resolveTemplate: jest.fn(async () => ({
        key: 'test-document',
        invoice_settings: { default_due_days: 14 },
    })),
}));
jest.mock('../backend/src/services/documentTemplates', () => ({
    get: (type) => (type === 'invoice'
        ? { render: (...args) => mockRenderInvoicePdf(...args) }
        : null),
}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    recordDocumentSendNote: (...args) => mockRecordDocumentSendNote(...args),
    actorFromRequest: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const marketplaceService = require('../backend/src/services/marketplaceService');
const permissions = require('../backend/src/services/chatgptMcpPermissions');
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
    test('ChatGPT MCP S3 send DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`ChatGPT MCP S3 send DB tests are pending: ${DATABASE.reason}`);
    });
}

const state = {};
const oldIssuer = process.env.KEYCLOAK_REALM_URL;
const oldClientId = process.env.CHATGPT_MCP_CLIENT_ID;
const oldPublicAppUrl = process.env.PUBLIC_APP_URL;

async function setup() {
    process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';
    process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
    process.env.PUBLIC_APP_URL = 'https://app.albusto.test';
    state.companyA = randomUUID();
    state.companyB = randomUUID();
    state.sharedPhone = `+1555${String(Date.now()).slice(-7)}`;
    state.primaryEmailA = `s3-primary-a-${state.companyA}@example.test`;
    state.primaryEmailB = `s3-primary-b-${state.companyB}@example.test`;

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(AVATARS);
        await client.query(
            `INSERT INTO companies (id, name, slug, status, timezone)
             VALUES ($1, 'S3 Tenant A', $2, 'active', 'America/New_York'),
                    ($3, 'S3 Tenant B', $4, 'active', 'America/Chicago')`,
            [
                state.companyA,
                `s3-a-${state.companyA}`,
                state.companyB,
                `s3-b-${state.companyB}`,
            ]
        );
        await client.query(ROLE_SEED);
        const humans = await client.query(
            `INSERT INTO crm_users
                (keycloak_sub, email, full_name, role, status, company_id,
                 platform_role, onboarding_status, kind)
             VALUES
                ($1,$2,'S3 Admin A','company_member','active',$3,'none','active','user'),
                ($4,$5,'S3 Admin B','company_member','active',$6,'none','active','user')
             RETURNING id, keycloak_sub, company_id`,
            [
                `s3-human-a-${state.companyA}`,
                `s3-admin-a-${state.companyA}@example.test`,
                state.companyA,
                `s3-human-b-${state.companyB}`,
                `s3-admin-b-${state.companyB}@example.test`,
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

        // Prod has LAST_ADMIN_REQUIRED. Keep a spare active tenant admin in each
        // tenant so future role-race controls cannot invalidate the fixture.
        const spareAdmins = await client.query(
            `INSERT INTO crm_users
                (keycloak_sub, email, full_name, role, status, company_id,
                 platform_role, onboarding_status, kind)
             VALUES
                ($1,$2,'S3 Spare A','company_member','active',$3,'none','active','user'),
                ($4,$5,'S3 Spare B','company_member','active',$6,'none','active','user')
             RETURNING id, company_id`,
            [
                `s3-spare-a-${state.companyA}`,
                `s3-spare-a-${state.companyA}@example.test`,
                state.companyA,
                `s3-spare-b-${state.companyB}`,
                `s3-spare-b-${state.companyB}@example.test`,
                state.companyB,
            ]
        );
        await client.query(
            `INSERT INTO company_memberships (user_id, company_id, role, role_key, status)
             VALUES
                ($1,$2,'company_admin','tenant_admin','active'),
                ($3,$4,'company_admin','tenant_admin','active')`,
            [
                spareAdmins.rows.find((row) => row.company_id === state.companyA).id,
                state.companyA,
                spareAdmins.rows.find((row) => row.company_id === state.companyB).id,
                state.companyB,
            ]
        );

        const app = await client.query(
            `SELECT id
             FROM marketplace_apps
             WHERE app_key='chatgpt-crm-mcp' AND status='published'`
        );
        if (app.rows.length !== 1) {
            throw new Error('Full migration-built schema with chatgpt-crm-mcp app is required');
        }
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

        // contacts.email is globally unique in the production-shaped schema.
        // Cross-tenant natural-key overlap is carried only by the shared phone.
        const contacts = await client.query(
            `INSERT INTO contacts
                (company_id, full_name, first_name, last_name, phone_e164, email)
             VALUES
                ($1,'S3 Shared A','S3','Shared A',$3,$4),
                ($2,'S3 Shared B','S3','Shared B',$3,$5)
             RETURNING id, company_id`,
            [
                state.companyA,
                state.companyB,
                state.sharedPhone,
                `s3-contact-a-${state.companyA}@example.test`,
                `s3-contact-b-${state.companyB}@example.test`,
            ]
        );
        state.contactA = Number(contacts.rows.find((row) => row.company_id === state.companyA).id);
        state.contactB = Number(contacts.rows.find((row) => row.company_id === state.companyB).id);
        await client.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             SELECT c.id, v.email, LOWER(v.email), true
             FROM (VALUES
                ($1::bigint, $3::text, $5::uuid),
                ($2::bigint, $4::text, $6::uuid)
             ) AS v(contact_id, email, company_id)
             JOIN contacts c
               ON c.id=v.contact_id
              AND c.company_id=v.company_id`,
            [
                state.contactA,
                state.contactB,
                state.primaryEmailA,
                state.primaryEmailB,
                state.companyA,
                state.companyB,
            ]
        );
        const jobs = await client.query(
            `INSERT INTO jobs
                (company_id, contact_id, blanc_status, zb_status, customer_name,
                 customer_phone, customer_email, service_name, notes, zb_raw)
             VALUES
                ($1,$3,'Submitted','scheduled','S3 Shared A',$5,$6,'S3 A','[]'::jsonb,'{}'::jsonb),
                ($2,$4,'Submitted','scheduled','S3 Shared B',$5,$7,'S3 B','[]'::jsonb,'{}'::jsonb)
             RETURNING id, company_id`,
            [
                state.companyA,
                state.companyB,
                state.contactA,
                state.contactB,
                state.sharedPhone,
                state.primaryEmailA,
                state.primaryEmailB,
            ]
        );
        state.jobA = Number(jobs.rows.find((row) => row.company_id === state.companyA).id);
        state.jobB = Number(jobs.rows.find((row) => row.company_id === state.companyB).id);

        state.estimateA = await estimatesService.createEstimate(
            state.companyA,
            state.identityA.aiUser.id,
            {
                job_id: state.jobA,
                summary: 'S3 Estimate A',
                items: [{ name: 'A item', quantity: 1, unit_price: 100 }],
            },
            client
        );
        state.estimateB = await estimatesService.createEstimate(
            state.companyB,
            state.identityB.aiUser.id,
            {
                job_id: state.jobB,
                summary: 'S3 Estimate B',
                items: [{ name: 'B item', quantity: 1, unit_price: 200 }],
            },
            client
        );
        state.invoiceA = await invoicesService.createInvoice(
            state.companyA,
            state.identityA.aiUser.id,
            {
                contact_id: state.contactA,
                job_id: state.jobA,
                title: 'S3 Invoice A',
                items: [{ name: 'A item', quantity: 1, unit_price: 300 }],
            },
            client
        );
        state.invoiceB = await invoicesService.createInvoice(
            state.companyB,
            state.identityB.aiUser.id,
            {
                contact_id: state.contactB,
                job_id: state.jobB,
                title: 'S3 Invoice B',
                items: [{ name: 'B item', quantity: 1, unit_price: 400 }],
            },
            client
        );
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
            (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]')
             FROM contacts c WHERE c.company_id=$1) AS contacts,
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
            (SELECT COALESCE(jsonb_agg(to_jsonb(ee) ORDER BY ee.id), '[]')
             FROM estimate_events ee
             JOIN estimates e ON e.id=ee.estimate_id AND e.company_id=$1
             WHERE e.company_id=$1) AS estimate_events,
            (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]')
             FROM invoices i WHERE i.company_id=$1) AS invoices,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ii) ORDER BY ii.id), '[]')
             FROM invoice_items ii
             JOIN invoices i ON i.id=ii.invoice_id AND i.company_id=$1
             WHERE i.company_id=$1) AS invoice_items,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ie) ORDER BY ie.id), '[]')
             FROM invoice_events ie
             JOIN invoices i ON i.id=ie.invoice_id AND i.company_id=$1
             WHERE i.company_id=$1) AS invoice_events,
            (SELECT COALESCE(jsonb_agg(to_jsonb(mi) ORDER BY mi.id), '[]')
             FROM mcp_tool_idempotency mi WHERE mi.company_id=$1) AS idempotency`,
        [companyId]
    );
    return JSON.stringify(rows[0]);
}

async function resolveA() {
    return identityService.resolveOAuthContext({
        issuer: process.env.KEYCLOAK_REALM_URL,
        subject: state.humanA.keycloak_sub,
        clientId: process.env.CHATGPT_MCP_CLIENT_ID,
    });
}

function protocolRequest(resolved) {
    return {
        companyFilter: { company_id: resolved.company_id },
        user: {
            kind: 'agent',
            oauthAuthorizerId: resolved.authorized_by_user_id,
            avatarOwnerId: resolved.owner_user_id,
            email: resolved.ai_email,
            crmUser: {
                id: resolved.ai_user_id,
                full_name: resolved.ai_full_name,
            },
        },
        authz: {
            permissions: resolved.permissions,
            oauthScopes: [
                permissions.READ_SCOPE,
                permissions.WRITE_SCOPE,
                permissions.SEND_SCOPE,
            ],
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
        requestId: `s3-protocol-${randomUUID()}`,
    };
}

async function listVisible(resolved) {
    const response = await protocol.handleJsonRpc(protocolRequest(resolved), {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/list',
        params: {},
    });
    return response.result.tools.map((tool) => tool.name);
}

async function invoke(resolved, name, args) {
    return executor.execute(
        protocolRequest(resolved),
        name,
        args,
        { confirmed: true, confirmation_id: `s3-confirm-${randomUUID()}` }
    );
}

beforeAll(async () => {
    if (DATABASE.ready) await setup();
});

beforeEach(() => {
    jest.clearAllMocks();
    mockGetMailboxStatus.mockResolvedValue({
        provider: 'gmail',
        status: 'connected',
        email_address: 'sender@example.test',
    });
    mockSendEmail.mockResolvedValue({
        provider_message_id: `gmail-${randomUUID()}`,
        provider_thread_id: `thread-${randomUUID()}`,
    });
    mockRenderEstimatePdf.mockResolvedValue(Buffer.from('%PDF-1.4 estimate'));
    mockRenderInvoicePdf.mockResolvedValue(Buffer.from('%PDF-1.4 invoice'));
    mockRecordDocumentSendNote.mockResolvedValue(true);
});

describe('CHATGPT-CRM-MCP S3 real-PostgreSQL consent contract', () => {
    databaseTest('send consent is independent from writes and reconciles 19 → 31 → 33', async () => {
        let resolved = await resolveA();
        expect(await listVisible(resolved)).toHaveLength(19);

        await expect(marketplaceService.setChatgptMcpWrites(
            state.companyA,
            state.humanA.id,
            true
        )).resolves.toMatchObject({
            writes_enabled: true,
            sends_enabled: false,
            grant_version: 3,
        });
        resolved = await resolveA();
        expect(await listVisible(resolved)).toHaveLength(31);
        expect(await listVisible(resolved)).not.toEqual(expect.arrayContaining(
            permissions.SEND_TOOL_NAMES
        ));
        await expect(invoke(resolved, 'svc.send_estimate', {
            estimate_id: Number(state.estimateA.id),
            channel: 'email',
        })).rejects.toMatchObject({ mcpCode: 'access_denied' });
        expect(mockSendEmail).not.toHaveBeenCalled();

        await expect(marketplaceService.setChatgptMcpSends(
            state.companyA,
            state.humanA.id,
            true
        )).resolves.toMatchObject({
            writes_enabled: true,
            sends_enabled: true,
            grant_version: 4,
        });
        resolved = await resolveA();
        expect(await listVisible(resolved)).toHaveLength(33);

        await expect(marketplaceService.setChatgptMcpSends(
            state.companyA,
            state.humanA.id,
            false
        )).resolves.toMatchObject({
            writes_enabled: true,
            sends_enabled: false,
            grant_version: 3,
        });
        resolved = await resolveA();
        expect(await listVisible(resolved)).toHaveLength(31);

        await marketplaceService.setChatgptMcpSends(
            state.companyA,
            state.humanA.id,
            true
        );
        await marketplaceService.setChatgptMcpWrites(
            state.companyA,
            state.humanA.id,
            false
        );
        resolved = await resolveA();
        expect(await listVisible(resolved)).toHaveLength(21);
        expect(await listVisible(resolved)).toEqual(expect.arrayContaining(
            permissions.SEND_TOOL_NAMES
        ));
        await expect(identityService.getWriteConsent(state.companyA)).resolves.toEqual({
            writes_enabled: false,
            sends_enabled: true,
            grant_version: 4,
        });

        await marketplaceService.setChatgptMcpWrites(
            state.companyA,
            state.humanA.id,
            true
        );
        resolved = await resolveA();
        expect(await listVisible(resolved)).toHaveLength(33);
    });
});

describe('CHATGPT-CRM-MCP S3 real-PostgreSQL send safety contract', () => {
    databaseTest('send_estimate T-own/T-foreign/T-blast resolves Contact primary email and replays once', async () => {
        const resolved = await resolveA();
        const args = {
            estimate_id: Number(state.estimateA.id),
            channel: 'email',
            message: 'Please review this estimate.',
        };
        const beforeB = await snapshotCompany(state.companyB);
        const result = await invoke(resolved, 'svc.send_estimate', args);
        expect(result).toMatchObject({
            sent: true,
            estimate_id: String(state.estimateA.id),
            channel: 'email',
            recipient_source: 'linked_contact',
        });
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(mockSendEmail.mock.calls[0][0]).toBe(state.companyA);
        expect(mockSendEmail.mock.calls[0][1].to).toBe(state.primaryEmailA);

        const replay = await invoke(resolved, 'svc.send_estimate', args);
        expect(replay).toEqual(JSON.parse(JSON.stringify(result)));
        expect(mockSendEmail).toHaveBeenCalledTimes(1);

        await expect(invoke(resolved, 'svc.send_estimate', {
            estimate_id: Number(state.estimateB.id),
            channel: 'email',
            message: 'Must not leave tenant B.',
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);
    });

    databaseTest('send_invoice T-own/T-foreign/T-blast uses Contact email and defaults payment link on', async () => {
        const resolved = await resolveA();
        const args = {
            invoice_id: Number(state.invoiceA.id),
            channel: 'email',
            message: 'Your invoice is ready.',
        };
        const beforeB = await snapshotCompany(state.companyB);
        const result = await invoke(resolved, 'svc.send_invoice', args);
        expect(result).toMatchObject({
            sent: true,
            invoice_id: String(state.invoiceA.id),
            channel: 'email',
            include_payment_link: true,
            recipient_source: 'linked_contact',
        });
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(mockSendEmail.mock.calls[0][0]).toBe(state.companyA);
        expect(mockSendEmail.mock.calls[0][1].to).toBe(state.primaryEmailA);
        expect(mockSendEmail.mock.calls[0][1].body)
            .toContain('https://app.albusto.test/pay/');

        const replay = await invoke(resolved, 'svc.send_invoice', args);
        expect(replay).toEqual(JSON.parse(JSON.stringify(result)));
        expect(mockSendEmail).toHaveBeenCalledTimes(1);

        await expect(invoke(resolved, 'svc.send_invoice', {
            invoice_id: Number(state.invoiceB.id),
            channel: 'email',
            message: 'Must not leave tenant B.',
        })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(await snapshotCompany(state.companyB)).toBe(beforeB);
    });

    databaseTest('recipient injection, missing Contact address, and mailbox outage send zero messages', async () => {
        const resolved = await resolveA();
        await expect(invoke(resolved, 'svc.send_estimate', {
            estimate_id: Number(state.estimateA.id),
            channel: 'email',
            recipient: 'attacker@example.test',
        })).rejects.toMatchObject({ mcpCode: 'invalid_request' });
        expect(mockSendEmail).not.toHaveBeenCalled();

        const client = await db.pool.connect();
        let noRecipientEstimate;
        try {
            await client.query('BEGIN');
            const contact = await client.query(
                `INSERT INTO contacts (company_id, full_name)
                 VALUES ($1, 'S3 No Recipient')
                 RETURNING id`,
                [state.companyA]
            );
            const job = await client.query(
                `INSERT INTO jobs
                    (company_id, contact_id, blanc_status, zb_status, customer_name,
                     service_name, notes, zb_raw)
                 VALUES ($1,$2,'Submitted','scheduled','S3 No Recipient',
                         'S3 missing recipient','[]'::jsonb,'{}'::jsonb)
                 RETURNING id`,
                [state.companyA, contact.rows[0].id]
            );
            noRecipientEstimate = await estimatesService.createEstimate(
                state.companyA,
                state.identityA.aiUser.id,
                {
                    job_id: Number(job.rows[0].id),
                    summary: 'Missing recipient',
                    items: [{ name: 'Item', quantity: 1, unit_price: 10 }],
                },
                client
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        await expect(invoke(resolved, 'svc.send_estimate', {
            estimate_id: Number(noRecipientEstimate.id),
            channel: 'email',
        })).rejects.toMatchObject({ code: 'NO_RECIPIENT', httpStatus: 422 });
        expect(mockSendEmail).not.toHaveBeenCalled();

        mockGetMailboxStatus.mockResolvedValueOnce({ status: 'disconnected' });
        await expect(invoke(resolved, 'svc.send_estimate', {
            estimate_id: Number(state.estimateA.id),
            channel: 'email',
            message: 'Mailbox outage attempt.',
        })).rejects.toMatchObject({
            code: 'MAILBOX_NOT_CONNECTED',
            httpStatus: 409,
        });
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
});

afterAll(async () => {
    if (oldIssuer === undefined) delete process.env.KEYCLOAK_REALM_URL;
    else process.env.KEYCLOAK_REALM_URL = oldIssuer;
    if (oldClientId === undefined) delete process.env.CHATGPT_MCP_CLIENT_ID;
    else process.env.CHATGPT_MCP_CLIENT_ID = oldClientId;
    if (oldPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = oldPublicAppUrl;
    try { await db.pool.end(); } catch { /* ignore */ }
});
