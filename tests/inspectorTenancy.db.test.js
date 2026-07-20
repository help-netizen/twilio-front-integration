'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/inspectorQueries');
const classifier = require('../backend/src/services/inspectorClassifier');
const taskService = require('../backend/src/services/inspectorTaskService');

const MIGRATION = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/191_inspector_agent.sql'),
    'utf8'
);
const SEED = fs.readFileSync(
    path.join(__dirname, '../backend/db/migrations/192_seed_inspector_marketplace_app.sql'),
    'utf8'
);

jest.setTimeout(60000);

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const SHARED_PHONE = `+1555${String(Date.now()).slice(-7)}`;
const TAG_A = `INSP-A-${Date.now()}`;
const TAG_B = `INSP-B-${Date.now()}`;

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
            try {
                await client.connect();
                await client.query('SELECT 1');
                await client.end();
                process.exit(0);
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
    return {
        ready: result.status === 0,
        reason: String(result.stderr || result.error?.message || `probe exit ${result.status}`).trim(),
    };
}

const DATABASE = probeDatabase();
const databaseTest = DATABASE.ready ? test : test.skip;
if (!DATABASE.ready) {
    console.warn(`Inspector tenancy DB tests are PENDING (database unavailable): ${DATABASE.reason}`);
    test('Inspector tenancy DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`Inspector tenancy DB tests are pending: ${DATABASE.reason}`);
    });
}

async function snapshotB(client) {
    const { rows } = await client.query(
        `SELECT
            (SELECT COALESCE(jsonb_agg(to_jsonb(contact) ORDER BY contact.id), '[]'::JSONB)
             FROM contacts contact WHERE contact.company_id = $1) AS contacts,
            (SELECT COALESCE(jsonb_agg(to_jsonb(job) ORDER BY job.id), '[]'::JSONB)
             FROM jobs job WHERE job.company_id = $1) AS jobs,
            (SELECT COALESCE(jsonb_agg(to_jsonb(lead) ORDER BY lead.id), '[]'::JSONB)
             FROM leads lead WHERE lead.company_id = $1) AS leads,
            (SELECT COALESCE(jsonb_agg(to_jsonb(estimate) ORDER BY estimate.id), '[]'::JSONB)
             FROM estimates estimate WHERE estimate.company_id = $1) AS estimates,
            (SELECT COALESCE(jsonb_agg(to_jsonb(invoice) ORDER BY invoice.id), '[]'::JSONB)
             FROM invoices invoice WHERE invoice.company_id = $1) AS invoices,
            (SELECT COALESCE(jsonb_agg(to_jsonb(payment) ORDER BY payment.id), '[]'::JSONB)
             FROM payment_transactions payment WHERE payment.company_id = $1) AS payment_transactions,
            (SELECT COALESCE(jsonb_agg(to_jsonb(call) ORDER BY call.id), '[]'::JSONB)
             FROM calls call WHERE call.company_id = $1) AS calls,
            (SELECT COALESCE(jsonb_agg(to_jsonb(transcript) ORDER BY transcript.id), '[]'::JSONB)
             FROM transcripts transcript WHERE transcript.company_id = $1) AS transcripts,
            (SELECT COALESCE(jsonb_agg(to_jsonb(conversation) ORDER BY conversation.id), '[]'::JSONB)
             FROM sms_conversations conversation WHERE conversation.company_id = $1) AS sms_conversations,
            (SELECT COALESCE(jsonb_agg(to_jsonb(message) ORDER BY message.id), '[]'::JSONB)
             FROM sms_messages message WHERE message.company_id = $1) AS sms_messages,
            (SELECT COALESCE(jsonb_agg(to_jsonb(mailbox) ORDER BY mailbox.id), '[]'::JSONB)
             FROM email_mailboxes mailbox WHERE mailbox.company_id = $1) AS email_mailboxes,
            (SELECT COALESCE(jsonb_agg(to_jsonb(thread) ORDER BY thread.id), '[]'::JSONB)
             FROM email_threads thread WHERE thread.company_id = $1) AS email_threads,
            (SELECT COALESCE(jsonb_agg(to_jsonb(message) ORDER BY message.id), '[]'::JSONB)
             FROM email_messages message WHERE message.company_id = $1) AS email_messages,
            (SELECT COALESCE(jsonb_agg(to_jsonb(task) ORDER BY task.id), '[]'::JSONB)
             FROM tasks task WHERE task.company_id = $1) AS tasks,
            (SELECT COALESCE(jsonb_agg(to_jsonb(timeline) ORDER BY timeline.id), '[]'::JSONB)
             FROM timelines timeline WHERE timeline.company_id = $1) AS timelines,
            (SELECT COALESCE(jsonb_agg(to_jsonb(review) ORDER BY review.id), '[]'::JSONB)
             FROM inspector_reviews review WHERE review.company_id = $1) AS reviews,
            (SELECT COALESCE(jsonb_agg(to_jsonb(settings)), '[]'::JSONB)
             FROM inspector_settings settings WHERE settings.company_id = $1) AS inspector_settings,
            (SELECT COALESCE(jsonb_agg(to_jsonb(installation) ORDER BY installation.id), '[]'::JSONB)
             FROM marketplace_installations installation WHERE installation.company_id = $1) AS marketplace_installations,
            (SELECT COALESCE(jsonb_agg(to_jsonb(run) ORDER BY run.id), '[]'::JSONB)
             FROM inspector_daily_runs run WHERE run.company_id = $1) AS inspector_daily_runs`,
        [COMPANY_B]
    );
    return JSON.stringify(rows[0]);
}

describe('Inspector real-PostgreSQL tenancy and claim gate', () => {
    databaseTest('SAB-INSP-T-BLAST + SAB-INSP-TIMELINE-TENANT: A Job/Lead context/task cannot read or mutate B sharing natural keys', async () => {
        const client = await db.pool.connect();
        await client.query('SELECT company_id FROM tasks LIMIT 0');
        await client.query('SELECT archived_at FROM estimates LIMIT 0');
        await client.query('SELECT contact_id FROM email_messages LIMIT 0');

        try {
            await client.query('BEGIN');
            await client.query(MIGRATION);
            await client.query(SEED);
            await client.query(
                `INSERT INTO companies (id, name, slug, timezone)
                 VALUES ($1, $2, $3, 'America/New_York'),
                        ($4, $5, $6, 'America/New_York')`,
                [
                    COMPANY_A, `${TAG_A} Company`, `${TAG_A.toLowerCase()}-company`,
                    COMPANY_B, `${TAG_B} Company`, `${TAG_B.toLowerCase()}-company`,
                ]
            );
            const inspectorApp = await client.query(
                `SELECT id FROM marketplace_apps WHERE app_key = 'inspector'`
            );
            await client.query(
                `INSERT INTO inspector_settings (company_id)
                 VALUES ($1), ($2)`,
                [COMPANY_A, COMPANY_B]
            );
            await client.query(
                `INSERT INTO marketplace_installations
                    (company_id, app_id, status, installed_at)
                 VALUES ($1, $3, 'connected', NOW()),
                        ($2, $3, 'connected', NOW())`,
                [COMPANY_A, COMPANY_B, inspectorApp.rows[0].id]
            );
            await client.query(
                `INSERT INTO inspector_daily_runs
                    (company_id, company_local_date, timezone, status, lease_expires_at)
                 VALUES ($1, '2026-07-19', 'America/New_York', 'succeeded', '2026-07-19T17:00:00Z'),
                        ($2, '2026-07-19', 'America/New_York', 'succeeded', '2026-07-19T17:00:00Z')`,
                [COMPANY_A, COMPANY_B]
            );
            const contacts = await client.query(
                `INSERT INTO contacts (company_id, full_name, email)
                 VALUES ($1, $2, $3), ($4, $5, $6)
                 RETURNING id, company_id`,
                [
                    COMPANY_A, `${TAG_A} Contact`, `${TAG_A.toLowerCase()}@example.com`,
                    COMPANY_B, `${TAG_B} Contact`, `${TAG_B.toLowerCase()}@example.com`,
                ]
            );
            const contactA = contacts.rows.find(row => row.company_id === COMPANY_A).id;
            const contactB = contacts.rows.find(row => row.company_id === COMPANY_B).id;
            const jobs = await client.query(
                `INSERT INTO jobs
                    (company_id, contact_id, job_number, customer_name, customer_phone,
                     blanc_status, start_date, notes)
                 VALUES
                    ($1, $2, 'SHARED-1345', $3, $7, 'Submitted',
                     '2026-07-10T14:00:00Z', $8::JSONB),
                    ($4, $5, 'SHARED-1345', $6, $7, 'Submitted',
                     '2026-07-10T14:00:00Z', $9::JSONB)
                 RETURNING id, company_id`,
                [
                    COMPANY_A, contactA, `${TAG_A} Customer`,
                    COMPANY_B, contactB, `${TAG_B} Customer`,
                    SHARED_PHONE,
                    JSON.stringify([{ id: randomUUID(), text: `${TAG_A} NOTE`, created: '2026-07-18T12:00:00Z' }]),
                    JSON.stringify([{ id: randomUUID(), text: `${TAG_B} SECRET NOTE`, created: '2026-07-18T12:00:00Z' }]),
                ]
            );
            const jobA = jobs.rows.find(row => row.company_id === COMPANY_A).id;
            const jobB = jobs.rows.find(row => row.company_id === COMPANY_B).id;
            const leads = await client.query(
                `INSERT INTO leads
                    (company_id, uuid, status, first_name, phone, email, contact_id,
                     structured_notes, updated_at)
                 VALUES
                    ($1, $3, 'Submitted', $4, $7, $8, $2, $9::JSONB,
                     '2026-07-18T14:00:00Z'),
                    ($5, $10, 'Submitted', $6, $7, $8, $11, $12::JSONB,
                     '2026-07-18T14:00:00Z')
                 RETURNING id, company_id`,
                [
                    COMPANY_A, contactA, `IA${String(Date.now()).slice(-12)}`, `${TAG_A} Lead`,
                    COMPANY_B, `${TAG_B} Lead`, SHARED_PHONE, 'shared-inspector@example.com',
                    JSON.stringify([{ id: randomUUID(), text: `${TAG_A} LEAD NOTE`, created: '2026-07-18T11:00:00Z' }]),
                    `IB${String(Date.now()).slice(-12)}`, contactB,
                    JSON.stringify([{ id: randomUUID(), text: `${TAG_B} SECRET LEAD NOTE`, created: '2026-07-18T11:00:00Z' }]),
                ]
            );
            const leadA = leads.rows.find(row => row.company_id === COMPANY_A).id;
            const leadB = leads.rows.find(row => row.company_id === COMPANY_B).id;

            await client.query(
                `INSERT INTO estimates
                    (company_id, estimate_number, status, contact_id, job_id, total)
                 VALUES ($1, 'SHARED-EST', 'sent', $2, $3, 100),
                        ($4, 'SHARED-EST', 'sent', $5, $6, 999)`,
                [COMPANY_A, contactA, jobA, COMPANY_B, contactB, jobB]
            );
            await client.query(
                `INSERT INTO estimates
                    (company_id, estimate_number, status, contact_id, lead_id, total)
                 VALUES ($1, $3, 'sent', $2, $4, 150),
                        ($5, $7, 'sent', $6, $8, 888)`,
                [
                    COMPANY_A, contactA, `${TAG_A}-LEAD-EST`, leadA,
                    COMPANY_B, contactB, `${TAG_B}-SECRET-LEAD-EST`, leadB,
                ]
            );
            await client.query(
                `INSERT INTO invoices
                    (company_id, invoice_number, status, contact_id, job_id,
                     total, amount_paid, balance_due)
                 VALUES ($1, 'SHARED-INV', 'sent', $2, $3, 100, 0, 100),
                        ($4, 'SHARED-INV', 'sent', $5, $6, 999, 999, 0)`,
                [COMPANY_A, contactA, jobA, COMPANY_B, contactB, jobB]
            );
            await client.query(
                `INSERT INTO payment_transactions
                    (company_id, contact_id, job_id, transaction_type, payment_method,
                     status, amount, external_id, external_source, memo)
                 VALUES ($1, $2, $3, 'payment', 'cash', 'completed', 10,
                         'SHARED-INSP-PAYMENT', 'inspector-test', $4),
                        ($5, $6, $7, 'payment', 'cash', 'completed', 777,
                         'SHARED-INSP-PAYMENT', 'inspector-test', $8)`,
                [
                    COMPANY_A, contactA, jobA, `${TAG_A} PAYMENT`,
                    COMPANY_B, contactB, jobB, `${TAG_B} SECRET PAYMENT`,
                ]
            );

            await client.query(
                `INSERT INTO calls
                    (call_sid, contact_id, direction, status, is_final, started_at, company_id)
                 VALUES ($1, $2, 'inbound', 'completed', true, '2026-07-19T12:00:00Z', $3),
                        ($4, $5, 'inbound', 'completed', true, '2026-07-19T13:00:00Z', $6)`,
                [`CA${TAG_A}`, contactA, COMPANY_A, `CB${TAG_B}`, contactB, COMPANY_B]
            );
            await client.query(
                `INSERT INTO transcripts (call_sid, status, text, company_id)
                 VALUES ($1, 'completed', $2, $3), ($4, 'completed', $5, $6)`,
                [
                    `CA${TAG_A}`, `${TAG_A} CALL TRANSCRIPT`, COMPANY_A,
                    `CB${TAG_B}`, `${TAG_B} SECRET CALL TRANSCRIPT`, COMPANY_B,
                ]
            );
            await client.query(
                `INSERT INTO domain_events
                    (company_id, aggregate_type, aggregate_id, event_type, created_at)
                 VALUES ($1, 'job', $2, 'job.status_changed', '2026-07-18T12:00:00Z'),
                        ($3, 'job', $4, 'job.status_changed', '2026-07-19T12:00:00Z'),
                        ($1, 'lead', $5, 'lead.status_changed', '2026-07-18T10:00:00Z'),
                        ($3, 'lead', $6, 'lead.status_changed', '2026-07-19T10:00:00Z')`,
                [COMPANY_A, String(jobA), COMPANY_B, String(jobB), String(leadA), String(leadB)]
            );

            const conversations = await client.query(
                `INSERT INTO sms_conversations
                    (twilio_conversation_sid, state, customer_e164, proxy_e164, company_id)
                 VALUES ($1, 'closed', $3, '+15550000001', $2),
                        ($4, 'closed', $3, '+15550000002', $5)
                 RETURNING id, company_id`,
                [`CH${TAG_A}`, COMPANY_A, SHARED_PHONE, `CH${TAG_B}`, COMPANY_B]
            );
            const conversationA = conversations.rows.find(row => row.company_id === COMPANY_A).id;
            const conversationB = conversations.rows.find(row => row.company_id === COMPANY_B).id;
            await client.query(
                `INSERT INTO sms_messages
                    (conversation_id, direction, body, company_id)
                 VALUES ($1, 'inbound', $2, $3), ($4, 'inbound', $5, $6)`,
                [
                    conversationA, `${TAG_A} SMS`, COMPANY_A,
                    conversationB, `${TAG_B} SECRET SMS`, COMPANY_B,
                ]
            );

            const mailboxes = await client.query(
                `INSERT INTO email_mailboxes
                    (company_id, provider, email_address, status)
                 VALUES ($1, 'gmail', $3, 'connected'),
                        ($2, 'gmail', $4, 'connected')
                 RETURNING id, company_id`,
                [
                    COMPANY_A, COMPANY_B,
                    `${TAG_A.toLowerCase()}@mailbox.example.com`,
                    `${TAG_B.toLowerCase()}@mailbox.example.com`,
                ]
            );
            const mailboxA = mailboxes.rows.find(row => row.company_id === COMPANY_A).id;
            const mailboxB = mailboxes.rows.find(row => row.company_id === COMPANY_B).id;
            const emailThreads = await client.query(
                `INSERT INTO email_threads
                    (company_id, mailbox_id, provider_thread_id, subject)
                 VALUES ($1, $2, 'SHARED-INSP-THREAD', $3),
                        ($4, $5, 'SHARED-INSP-THREAD', $6)
                 RETURNING id, company_id`,
                [COMPANY_A, mailboxA, `${TAG_A} EMAIL`, COMPANY_B, mailboxB, `${TAG_B} SECRET EMAIL`]
            );
            const emailThreadA = emailThreads.rows.find(row => row.company_id === COMPANY_A).id;
            const emailThreadB = emailThreads.rows.find(row => row.company_id === COMPANY_B).id;
            await client.query(
                `INSERT INTO email_messages
                    (company_id, mailbox_id, thread_id, provider_message_id, direction,
                     from_email, subject, body_text, gmail_internal_at, contact_id)
                 VALUES ($1, $2, $3, 'SHARED-INSP-MESSAGE', 'inbound',
                         'shared-customer@example.com', $4, $5,
                         '2026-07-19T14:00:00Z', $6),
                        ($7, $8, $9, 'SHARED-INSP-MESSAGE', 'inbound',
                         'shared-customer@example.com', $10, $11,
                         '2026-07-19T15:00:00Z', $12)`,
                [
                    COMPANY_A, mailboxA, emailThreadA, `${TAG_A} EMAIL`, `${TAG_A} EMAIL BODY`, contactA,
                    COMPANY_B, mailboxB, emailThreadB, `${TAG_B} SECRET EMAIL`, `${TAG_B} SECRET EMAIL BODY`, contactB,
                ]
            );

            const timelines = await client.query(
                `INSERT INTO timelines (contact_id, company_id)
                 VALUES ($1, $2), ($3, $4)
                 RETURNING id, company_id`,
                [contactA, COMPANY_A, contactB, COMPANY_B]
            );
            const timelineA = timelines.rows.find(row => row.company_id === COMPANY_A).id;
            const timelineB = timelines.rows.find(row => row.company_id === COMPANY_B).id;

            const beforeB = await snapshotB(client);
            const contextA = await queries.getEntityContext(COMPANY_A, 'job', jobA, client);
            expect(JSON.stringify(contextA)).toContain(TAG_A);
            expect(JSON.stringify(contextA)).not.toContain(TAG_B);
            const promptsA = classifier.buildPrompts(contextA);
            expect(promptsA.userPrompt).toContain(TAG_A);
            expect(promptsA.userPrompt).not.toContain(TAG_B);
            expect(new Date(contextA.last_status_change_at).toISOString())
                .toBe('2026-07-18T12:00:00.000Z');
            expect(Number(contextA.finance.amount_paid)).toBe(10);
            expect(Number(contextA.finance.balance_due)).toBe(90);

            const leadContextA = await queries.getEntityContext(COMPANY_A, 'lead', leadA, client);
            expect(JSON.stringify(leadContextA)).toContain(TAG_A);
            expect(JSON.stringify(leadContextA)).not.toContain(TAG_B);
            expect(leadContextA.entity.phone).toBe(SHARED_PHONE);
            expect(leadContextA.finance.estimates.latest_actionable.estimate_number)
                .toBe(`${TAG_A}-LEAD-EST`);
            const leadPromptsA = classifier.buildPrompts(leadContextA);
            expect(leadPromptsA.userPrompt).toContain(TAG_A);
            expect(leadPromptsA.userPrompt).not.toContain(TAG_B);

            const created = await taskService.createTaskInTransaction({
                companyId: COMPANY_A,
                runId: 1,
                companyLocalDate: '2026-07-20',
                entityType: 'job',
                entityId: jobA,
                boundary: new Date('2026-07-20T04:00:00.000Z'),
                ignoredStatuses: ['Canceled'],
                verdict: {
                    needs_attention: true,
                    confidence: 0.9,
                    reason: `${TAG_A} finance gap`,
                    task_title: `Verify ${TAG_A}`,
                    task_description: `Check ${TAG_A} invoice and payment.`,
                },
                modelResult: { provider: 'gemini', model: 'test', latency_ms: 1, token_usage: {} },
            }, client);
            expect(created.status).toBe('created');
            expect(String(created.task.thread_id)).toBe(String(timelineA));
            await client.query(
                `UPDATE tasks SET status = 'done', completed_at = NOW()
                 WHERE company_id = $1 AND id = $2`,
                [COMPANY_A, created.task.id]
            );

            const createdLead = await taskService.createTaskInTransaction({
                companyId: COMPANY_A,
                runId: 1,
                companyLocalDate: '2026-07-20',
                entityType: 'lead',
                entityId: leadA,
                boundary: new Date('2026-07-20T04:00:00.000Z'),
                ignoredStatuses: ['Lost'],
                verdict: {
                    needs_attention: true,
                    confidence: 0.8,
                    reason: `${TAG_A} lead gap`,
                    task_title: `Verify ${TAG_A} lead`,
                    task_description: `Check ${TAG_A} lead estimate.`,
                },
                modelResult: { provider: 'gemini', model: 'test', latency_ms: 1, token_usage: {} },
            }, client);
            expect(createdLead.status).toBe('created');
            expect(String(createdLead.task.thread_id)).toBe(String(timelineA));

            const foreign = await taskService.createTaskInTransaction({
                companyId: COMPANY_A,
                runId: 1,
                companyLocalDate: '2026-07-20',
                entityType: 'job',
                entityId: jobB,
                boundary: new Date('2026-07-20T04:00:00.000Z'),
                ignoredStatuses: ['Canceled'],
                verdict: {
                    needs_attention: true, confidence: 1, reason: 'x',
                    task_title: 'x', task_description: 'x',
                },
                modelResult: {},
            }, client);
            expect(foreign.status).toBe('not_found');

            const foreignLead = await taskService.createTaskInTransaction({
                companyId: COMPANY_A,
                runId: 1,
                companyLocalDate: '2026-07-20',
                entityType: 'lead',
                entityId: leadB,
                boundary: new Date('2026-07-20T04:00:00.000Z'),
                ignoredStatuses: ['Lost'],
                verdict: {
                    needs_attention: true, confidence: 1, reason: 'x',
                    task_title: 'x', task_description: 'x',
                },
                modelResult: {},
            }, client);
            expect(foreignLead.status).toBe('not_found');

            const looseTask = await client.query(
                `INSERT INTO tasks
                    (company_id, title, description, status, created_by, kind, agent_type,
                     agent_status, job_id)
                 VALUES ($1, 'loose', 'loose', 'done', 'agent', 'agent', 'inspector',
                         'succeeded', $2)
                 RETURNING id`,
                [COMPANY_A, jobA]
            );
            await expect(queries.linkTaskToTimeline(
                COMPANY_A,
                looseTask.rows[0].id,
                timelineB,
                contactB,
                client
            )).resolves.toBeNull();
            const loose = await client.query(
                `SELECT thread_id FROM tasks WHERE company_id = $1 AND id = $2`,
                [COMPANY_A, looseTask.rows[0].id]
            );
            expect(loose.rows[0].thread_id).toBeNull();

            expect(await snapshotB(client)).toBe(beforeB);
            const bTasks = await client.query(
                `SELECT COUNT(*)::INTEGER AS count FROM tasks WHERE company_id = $1`,
                [COMPANY_B]
            );
            expect(bTasks.rows[0].count).toBe(0);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

    databaseTest('SAB-INSP-ONCE-PER-DAY: real claim is unique by company/local date and scoped on update', async () => {
        const client = await db.pool.connect();
        const companyId = randomUUID();
        try {
            await client.query('BEGIN');
            await client.query(MIGRATION);
            await client.query(
                `INSERT INTO companies (id, name, slug, timezone)
                 VALUES ($1, 'Inspector claim fixture', $2, 'America/New_York')`,
                [companyId, `inspector-claim-${companyId}`]
            );
            const now = new Date('2026-07-20T16:00:00.000Z');
            const lease = new Date('2026-07-20T16:15:00.000Z');
            const first = await queries.claimDailyRun(
                companyId, '2026-07-20', 'America/New_York', now, lease, client
            );
            const second = await queries.claimDailyRun(
                companyId, '2026-07-20', 'America/New_York', now, lease, client
            );
            expect(first).toBeTruthy();
            expect(second).toBeNull();
            const rows = await client.query(
                `SELECT COUNT(*)::INTEGER AS count
                 FROM inspector_daily_runs
                 WHERE company_id = $1 AND company_local_date = '2026-07-20'`,
                [companyId]
            );
            expect(rows.rows[0].count).toBe(1);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch { /* ignore */ }
});
