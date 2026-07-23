'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const mcpQueries = require('../backend/src/db/chatgptMcpQueries');
const jobsService = require('../backend/src/services/jobsService');
const leadsService = require('../backend/src/services/leadsService');
const contactsService = require('../backend/src/services/contactsService');
const scheduleService = require('../backend/src/services/scheduleService');
const tasksQueries = require('../backend/src/db/tasksQueries');
const identityService = require('../backend/src/services/chatgptMcpIdentityService');
const protocol = require('../backend/src/services/agentSkillsMcpProtocolService');
const permissions = require('../backend/src/services/chatgptMcpPermissions');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '195_chatgpt_crm_mcp.sql'), 'utf8');
const SEED = fs.readFileSync(path.join(MIGRATIONS, '196_seed_chatgpt_crm_mcp_marketplace_app.sql'), 'utf8');

jest.setTimeout(60000);

function probeDatabase() {
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_USE_SYSTEM_CA;
    const pgModule = require.resolve('pg');
    const script = `
        const { Client } = require(${JSON.stringify(pgModule)});
        const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls', connectionTimeoutMillis: 2000 });
        (async () => { try { await client.connect(); await client.query('SELECT 1'); await client.end(); process.exit(0); }
        catch (error) { process.stderr.write(String(error.message || error)); try { await client.end(); } catch {} process.exit(2); } })();`;
    const result = spawnSync(process.execPath, ['--use-bundled-ca', '-e', script], {
        env: probeEnv, encoding: 'utf8', timeout: 6000,
    });
    return { ready: result.status === 0, reason: String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim() };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    test('ChatGPT MCP tenancy DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`ChatGPT MCP tenancy DB tests are pending: ${DATABASE.reason}`);
    });
}

async function snapshotCompany(client, companyId) {
    const { rows } = await client.query(
        `SELECT
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM contacts x WHERE x.company_id=$1) AS contacts,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM jobs x WHERE x.company_id=$1) AS jobs,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM leads x WHERE x.company_id=$1) AS leads,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM estimates x WHERE x.company_id=$1) AS estimates,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM invoices x WHERE x.company_id=$1) AS invoices,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM payment_transactions x WHERE x.company_id=$1) AS payments,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM tasks x WHERE x.company_id=$1) AS tasks,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM marketplace_installations x WHERE x.company_id=$1) AS installations,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM chatgpt_mcp_bindings x WHERE x.company_id=$1) AS bindings,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM mcp_agent_permission_grants x WHERE x.company_id=$1) AS grants,
            (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM mcp_tool_invocations x WHERE x.company_id=$1) AS invocations`,
        [companyId]
    );
    return JSON.stringify(rows[0]);
}

describe('CHATGPT-CRM-MCP S1 real-PostgreSQL tenancy contract', () => {
    databaseTest('migration 195 applies with same-company duplicate contact phone rows intact (email stays globally unique)', async () => {
        const client = await db.pool.connect();
        const companyId = randomUUID();
        const duplicatePhone = `+1555${String(Date.now()).slice(-7)}`;
        const duplicateEmail = `prod-duplicate-${Date.now()}@example.test`;
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO companies (id, name, slug, status, timezone)
                 VALUES ($1, 'Prod Duplicate Shape', $2, 'active', 'America/New_York')`,
                [companyId, `mcp-prod-duplicate-${companyId}`]
            );
            await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164, email)
                 VALUES ($1, 'Shared Contact One', $2, $3),
                        ($1, 'Shared Contact Two', $2, $4)`,
                [companyId, duplicatePhone, `one-${duplicateEmail}`, `two-${duplicateEmail}`]
            );
            await expect(client.query(SCHEMA)).resolves.toBeDefined();
            const duplicates = await client.query(
                `SELECT COUNT(*)::int AS count
                 FROM contacts
                 WHERE company_id=$1 AND phone_e164=$2`,
                [companyId, duplicatePhone]
            );
            expect(duplicates.rows[0].count).toBe(2);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    databaseTest('SAB-MCP-FOREIGN / T-own / T-foreign / T-blast: A reads never return or change B sharing natural keys', async () => {
        const client = await db.pool.connect();
        const companyA = randomUUID();
        const companyB = randomUUID();
        const sharedPhone = `+1555${String(Date.now()).slice(-7)}`;
        const sharedEmail = `shared-${Date.now()}@example.test`;
        const sharedText = `MCP-SHARED-${Date.now()}`;
        const oldIssuer = process.env.KEYCLOAK_REALM_URL;
        const oldClientId = process.env.CHATGPT_MCP_CLIENT_ID;
        process.env.KEYCLOAK_REALM_URL = 'https://auth.albusto.test/realms/crm-prod';
        process.env.CHATGPT_MCP_CLIENT_ID = 'chatgpt-crm-mcp';
        let dbSpy;
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            await client.query(SEED);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));

            await client.query(
                `INSERT INTO companies (id, name, slug, status, timezone)
                 VALUES ($1, 'Tenant A', $2, 'active', 'America/New_York'),
                        ($3, 'Tenant B', $4, 'active', 'America/Chicago')`,
                [companyA, `mcp-ten-a-${companyA}`, companyB, `mcp-ten-b-${companyB}`]
            );
            const humans = await client.query(
                `INSERT INTO crm_users
                    (keycloak_sub, email, full_name, role, status, company_id, platform_role, onboarding_status, kind)
                 VALUES ($1, $2, 'Admin A', 'company_member', 'active', $3, 'none', 'active', 'user'),
                        ($4, $5, 'Admin B', 'company_member', 'active', $6, 'none', 'active', 'user')
                 RETURNING id, company_id`,
                [`ten-a-${companyA}`, `admin-a-${companyA}@test`, companyA, `ten-b-${companyB}`, `admin-b-${companyB}@test`, companyB]
            );
            const humanA = humans.rows.find((row) => row.company_id === companyA);
            const humanB = humans.rows.find((row) => row.company_id === companyB);
            await client.query(
                `INSERT INTO company_memberships (user_id, company_id, role, role_key, status)
                 VALUES ($1,$2,'company_admin','tenant_admin','active'), ($3,$4,'company_admin','tenant_admin','active')`,
                [humanA.id, companyA, humanB.id, companyB]
            );
            const app = await client.query(`SELECT id FROM marketplace_apps WHERE app_key='chatgpt-crm-mcp'`);
            const installs = await client.query(
                `INSERT INTO marketplace_installations (company_id, app_id, status, installed_by, installed_at)
                 VALUES ($1,$3,'connected',$4,NOW()), ($2,$3,'connected',$5,NOW()) RETURNING id, company_id`,
                [companyA, companyB, app.rows[0].id, humanA.id, humanB.id]
            );
            const provisionA = await identityService.provisionInstallation({
                companyId: companyA,
                installationId: installs.rows.find((x) => x.company_id === companyA).id,
                actorId: humanA.id,
            }, client);
            await identityService.provisionInstallation({
                companyId: companyB,
                installationId: installs.rows.find((x) => x.company_id === companyB).id,
                actorId: humanB.id,
            }, client);

            const contacts = await client.query(
                `INSERT INTO contacts (company_id, full_name, phone_e164, email)
                 VALUES ($1,$3,$5,$6), ($2,$4,$5,$7) RETURNING id, company_id`,
                [companyA, companyB, `${sharedText} A`, `${sharedText} B`, sharedPhone, `a-${sharedEmail}`, `b-${sharedEmail}`]
            );
            const contactA = contacts.rows.find((row) => row.company_id === companyA).id;
            const contactB = contacts.rows.find((row) => row.company_id === companyB).id;
            const sharedNaturalKeys = await client.query(
                `SELECT company_id, id
                 FROM contacts
                 WHERE phone_e164=$1
                 ORDER BY company_id`,
                [sharedPhone]
            );
            expect(new Set(sharedNaturalKeys.rows.map((row) => row.company_id)))
                .toEqual(new Set([companyA, companyB]));
            await client.query(
                `INSERT INTO contact_emails (contact_id,email,email_normalized,is_primary)
                 VALUES ($1,$3,LOWER($3),true), ($2,$3,LOWER($3),true)
                 ON CONFLICT (contact_id,email_normalized) DO NOTHING`,
                [contactA, contactB, sharedEmail]
            );
            const timelines = await client.query(
                `INSERT INTO timelines (company_id, contact_id, phone_e164)
                 VALUES ($1,$3,$5), ($2,$4,$6), ($1,NULL,$7), ($2,NULL,$8)
                 RETURNING id, company_id, contact_id`,
                [
                    companyA,
                    companyB,
                    contactA,
                    contactB,
                    `+1555100${String(contactA).padStart(4, '0')}`,
                    `+1555200${String(contactB).padStart(4, '0')}`,
                    `+1555300${String(contactA).padStart(4, '0')}`,
                    `+1555400${String(contactB).padStart(4, '0')}`,
                ]
            );
            const timelineFor = (companyId, linked) => timelines.rows.find(
                (row) => row.company_id === companyId && (row.contact_id !== null) === linked
            ).id;
            const calls = await client.query(
                `INSERT INTO calls (
                    call_sid, contact_id, timeline_id, company_id, direction,
                    from_number, to_number, status, is_final, started_at,
                    answered_at, ended_at, duration_sec, answered_by
                 )
                 VALUES
                    ($1,$5,$7,$3,'inbound',$9,$10,'completed',true,NOW()-INTERVAL '1 day',
                     NOW()-INTERVAL '1 day'+INTERVAL '2 seconds',NOW()-INTERVAL '1 day'+INTERVAL '5 minutes',298,'ai'),
                    ($2,NULL,$8,$3,'outbound',$10,$9,'completed',true,NOW()-INTERVAL '2 days',
                     NOW()-INTERVAL '2 days'+INTERVAL '3 seconds',NOW()-INTERVAL '2 days'+INTERVAL '4 minutes',237,NULL),
                    ($4,$6,$11,$12,'inbound',$9,$10,'completed',true,NOW()-INTERVAL '1 day',
                     NOW()-INTERVAL '1 day'+INTERVAL '1 second',NOW()-INTERVAL '1 day'+INTERVAL '6 minutes',359,'ai'),
                    ($13,NULL,$14,$12,'outbound',$10,$9,'completed',true,NOW()-INTERVAL '2 days',
                     NOW()-INTERVAL '2 days'+INTERVAL '4 seconds',NOW()-INTERVAL '2 days'+INTERVAL '3 minutes',176,NULL)
                 RETURNING id, company_id, contact_id`,
                [
                    `CA-A-LINKED-${Date.now()}`,
                    `CA-A-ORPHAN-${Date.now()}`,
                    companyA,
                    `CA-B-LINKED-${Date.now()}`,
                    contactA,
                    contactB,
                    timelineFor(companyA, true),
                    timelineFor(companyA, false),
                    sharedPhone,
                    '+15559990000',
                    timelineFor(companyB, true),
                    companyB,
                    `CA-B-ORPHAN-${Date.now()}`,
                    timelineFor(companyB, false),
                ]
            );
            const callIdsA = calls.rows
                .filter((row) => row.company_id === companyA)
                .map((row) => String(row.id))
                .sort();
            const callIdsB = calls.rows
                .filter((row) => row.company_id === companyB)
                .map((row) => String(row.id))
                .sort();
            const jobs = await client.query(
                `INSERT INTO jobs (company_id,contact_id,job_number,customer_name,customer_phone,customer_email,service_name,blanc_status,start_date,end_date)
                 VALUES ($1,$3,$5,$6,$7,$8,$5,'Submitted',NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day 2 hours'),
                        ($2,$4,$5,$9,$7,$8,$5,'Submitted',NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day 2 hours')
                 RETURNING id, company_id`,
                [companyA, companyB, contactA, contactB, sharedText, `${sharedText} A`, sharedPhone, sharedEmail, `${sharedText} B`]
            );
            const jobA = jobs.rows.find((row) => row.company_id === companyA).id;
            const jobB = jobs.rows.find((row) => row.company_id === companyB).id;
            const leads = await client.query(
                `INSERT INTO leads (company_id,uuid,status,first_name,phone,email,contact_id,lead_date_time,lead_end_date_time)
                 VALUES ($1,$3,'Submitted',$5,$7,$8,$9,NOW()+INTERVAL '2 days',NOW()+INTERVAL '2 days 2 hours'),
                        ($2,$4,'Submitted',$6,$7,$8,$10,NOW()+INTERVAL '2 days',NOW()+INTERVAL '2 days 2 hours')
                 RETURNING id, uuid, company_id`,
                [companyA, companyB, `A${String(Date.now()).slice(-8)}`, `B${String(Date.now()).slice(-8)}`, `${sharedText}A`, `${sharedText}B`, sharedPhone, sharedEmail, contactA, contactB]
            );
            const leadA = leads.rows.find((row) => row.company_id === companyA);
            const leadB = leads.rows.find((row) => row.company_id === companyB);
            const estimates = await client.query(
                `INSERT INTO estimates (company_id,estimate_number,status,contact_id,job_id,summary,total)
                 VALUES ($1,$5::varchar,'draft',$3,$6,$5::text,100),
                        ($2,$5::varchar,'draft',$4,$7,$5::text,200)
                 RETURNING id, company_id`,
                [companyA, companyB, contactA, contactB, sharedText, jobA, jobB]
            );
            const estimateA = estimates.rows.find((row) => row.company_id === companyA).id;
            const estimateB = estimates.rows.find((row) => row.company_id === companyB).id;
            await client.query(
                `INSERT INTO estimate_items (estimate_id,name,quantity,unit_price,amount)
                 VALUES ($1,$3,1,100,100), ($2,$4,1,200,200)`,
                [estimateA, estimateB, `${sharedText} item A`, `${sharedText} item B`]
            );
            const invoices = await client.query(
                `INSERT INTO invoices (company_id,invoice_number,status,contact_id,job_id,estimate_id,title,total,balance_due)
                 VALUES ($1,$5::varchar,'sent',$3,$6,$8,$5::text,100,100),
                        ($2,$5::varchar,'sent',$4,$7,$9,$5::text,200,200)
                 RETURNING id, company_id`,
                [companyA, companyB, contactA, contactB, sharedText, jobA, jobB, estimateA, estimateB]
            );
            const invoiceA = invoices.rows.find((row) => row.company_id === companyA).id;
            const invoiceB = invoices.rows.find((row) => row.company_id === companyB).id;
            await client.query(
                `INSERT INTO invoice_items (invoice_id,name,quantity,unit_price,amount)
                 VALUES ($1,$3,1,100,100), ($2,$4,1,200,200)`,
                [invoiceA, invoiceB, `${sharedText} invoice item A`, `${sharedText} invoice item B`]
            );
            await client.query(
                `INSERT INTO payment_transactions (company_id,contact_id,invoice_id,job_id,transaction_type,payment_method,status,amount,currency)
                 VALUES ($1,$3,$5,$7,'payment','cash','completed',10,'USD'),
                        ($2,$4,$6,$8,'payment','cash','completed',20,'USD')`,
                [companyA, companyB, contactA, contactB, invoiceA, invoiceB, jobA, jobB]
            );
            await client.query(
                `INSERT INTO tasks (company_id,title,description,status,created_by,job_id)
                 VALUES ($1,$3,$3,'open','user',$4), ($2,$3,$3,'open','user',$5)`,
                [companyA, companyB, sharedText, jobA, jobB]
            );

            const beforeB = await snapshotCompany(client, companyB);

            const contactList = await contactsService.listContacts({ companyId: companyA, search: sharedEmail, limit: 20, offset: 0 });
            expect(contactList.results.map((row) => row.company_id)).toEqual([companyA]);
            const jobList = await jobsService.listJobs({ companyId: companyA, search: sharedText, limit: 20, offset: 0 });
            expect(jobList.results.every((row) => row.company_id === companyA)).toBe(true);
            const leadList = await leadsService.listLeads({ companyId: companyA, search: sharedEmail, only_open: false, limit: 20, offset: 0 });
            expect(leadList.results.map((row) => row.UUID)).toEqual([leadA.uuid]);
            expect((await mcpQueries.listEstimates(companyA, { search: sharedText })).rows.every((row) => row.company_id === companyA)).toBe(true);
            expect((await mcpQueries.listInvoices(companyA, { search: sharedText })).rows.every((row) => row.company_id === companyA)).toBe(true);
            expect((await tasksQueries.listTasksPage(companyA, { status: 'open', limit: 20, offset: 0 })).tasks.every((row) => row.company_id === companyA)).toBe(true);
            expect((await scheduleService.getScheduleItems(companyA, { limit: 50, offset: 0 })).items.every((row) => row.company_id === companyA)).toBe(true);
            const callPage = await mcpQueries.listCalls(companyA, { limit: 50 });
            expect(callPage.total).toBe(2);
            expect(callPage.rows.map((row) => String(row.id)).sort()).toEqual(callIdsA);
            expect(callPage.rows.map((row) => String(row.id))).not.toEqual(
                expect.arrayContaining(callIdsB)
            );
            expect(callPage.rows).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    contact_id: String(contactA),
                    contact_name: `${sharedText} A`,
                    answered_by: 'ai',
                }),
                expect.objectContaining({
                    contact_id: null,
                    contact_name: null,
                }),
            ]));

            await expect(mcpQueries.getJob(companyA, jobB)).resolves.toBeNull();
            await expect(mcpQueries.getLead(companyA, leadB.uuid)).resolves.toBeNull();
            await expect(mcpQueries.getContact(companyA, contactB)).resolves.toBeNull();
            await expect(mcpQueries.getEstimate(companyA, estimateB)).resolves.toBeNull();
            await expect(mcpQueries.getInvoice(companyA, invoiceB)).resolves.toBeNull();
            await expect(scheduleService.getScheduleItemDetail(companyA, 'job', jobB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
            await expect(tasksQueries.parentExists(companyA, 'job', jobB)).resolves.toBe(false);

            const ownEstimate = await mcpQueries.getEstimate(companyA, estimateA);
            expect(ownEstimate.items.map((item) => item.name)).toEqual([`${sharedText} item A`]);
            const ownInvoice = await mcpQueries.getInvoice(companyA, invoiceA);
            expect(ownInvoice.items.map((item) => item.name)).toEqual([`${sharedText} invoice item A`]);
            expect(ownInvoice.payments.map((payment) => Number(payment.amount))).toEqual([10]);

            const granted = await client.query(
                `SELECT permission_key
                 FROM mcp_agent_permission_grants
                 WHERE company_id=$1 AND agent_user_id=$2
                 ORDER BY permission_key`,
                [companyA, provisionA.aiUser.id]
            );
            const protocolReq = {
                requestId: `mcp-protocol-${randomUUID()}`,
                companyFilter: { company_id: companyA },
                user: {
                    kind: 'agent',
                    email: provisionA.aiUser.email,
                    oauthAuthorizerId: humanA.id,
                    crmUser: {
                        id: provisionA.aiUser.id,
                        email: provisionA.aiUser.email,
                        full_name: provisionA.aiUser.full_name,
                        company_id: companyA,
                        kind: 'agent',
                        status: 'active',
                    },
                },
                authz: {
                    company: {
                        id: companyA,
                        name: 'Tenant A',
                        status: 'active',
                        timezone: 'America/New_York',
                    },
                    membership: null,
                    permissions: granted.rows.map((row) => row.permission_key),
                    oauthScopes: [permissions.READ_SCOPE],
                },
                chatgptMcpBinding: {
                    id: provisionA.binding.id,
                    installationId: provisionA.binding.installation_id,
                    authorizerId: humanA.id,
                },
            };
            let protocolId = 1000;
            const callTool = async (name, args) => {
                protocolId += 1;
                return protocol.handleJsonRpc(protocolReq, {
                    jsonrpc: '2.0',
                    id: protocolId,
                    method: 'tools/call',
                    params: { name, arguments: args },
                });
            };
            const ownCases = [
                ['svc.list_jobs', { search: sharedText, limit: 20 }, (data) => {
                    expect(data.results.map((row) => String(row.id))).toEqual([String(jobA)]);
                }],
                ['svc.get_job', { job_id: Number(jobA) }, (data) => {
                    expect(String(data.id)).toBe(String(jobA));
                }],
                ['svc.get_job_transitions', { job_id: Number(jobA) }, (data) => {
                    expect(data).toHaveProperty('actions');
                }],
                ['svc.list_leads', { search: sharedEmail, only_open: false, limit: 20 }, (data) => {
                    expect(data.results.map((row) => row.UUID)).toEqual([leadA.uuid]);
                }],
                ['svc.get_lead', { lead_uuid: leadA.uuid }, (data) => {
                    expect(data.uuid).toBe(leadA.uuid);
                }],
                ['svc.get_lead_transitions', { lead_uuid: leadA.uuid }, (data) => {
                    expect(data).toHaveProperty('actions');
                }],
                ['svc.search_contacts', { search: sharedEmail, limit: 20 }, (data) => {
                    expect(data.results.map((row) => String(row.id))).toEqual([String(contactA)]);
                }],
                ['svc.get_contact', { contact_id: Number(contactA) }, (data) => {
                    expect(String(data.id)).toBe(String(contactA));
                }],
                ['svc.get_contact_history', { contact_id: Number(contactA), limit: 20 }, (data) => {
                    expect(String(data.contact.id)).toBe(String(contactA));
                }],
                ['svc.list_schedule', { search: sharedText, limit: 20 }, (data) => {
                    expect(data.items.map((row) => String(row.entity_id))).toContain(String(jobA));
                    expect(data.items.map((row) => String(row.entity_id))).not.toContain(String(jobB));
                }],
                ['svc.list_calls', { limit: 20 }, (data) => {
                    expect(data.rows.map((row) => String(row.id)).sort()).toEqual(callIdsA);
                }],
                ['svc.get_schedule_item', { entity_type: 'job', entity_id: Number(jobA) }, (data) => {
                    expect(String(data.id || data.entity_id)).toBe(String(jobA));
                }],
                ['svc.list_tasks', { status: 'open', search: sharedText, limit: 20 }, (data) => {
                    expect(data.tasks).toHaveLength(1);
                    expect(data.tasks[0].parent_type).toBe('job');
                    expect(String(data.tasks[0].parent_id)).toBe(String(jobA));
                }],
                ['svc.list_entity_tasks', { parent_type: 'job', parent_id: String(jobA) }, (data) => {
                    expect(data.tasks).toHaveLength(1);
                    expect(data.tasks[0].parent_type).toBe('job');
                    expect(String(data.tasks[0].parent_id)).toBe(String(jobA));
                }],
                ['svc.list_task_assignees', { limit: 100 }, (data) => {
                    expect(data.users.map((row) => row.id)).toContain(humanA.id);
                    expect(data.users.map((row) => row.id)).not.toContain(humanB.id);
                }],
                ['svc.list_estimates', { search: sharedText, limit: 20 }, (data) => {
                    expect(data.rows.map((row) => String(row.id))).toEqual([String(estimateA)]);
                }],
                ['svc.get_estimate', { estimate_id: Number(estimateA) }, (data) => {
                    expect(String(data.id)).toBe(String(estimateA));
                }],
                ['svc.list_invoices', { search: sharedText, limit: 20 }, (data) => {
                    expect(data.rows.map((row) => String(row.id))).toEqual([String(invoiceA)]);
                }],
                ['svc.get_invoice', { invoice_id: Number(invoiceA) }, (data) => {
                    expect(String(data.id)).toBe(String(invoiceA));
                }],
            ];
            expect(ownCases.map(([name]) => name).sort()).toEqual(
                [...permissions.READ_TOOL_NAMES].sort()
            );
            for (const [name, args, assertOwn] of ownCases) {
                const response = await callTool(name, args);
                expect(response.error).toBeUndefined();
                assertOwn(response.result.structuredContent);
            }

            const foreignCases = [
                ['svc.get_job', { job_id: Number(jobB) }],
                ['svc.get_job_transitions', { job_id: Number(jobB) }],
                ['svc.get_lead', { lead_uuid: leadB.uuid }],
                ['svc.get_lead_transitions', { lead_uuid: leadB.uuid }],
                ['svc.get_contact', { contact_id: Number(contactB) }],
                ['svc.get_contact_history', { contact_id: Number(contactB), limit: 20 }],
                ['svc.get_schedule_item', { entity_type: 'job', entity_id: Number(jobB) }],
                ['svc.list_entity_tasks', { parent_type: 'job', parent_id: String(jobB) }],
                ['svc.get_estimate', { estimate_id: Number(estimateB) }],
                ['svc.get_invoice', { invoice_id: Number(invoiceB) }],
            ];
            for (const [name, args] of foreignCases) {
                const response = await callTool(name, args);
                expect(response.error).toEqual(expect.objectContaining({
                    code: -32004,
                    data: expect.objectContaining({ code: 'not_found' }),
                }));
            }
            expect(await snapshotCompany(client, companyB)).toBe(beforeB);
        } finally {
            if (dbSpy) dbSpy.mockRestore();
            await client.query('ROLLBACK');
            client.release();
            if (oldIssuer === undefined) delete process.env.KEYCLOAK_REALM_URL;
            else process.env.KEYCLOAK_REALM_URL = oldIssuer;
            if (oldClientId === undefined) delete process.env.CHATGPT_MCP_CLIENT_ID;
            else process.env.CHATGPT_MCP_CLIENT_ID = oldClientId;
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* ignore */ }
});
