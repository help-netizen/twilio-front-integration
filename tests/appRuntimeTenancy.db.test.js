'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const db = require('../backend/src/db/connection');
const identityService = require('../backend/src/services/appRuntimeIdentityService');
const tokenService = require('../backend/src/services/appRuntimeTokenService');
const gatewayService = require('../backend/src/services/appRuntimeGatewayService');
const appRuntimeTaskService = require('../backend/src/services/appRuntimeTaskService');
const appRuntimeNoteService = require('../backend/src/services/appRuntimeNoteService');
const {
    createAppInstallationSecretService,
} = require('../backend/src/services/appInstallationSecretService');
const rateLimit = require('../backend/src/services/appRuntimeRateLimit');
const callMaskingService = require('../backend/src/services/callMaskingService');
const appVersionTransitionModule = require('../backend/src/services/appVersionTransitionService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const MASKING_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '208_call_masking.sql'), 'utf8');
const ORDER_LIST_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '207_estimate_invoice_order_list.sql'),
    'utf8'
);
const SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '220_app_runtime_gateway.sql'), 'utf8');
const BUILDER_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '221_app_studio_builder.sql'), 'utf8');
const GAP_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '222_app_studio_gap_fixes.sql'), 'utf8');
const EXECUTION_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '224_app_runtime_execution_authorization.sql'),
    'utf8'
);
const EXECUTION_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_224_app_runtime_execution_authorization.sql'),
    'utf8'
);
const DATA_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '235_app_data_phase_d.sql'), 'utf8');
const WRITE_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '237_app_create_task_write_tool.sql'),
    'utf8'
);
const WRITE_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_237_app_create_task_write_tool.sql'),
    'utf8'
);
const EGRESS_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '238_app_egress_phase_i.sql'),
    'utf8'
);
const EGRESS_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_238_app_egress_phase_i.sql'),
    'utf8'
);
const ROLE_SEED = fs.readFileSync(path.join(MIGRATIONS, '050_seed_role_configs.sql'), 'utf8');
const TOOLS = [
    'svc.list_jobs',
    'svc.get_job',
    'svc.list_tasks',
    'svc.create_task',
    'svc.list_estimates',
    'svc.get_estimate',
    'svc.add_note',
    'svc.list_leads',
    'svc.get_lead',
    'svc.list_invoices',
    'svc.list_payments',
];
const SHARED_SEARCH = `blast-${randomUUID()}`;
const SHARED_PHONE = '+16175550999';
const SHARED_EMAIL = `blast-${randomUUID()}@example.test`;

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
    test('APP-GW-001 tenancy DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-GW-001 tenancy DB tests are pending: ${DATABASE.reason}`);
    });
}

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function insertCompany(client, label) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [id, `APP GW ${label}`, `app-gw-tenancy-${label.toLowerCase()}-${id}`]
    );
    return id;
}

async function insertHuman(client, companyId, label, roleKey) {
    const user = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, $4, 'active', $5,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-gw-${label}-${randomUUID()}`,
            `${label}-${randomUUID()}@example.test`,
            `APP GW ${label}`,
            roleKey === 'tenant_admin' ? 'company_admin' : 'company_member',
            companyId,
        ]
    );
    const membership = await client.query(
        `INSERT INTO company_memberships
            (user_id, company_id, role, role_key, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id`,
        [
            user.rows[0].id,
            companyId,
            roleKey === 'tenant_admin' ? 'company_admin' : 'company_member',
            roleKey,
        ]
    );
    return { id: user.rows[0].id, membershipId: membership.rows[0].id };
}

async function setRole(client, fixture, roleKey) {
    await client.query(
        `UPDATE company_memberships
         SET role = $3, role_key = $4, status = 'active', updated_at = NOW()
         WHERE id = $1 AND company_id = $2`,
        [
            fixture.humanA.membershipId,
            fixture.companyA,
            roleKey === 'tenant_admin' ? 'company_admin' : 'company_member',
            roleKey,
        ]
    );
}

async function configureConsent(client, installationId, versionId) {
    // Prove and guard the PostgreSQL landmine: nested jsonb_set is a no-op when
    // app_runtime does not exist, so writers must create that parent first.
    await client.query(
        `UPDATE marketplace_installations
         SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{app_runtime,version_id}',
             to_jsonb($2::text),
             true
         )
         WHERE id = $1`,
        [installationId, versionId]
    );
    const noOp = await client.query(
        `SELECT metadata->'app_runtime' AS app_runtime
         FROM marketplace_installations WHERE id = $1`,
        [installationId]
    );
    expect(noOp.rows[0].app_runtime).toBeNull();

    await client.query(
        `UPDATE marketplace_installations
         SET metadata = jsonb_set(
             jsonb_set(
                 COALESCE(metadata, '{}'::jsonb),
                 '{app_runtime}',
                 '{}'::jsonb,
                 true
             ),
             '{app_runtime,version_id}',
             to_jsonb($2::text),
             true
         )
         WHERE id = $1`,
        [installationId, versionId]
    );
    await client.query(
        `UPDATE marketplace_installations
         SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{app_runtime,consented_tools}',
             $2::jsonb,
             true
         )
         WHERE id = $1`,
        [installationId, JSON.stringify(TOOLS)]
    );
}

async function setupFixture(client, { connections = [] } = {}) {
    await client.query(ORDER_LIST_SCHEMA);
    await client.query(MASKING_SCHEMA);
    await client.query(SCHEMA);
    await client.query(BUILDER_SCHEMA);
    await client.query(GAP_SCHEMA);
    await client.query(EXECUTION_SCHEMA);
    await client.query(DATA_SCHEMA);
    await client.query(WRITE_SCHEMA);
    await client.query(EGRESS_SCHEMA);
    const companyA = await insertCompany(client, 'A');
    const companyB = await insertCompany(client, 'B');
    const humanA = await insertHuman(client, companyA, 'owner-a', 'manager');
    const teammateA = await insertHuman(client, companyA, 'teammate-a', 'provider');
    await insertHuman(client, companyA, 'backup-admin-a', 'tenant_admin');
    const humanB = await insertHuman(client, companyB, 'owner-b', 'manager');
    await client.query(ROLE_SEED);

    const app = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, 'APP GW Tenancy', 'Albusto Test', 'ai', 'private',
                 'APP-GW tenancy test', '[]'::jsonb, 'none', 'published', '{}'::jsonb)
         RETURNING id`,
        [`app-gw-tenancy-${randomUUID()}`]
    );
    const installationRows = await client.query(
        `INSERT INTO marketplace_installations
            (company_id, app_id, status, installed_by, installed_at, metadata)
         VALUES ($1, $3, 'connected', $4, NOW(), '{}'::jsonb),
                ($2, $3, 'connected', $5, NOW(), '{}'::jsonb)
         RETURNING id, company_id`,
        [companyA, companyB, app.rows[0].id, humanA.id, humanB.id]
    );
    const installationA = installationRows.rows.find((row) => row.company_id === companyA).id;
    const installationB = installationRows.rows.find((row) => row.company_id === companyB).id;
    const source = 'module.exports = async function app() { return true; };';
    const version = await client.query(
        `INSERT INTO app_versions
            (app_id, version_number, source_code, source_sha256,
             scanner_report, status, created_by)
         VALUES ($1, '1.0.0', $2, $3, $4::jsonb, 'draft', $5)
         RETURNING id`,
        [
            app.rows[0].id,
            source,
            digest(source),
            JSON.stringify({ connections }),
            humanA.id,
        ]
    );
    for (const toolName of TOOLS) {
        await client.query(
            `INSERT INTO app_version_tools (version_id, tool_name) VALUES ($1, $2)`,
            [version.rows[0].id, toolName]
        );
    }
    await client.query(`SELECT set_config('app.version_transition_service', 'enabled', true)`);
    for (const status of ['submitted', 'in_review', 'approved', 'published']) {
        await client.query(
            `UPDATE app_versions
             SET status = $3,
                 published_at = CASE WHEN $3 = 'published' THEN NOW() ELSE published_at END
             WHERE id = $1 AND app_id = $2`,
            [version.rows[0].id, app.rows[0].id, status]
        );
    }
    await configureConsent(client, installationA, version.rows[0].id);
    await configureConsent(client, installationB, version.rows[0].id);

    const principalA = await identityService.provisionInstallationPrincipal({
        installationId: installationA,
    }, client);
    const principalB = await identityService.provisionInstallationPrincipal({
        installationId: installationB,
    }, client);

    const jobRows = await client.query(
        `INSERT INTO jobs
            (company_id, zenbooker_job_id, job_number, service_name, customer_name,
             customer_phone, customer_email, assigned_provider_user_ids, blanc_status)
         VALUES
            ($1, $3, $6, $6, 'Owned A', $7, $8, $9::jsonb, 'Submitted'),
            ($1, $4, $6, $6, 'Unassigned A', $7, $8, '[]'::jsonb, 'Submitted'),
            ($2, $5, $6, $6, 'Foreign B', $7, $8, $10::jsonb, 'Submitted')
         RETURNING id, company_id, customer_name`,
        [
            companyA,
            companyB,
            `zb-a-owned-${randomUUID()}`,
            `zb-a-unassigned-${randomUUID()}`,
            `zb-b-${randomUUID()}`,
            SHARED_SEARCH,
            SHARED_PHONE,
            SHARED_EMAIL,
            JSON.stringify([humanA.id]),
            JSON.stringify([humanB.id]),
        ]
    );
    const ownedJobA = jobRows.rows.find((row) => row.customer_name === 'Owned A').id;
    const unassignedJobA = jobRows.rows.find((row) => row.customer_name === 'Unassigned A').id;
    const foreignJobB = jobRows.rows.find((row) => row.customer_name === 'Foreign B').id;

    const taskRows = await client.query(
        `INSERT INTO tasks
            (company_id, thread_id, job_id, title, status, owner_user_id,
             author_user_id, created_by)
         VALUES
            ($1, NULL, $3, $6, 'open', $4, $4, 'user'),
            ($1, NULL, $3, $6, 'open', $5, $5, 'user'),
            ($2, NULL, $7, $6, 'open', $8, $8, 'user')
         RETURNING id, company_id, owner_user_id`,
        [
            companyA,
            companyB,
            ownedJobA,
            humanA.id,
            teammateA.id,
            SHARED_SEARCH,
            foreignJobB,
            humanB.id,
        ]
    );

    const estimateRows = await client.query(
        `INSERT INTO estimates
            (company_id, estimate_number, status, job_id, summary,
             subtotal, tax_amount, total, accepted_at, order_list)
         VALUES
            ($1, $3::varchar, 'approved', $4, $3::text, 289.00, 18.06, 307.06,
             '2026-08-02T03:30:00.000Z', $6::jsonb),
            ($2, $3::varchar, 'approved', $5, $3::text, 999.00, 62.44, 1061.44,
             '2026-08-02T03:30:00.000Z', $7::jsonb)
         RETURNING id, company_id`,
        [
            companyA,
            companyB,
            SHARED_SEARCH,
            ownedJobA,
            foreignJobB,
            JSON.stringify([{ part_number: 'WD19X25700', part_name: 'Dishwasher Drain Pump', quantity: 1 }]),
            JSON.stringify([{ part_number: 'DA97-07603B', part_name: 'Foreign Ice Maker', quantity: 9 }]),
        ]
    );
    const ownedEstimateA = estimateRows.rows.find((row) => row.company_id === companyA).id;
    const foreignEstimateB = estimateRows.rows.find((row) => row.company_id === companyB).id;
    await client.query(
        `INSERT INTO estimate_items
            (estimate_id, sort_order, name, description, quantity, unit,
             unit_price, amount, item_type)
         VALUES
            ($1, 0, 'Dishwasher drain pump', 'Owned A item', 1, 'each', 289.00, 289.00, 'part'),
            ($2, 0, 'Foreign ice maker', 'Foreign B item', 1, 'each', 999.00, 999.00, 'part')`,
        [ownedEstimateA, foreignEstimateB]
    );

    const contactRows = await client.query(
        `INSERT INTO contacts (company_id, full_name, phone_e164, email)
         VALUES ($1, 'Phase H Owned A', $3, $4),
                ($2, 'Phase H Foreign B', $3, $5)
         RETURNING id, company_id`,
        [
            companyA,
            companyB,
            SHARED_PHONE,
            `phase-h-a-${randomUUID()}@example.test`,
            `phase-h-b-${randomUUID()}@example.test`,
        ]
    );
    const ownedContactA = contactRows.rows.find((row) => row.company_id === companyA).id;
    const foreignContactB = contactRows.rows.find((row) => row.company_id === companyB).id;
    const leadRows = await client.query(
        `INSERT INTO leads
            (company_id, uuid, status, first_name, last_name, phone, email,
             address, city, state, job_type, job_source, lead_notes, contact_id,
             created_at, lead_date_time, lead_end_date_time)
         VALUES
            ($1, $3, 'Submitted', 'Phase H', 'Owned A', $5, $6,
             '1 App Way', 'Boston', 'MA', 'Repair', $7, 'Owned Lead notes', $8,
             '2026-08-04T03:30:00.000Z', NOW(), NOW() + INTERVAL '1 hour'),
            ($2, $4, 'Submitted', 'Phase H', 'Foreign B', $5, $6,
             '2 App Way', 'Chicago', 'IL', 'Repair', $7, 'Foreign Lead notes', $9,
             '2026-08-04T03:30:00.000Z', NOW(), NOW() + INTERVAL '1 hour')
         RETURNING id, company_id`,
        [
            companyA,
            companyB,
            `PHA${String(Date.now()).slice(-12)}`,
            `PHB${String(Date.now()).slice(-12)}`,
            SHARED_PHONE,
            SHARED_EMAIL,
            SHARED_SEARCH,
            ownedContactA,
            foreignContactB,
        ]
    );
    const ownedLeadA = leadRows.rows.find((row) => row.company_id === companyA).id;
    const foreignLeadB = leadRows.rows.find((row) => row.company_id === companyB).id;
    const invoiceRows = await client.query(
        `INSERT INTO invoices
            (company_id, invoice_number, status, contact_id, job_id, title,
             total, amount_paid, balance_due, created_at, due_date)
         VALUES
            ($1, $3::text, 'sent', $4, $6, $3::text, 307.06, 100.00, 207.06,
             '2026-08-04T03:30:00.000Z', '2026-08-10T04:00:00.000Z'),
            ($2, $3::text, 'sent', $5, $7, $3::text, 1061.44, 200.00, 861.44,
             '2026-08-04T03:30:00.000Z', '2026-08-10T05:00:00.000Z')
         RETURNING id, company_id`,
        [companyA, companyB, SHARED_SEARCH, ownedContactA, foreignContactB, ownedJobA, foreignJobB]
    );
    const ownedInvoiceA = invoiceRows.rows.find((row) => row.company_id === companyA).id;
    const foreignInvoiceB = invoiceRows.rows.find((row) => row.company_id === companyB).id;
    const paymentRows = await client.query(
        `INSERT INTO payment_transactions
            (company_id, contact_id, invoice_id, job_id, transaction_type,
             payment_method, status, amount, currency, processed_at)
         VALUES
            ($1, $3, $5, $7, 'payment', 'cash', 'completed', 100.00, 'USD',
             '2026-08-04T03:30:00.000Z'),
            ($2, $4, $6, $8, 'payment', 'cash', 'completed', 200.00, 'USD',
             '2026-08-04T03:30:00.000Z')
         RETURNING id, company_id`,
        [
            companyA,
            companyB,
            ownedContactA,
            foreignContactB,
            ownedInvoiceA,
            foreignInvoiceB,
            ownedJobA,
            foreignJobB,
        ]
    );

    return {
        companyA,
        companyB,
        humanA,
        teammateA,
        humanB,
        appId: app.rows[0].id,
        installationA,
        installationB,
        versionId: version.rows[0].id,
        artifactSha256: digest(source),
        principalA,
        principalB,
        ownedJobA,
        unassignedJobA,
        foreignJobB,
        ownedTaskA: taskRows.rows.find((row) => row.owner_user_id === humanA.id).id,
        teammateTaskA: taskRows.rows.find((row) => row.owner_user_id === teammateA.id).id,
        foreignTaskB: taskRows.rows.find((row) => row.company_id === companyB).id,
        ownedEstimateA,
        foreignEstimateB,
        ownedLeadA,
        foreignLeadB,
        ownedInvoiceA,
        foreignInvoiceB,
        ownedPaymentA: paymentRows.rows.find((row) => row.company_id === companyA).id,
        foreignPaymentB: paymentRows.rows.find((row) => row.company_id === companyB).id,
    };
}

async function createRunContext(client, fixture, side = 'A', authorize = true) {
    const principal = side === 'A' ? fixture.principalA : fixture.principalB;
    const companyId = side === 'A' ? fixture.companyA : fixture.companyB;
    const installationId = side === 'A' ? fixture.installationA : fixture.installationB;
    const runId = randomUUID();
    const nonce = crypto.randomBytes(32).toString('base64url');
    await client.query(
        `INSERT INTO app_runs
            (id, company_id, app_id, installation_id, version_id, principal_id,
             artifact_sha256, nonce_sha256, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW() + INTERVAL '5 minutes')`,
        [
            runId,
            companyId,
            fixture.appId,
            installationId,
            fixture.versionId,
            principal.principal.id,
            fixture.artifactSha256,
            tokenService.sha256(nonce),
        ]
    );
    const resolved = await tokenService.resolveRunContext({
        installation_id: String(installationId),
        version_id: String(fixture.versionId),
        run_id: runId,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce,
    });
    if (authorize) {
        await tokenService.authorizeRunExecution(resolved, fixture.artifactSha256);
    }
    return { ...resolved, nonce_for_test: nonce };
}

function nestedTransactionDatabase(client, prefix) {
    let sequence = 0;
    return {
        getClient: async () => {
            const savepoint = `${prefix}_${sequence += 1}`;
            let open = false;
            return {
                query: async (text, params) => {
                    if (text === 'BEGIN') {
                        open = true;
                        return client.query(`SAVEPOINT ${savepoint}`);
                    }
                    if (text === 'COMMIT') {
                        open = false;
                        return client.query(`RELEASE SAVEPOINT ${savepoint}`);
                    }
                    if (text === 'ROLLBACK') {
                        if (!open) return undefined;
                        open = false;
                        return client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                    }
                    return client.query(text, params);
                },
                release: jest.fn(),
            };
        },
    };
}

async function invoke(client, fixture, toolName, args = {}, existingContext = null) {
    const appRuntimeContext = existingContext || await createRunContext(client, fixture);
    const req = {
        requestId: `app-gw-db-${randomUUID()}`,
        appRuntimeContext,
    };
    const data = await gatewayService.execute(req, toolName, args);
    return { data, req, context: appRuntimeContext };
}

async function snapshotCompanyB(client, fixture) {
    const result = await client.query(
        `SELECT jsonb_build_object(
            'jobs', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                     FROM jobs row_value WHERE row_value.company_id = $1),
            'tasks', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                      FROM tasks row_value WHERE row_value.company_id = $1),
            'estimates', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                          FROM estimates row_value WHERE row_value.company_id = $1),
            'leads', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                      FROM leads row_value WHERE row_value.company_id = $1),
            'invoices', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                         FROM invoices row_value WHERE row_value.company_id = $1),
            'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                         FROM payment_transactions row_value WHERE row_value.company_id = $1),
            'estimate_items', (SELECT COALESCE(jsonb_agg(to_jsonb(item_value) ORDER BY item_value.id), '[]'::jsonb)
                               FROM estimate_items item_value
                               JOIN estimates estimate_owner ON estimate_owner.id = item_value.estimate_id
                               WHERE estimate_owner.company_id = $1),
            'installations', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                              FROM marketplace_installations row_value WHERE row_value.company_id = $1),
            'principals', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                           FROM app_installation_principals row_value WHERE row_value.company_id = $1),
            'runs', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                     FROM app_runs row_value WHERE row_value.company_id = $1),
            'agents', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                       FROM crm_users row_value WHERE row_value.company_id = $1 AND row_value.kind = 'agent'),
            'audits', (SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.id), '[]'::jsonb)
                       FROM audit_log row_value WHERE row_value.company_id = $1 AND row_value.app_id = $2)
        ) AS snapshot`,
        [fixture.companyB, fixture.appId]
    );
    return result.rows[0].snapshot;
}

describe('APP-GW-001 real PostgreSQL gateway matrix', () => {
    databaseTest('migration 238 applies twice and rollback/forward restores secrets plus egress metering', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            await client.query(EGRESS_SCHEMA);
            await client.query(EGRESS_SCHEMA);
            const applied = await client.query(
                `SELECT to_regclass('app_installation_secrets') IS NOT NULL AS secrets_table,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runs'
                              AND column_name = 'egress_calls_made'
                        ) AS egress_meter`
            );
            expect(applied.rows[0]).toEqual({ secrets_table: true, egress_meter: true });

            await client.query(EGRESS_ROLLBACK);
            await client.query(EGRESS_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT to_regclass('app_installation_secrets') IS NULL AS no_secrets_table,
                        NOT EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runs'
                              AND column_name = 'egress_calls_made'
                        ) AS no_egress_meter`
            );
            expect(rolledBack.rows[0]).toEqual({
                no_secrets_table: true,
                no_egress_meter: true,
            });
            await client.query(EGRESS_SCHEMA);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('5 APP-EGRESS secrets are write-only, tenant-isolated, and cascade only with their own uninstall', async () => {
        const client = await db.pool.connect();
        const originalKey = process.env.APP_SECRETS_KEY;
        try {
            await client.query('BEGIN');
            const declaration = {
                name: 'supplier',
                base_url: 'https://api.supplier.test',
                auth: { kind: 'bearer' },
            };
            const fixture = await setupFixture(client, { connections: [declaration] });
            process.env.APP_SECRETS_KEY = '22'.repeat(32);
            const secrets = createAppInstallationSecretService({
                database: nestedTransactionDatabase(client, 'secret_api'),
            });
            const valueA = `secret-a-${randomUUID()}`;
            const valueB = `secret-b-${randomUUID()}`;
            await expect(secrets.setSecret({
                companyId: fixture.companyA,
                installationId: fixture.installationA,
                connectionName: 'supplier',
                actorId: fixture.humanA.id,
                value: valueA,
            })).resolves.toMatchObject({ connection: 'supplier', status: 'set' });
            await expect(secrets.setSecret({
                companyId: fixture.companyB,
                installationId: fixture.installationB,
                connectionName: 'supplier',
                actorId: fixture.humanB.id,
                value: valueB,
            })).resolves.toMatchObject({ connection: 'supplier', status: 'set' });

            const beforeB = await client.query(
                `SELECT ciphertext, set_by, set_at
                 FROM app_installation_secrets
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyB, fixture.installationB]
            );
            await expect(secrets.setSecret({
                companyId: fixture.companyA,
                installationId: fixture.installationB,
                connectionName: 'supplier',
                actorId: fixture.humanA.id,
                value: 'cross-tenant-overwrite',
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            const afterBlast = await client.query(
                `SELECT ciphertext, set_by, set_at
                 FROM app_installation_secrets
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyB, fixture.installationB]
            );
            expect(afterBlast.rows).toEqual(beforeB.rows);

            const listed = await secrets.listSecrets({
                companyId: fixture.companyA,
                installationId: fixture.installationA,
                actorId: fixture.humanA.id,
            });
            expect(listed).toEqual([{ connection: 'supplier', status: 'set' }]);
            expect(JSON.stringify(listed)).not.toContain(valueA);
            const storedA = await client.query(
                `SELECT ciphertext
                 FROM app_installation_secrets
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            expect(storedA.rows[0].ciphertext).not.toContain(valueA);
            expect(storedA.rows[0].ciphertext.split(':')).toHaveLength(3);

            await client.query(
                `DELETE FROM marketplace_installations
                 WHERE company_id = $1 AND id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            const remaining = await client.query(
                `SELECT company_id, installation_id
                 FROM app_installation_secrets
                 WHERE (company_id = $1 AND installation_id = $2)
                    OR (company_id = $3 AND installation_id = $4)
                 ORDER BY company_id`,
                [
                    fixture.companyA,
                    fixture.installationA,
                    fixture.companyB,
                    fixture.installationB,
                ]
            );
            expect(remaining.rows).toEqual([{
                company_id: fixture.companyB,
                installation_id: String(fixture.installationB),
            }]);
        } finally {
            if (originalKey === undefined) delete process.env.APP_SECRETS_KEY;
            else process.env.APP_SECRETS_KEY = originalKey;
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('4 APP-EGRESS PostgreSQL meter refuses the sixth run call and the 501st daily call atomically', async () => {
        const client = await db.pool.connect();
        let dbQuerySpy;
        let dbClientSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbQuerySpy = jest.spyOn(db, 'query').mockImplementation((text, params) => (
                client.query(text, params)
            ));
            const nested = nestedTransactionDatabase(client, 'egress_meter');
            dbClientSpy = jest.spyOn(db, 'getClient').mockImplementation(nested.getClient);

            const metered = await createRunContext(client, fixture);
            for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
                await expect(tokenService.consumeRunEgressCall(metered)).resolves.toBe(ordinal);
            }
            await expect(tokenService.consumeRunEgressCall(metered)).rejects.toMatchObject({
                code: 'EGRESS_CALL_LIMIT',
                message: 'Egress call limit of 5 reached.',
                httpStatus: 429,
            });

            await client.query(
                `INSERT INTO app_runs
                    (id, company_id, app_id, installation_id, version_id, principal_id,
                     artifact_sha256, nonce_sha256, issued_at, expires_at,
                     egress_calls_made)
                 SELECT gen_random_uuid(), $1, $2, $3, $4, $5, $6,
                        repeat(md5(series::text || random()::text), 2),
                        NOW(), NOW() + INTERVAL '5 minutes', 5
                 FROM generate_series(1, 99) AS series`,
                [
                    fixture.companyA,
                    fixture.appId,
                    fixture.installationA,
                    fixture.versionId,
                    fixture.principalA.principal.id,
                    fixture.artifactSha256,
                ]
            );
            const daily = await createRunContext(client, fixture);
            await expect(tokenService.consumeRunEgressCall(daily)).rejects.toMatchObject({
                code: 'EGRESS_DAILY_CALL_LIMIT',
                message: 'Daily egress call limit of 500 reached.',
                httpStatus: 429,
            });
            const stored = await client.query(
                `SELECT egress_calls_made
                 FROM app_runs
                 WHERE company_id = $1 AND id = ANY($2::uuid[])
                 ORDER BY id`,
                [fixture.companyA, [metered.run_id, daily.run_id]]
            );
            expect(stored.rows.map(row => row.egress_calls_made).sort()).toEqual([0, 5]);
        } finally {
            dbClientSpy?.mockRestore();
            dbQuerySpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('migration 233 applies twice and rollback/forward restores write metering', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            await client.query(WRITE_SCHEMA);
            await client.query(WRITE_SCHEMA);
            const applied = await client.query(
                `SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'app_runs'
                      AND column_name = 'write_calls_made'
                ) AS write_meter`
            );
            expect(applied.rows[0].write_meter).toBe(true);

            await client.query(WRITE_ROLLBACK);
            await client.query(WRITE_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'app_runs'
                      AND column_name = 'write_calls_made'
                ) AS write_meter`
            );
            expect(rolledBack.rows[0].write_meter).toBe(false);

            await client.query(WRITE_SCHEMA);
            const restored = await client.query(
                `SELECT column_default
                 FROM information_schema.columns
                 WHERE table_name = 'app_runs'
                   AND column_name = 'write_calls_made'`
            );
            expect(restored.rows[0].column_default).toBe('0');
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('migration 224 applies twice and rollback/forward preserves the execution-admission schema', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SCHEMA);
            await client.query(BUILDER_SCHEMA);
            await client.query(GAP_SCHEMA);
            await client.query(EXECUTION_SCHEMA);
            await client.query(EXECUTION_SCHEMA);
            const applied = await client.query(
                `SELECT EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runs'
                              AND column_name = 'execution_authorized_at'
                        ) AS run_admission,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runtime_usage'
                              AND column_name = 'wall_ms_used'
                        ) AS wall_usage`
            );
            expect(applied.rows[0]).toEqual({ run_admission: true, wall_usage: true });
            await client.query(EXECUTION_ROLLBACK);
            await client.query(EXECUTION_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runs'
                              AND column_name = 'execution_authorized_at'
                        ) AS run_admission,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runtime_usage'
                              AND column_name = 'wall_ms_used'
                        ) AS wall_usage`
            );
            expect(rolledBack.rows[0]).toEqual({ run_admission: false, wall_usage: false });
            await client.query(EXECUTION_SCHEMA);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('SAB company binding + delegator scopes: per-tool T-own/T-foreign/T-blast and R-matrix', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        let maskingSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            rateLimit.resetForTests();

            const bContext = await createRunContext(client, fixture, 'B');
            await client.query(
                `INSERT INTO audit_log
                    (actor_id, action, target_type, target_id, company_id, details,
                     trace_id, app_id, installation_id, app_run_id)
                 VALUES ($1, 'app_runtime.tool_call', 'app_runtime_tool', 'svc.list_jobs',
                         $2, '{}'::jsonb, 'b-snapshot', $3, $4, $5)`,
                [
                    fixture.principalB.agent.id,
                    fixture.companyB,
                    fixture.appId,
                    fixture.installationB,
                    bContext.run_id,
                ]
            );
            const beforeB = await snapshotCompanyB(client, fixture);

            for (const role of ['tenant_admin', 'manager', 'dispatcher']) {
                await setRole(client, fixture, role);
                const jobs = await invoke(client, fixture, 'svc.list_jobs', {
                    search: SHARED_SEARCH,
                    limit: 100,
                });
                expect(jobs.data.results.map((job) => job.id).sort()).toEqual(
                    [fixture.ownedJobA, fixture.unassignedJobA].sort()
                );
                expect(jobs.data.results.every((job) => job.company_id === fixture.companyA)).toBe(true);

                const job = await invoke(client, fixture, 'svc.get_job', {
                    job_id: Number(fixture.ownedJobA),
                });
                expect(job.data.id).toBe(fixture.ownedJobA);

                const tasks = await invoke(client, fixture, 'svc.list_tasks', {
                    search: SHARED_SEARCH,
                    limit: 100,
                });
                expect(tasks.data.tasks.map((task) => task.id).sort()).toEqual(
                    [fixture.ownedTaskA, fixture.teammateTaskA].sort()
                );
                expect(tasks.data.tasks.every((task) => task.company_id === fixture.companyA)).toBe(true);
            }

            for (const role of ['tenant_admin', 'manager', 'provider']) {
                await setRole(client, fixture, role);
                const estimates = await invoke(client, fixture, 'svc.list_estimates', {
                    status: 'approved',
                    accepted_from: '2026-08-01',
                    accepted_to: '2026-08-01',
                    search: SHARED_SEARCH,
                    limit: 100,
                    offset: 0,
                });
                expect(estimates.data.results.map((estimate) => estimate.id))
                    .toEqual([fixture.ownedEstimateA]);
                expect(estimates.data.results[0]).toEqual(expect.objectContaining({
                    status: 'approved',
                    accepted_at: '2026-08-02T03:30:00.000Z',
                    items_count: 1,
                    order_list_count: 1,
                }));

                const estimate = await invoke(client, fixture, 'svc.get_estimate', {
                    estimate_id: Number(fixture.ownedEstimateA),
                });
                expect(estimate.data).toEqual(expect.objectContaining({
                    id: fixture.ownedEstimateA,
                    items: [expect.objectContaining({
                        name: 'Dishwasher drain pump',
                        quantity: 1,
                        item_type: 'part',
                    })],
                    order_list: [{
                        part_number: 'WD19X25700',
                        part_name: 'Dishwasher Drain Pump',
                        quantity: 1,
                    }],
                }));
            }

            await setRole(client, fixture, 'dispatcher');
            await expect(invoke(client, fixture, 'svc.list_estimates', {}))
                .rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
            await expect(invoke(client, fixture, 'svc.get_estimate', {
                estimate_id: Number(fixture.ownedEstimateA),
            })).rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });

            await setRole(client, fixture, 'manager');
            await expect(invoke(client, fixture, 'svc.get_job', {
                job_id: Number(fixture.foreignJobB),
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            await expect(invoke(client, fixture, 'svc.get_estimate', {
                estimate_id: Number(fixture.foreignEstimateB),
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            const nextCompanyDay = await invoke(client, fixture, 'svc.list_estimates', {
                accepted_from: '2026-08-02',
                accepted_to: '2026-08-02',
                search: SHARED_SEARCH,
                limit: 100,
                offset: 0,
            });
            expect(nextCompanyDay.data.results).toEqual([]);

            const liveDemotionContext = await createRunContext(client, fixture);
            await expect(invoke(client, fixture, 'svc.get_job', {
                job_id: Number(fixture.unassignedJobA),
            }, liveDemotionContext)).resolves.toMatchObject({
                data: { id: fixture.unassignedJobA },
            });
            await setRole(client, fixture, 'provider');
            await expect(invoke(client, fixture, 'svc.get_job', {
                job_id: Number(fixture.unassignedJobA),
            }, liveDemotionContext)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

            const providerJobs = await invoke(client, fixture, 'svc.list_jobs', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(providerJobs.data.results.map((job) => job.id)).toEqual([fixture.ownedJobA]);
            const providerTasks = await invoke(client, fixture, 'svc.list_tasks', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(providerTasks.data.tasks.map((task) => task.id)).toEqual([fixture.ownedTaskA]);

            await client.query(
                `INSERT INTO company_membership_scope_overrides
                    (membership_id, scope_key, scope_json, created_by)
                 VALUES ($1, 'job_visibility', '"unknown_future_scope"'::jsonb, $2)
                 ON CONFLICT (membership_id, scope_key) DO UPDATE
                 SET scope_json = EXCLUDED.scope_json`,
                [fixture.humanA.membershipId, fixture.humanA.id]
            );
            const unknownScope = await invoke(client, fixture, 'svc.list_jobs', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(unknownScope.data.results.map((job) => job.id)).toEqual([fixture.ownedJobA]);
            await client.query(
                `DELETE FROM company_membership_scope_overrides
                 WHERE membership_id = $1 AND scope_key = 'job_visibility'`,
                [fixture.humanA.membershipId]
            );
            await client.query(
                `DELETE FROM company_role_scopes
                 WHERE role_config_id = (
                     SELECT id FROM company_role_configs
                     WHERE company_id = $1 AND role_key = 'provider'
                 ) AND scope_key = 'job_visibility'`,
                [fixture.companyA]
            );
            const missingScope = await invoke(client, fixture, 'svc.list_jobs', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(missingScope.data.results.map((job) => job.id)).toEqual([fixture.ownedJobA]);

            await setRole(client, fixture, 'manager');
            const liveDenyContext = await createRunContext(client, fixture);
            await expect(invoke(client, fixture, 'svc.list_jobs', {}, liveDenyContext)).resolves.toBeDefined();
            await client.query(
                `INSERT INTO company_membership_permission_overrides
                    (membership_id, permission_key, override_mode, created_by)
                 VALUES ($1, 'jobs.view', 'deny', $2)
                 ON CONFLICT (membership_id, permission_key) DO UPDATE
                 SET override_mode = EXCLUDED.override_mode`,
                [fixture.humanA.membershipId, fixture.humanA.id]
            );
            await expect(invoke(client, fixture, 'svc.list_jobs', {}, liveDenyContext))
                .rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
            await client.query(
                `DELETE FROM company_membership_permission_overrides
                 WHERE membership_id = $1 AND permission_key = 'jobs.view'`,
                [fixture.humanA.membershipId]
            );
            await client.query(
                `INSERT INTO company_membership_permission_overrides
                    (membership_id, permission_key, override_mode, created_by)
                 VALUES ($1, 'tasks.view', 'deny', $2)`,
                [fixture.humanA.membershipId, fixture.humanA.id]
            );
            await expect(invoke(client, fixture, 'svc.list_tasks', {}))
                .rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
            await client.query(
                `DELETE FROM company_membership_permission_overrides
                 WHERE membership_id = $1 AND permission_key = 'tasks.view'`,
                [fixture.humanA.membershipId]
            );
            await client.query(
                `INSERT INTO company_membership_permission_overrides
                    (membership_id, permission_key, override_mode, created_by)
                 VALUES ($1, 'estimates.view', 'deny', $2)`,
                [fixture.humanA.membershipId, fixture.humanA.id]
            );
            await expect(invoke(client, fixture, 'svc.list_estimates', {}))
                .rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
            await expect(invoke(client, fixture, 'svc.get_estimate', {
                estimate_id: Number(fixture.ownedEstimateA),
            })).rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
            await client.query(
                `DELETE FROM company_membership_permission_overrides
                 WHERE membership_id = $1 AND permission_key = 'estimates.view'`,
                [fixture.humanA.membershipId]
            );

            await setRole(client, fixture, 'provider');
            maskingSpy = jest.spyOn(callMaskingService, 'getActiveSettings')
                .mockResolvedValue({ call_masking_enabled: true, call_masking_number: '+16174044425' });
            const masked = await invoke(client, fixture, 'svc.list_jobs', {
                search: SHARED_SEARCH,
                limit: 100,
            });
            expect(JSON.stringify(masked.data)).not.toContain(SHARED_PHONE);
            expect(masked.data.results[0]).not.toHaveProperty('customer_phone');
            maskingSpy.mockRejectedValueOnce(new Error('settings unavailable'));
            const failedClosed = await invoke(client, fixture, 'svc.get_job', {
                job_id: Number(fixture.ownedJobA),
            });
            expect(JSON.stringify(failedClosed.data)).not.toContain(SHARED_PHONE);

            const afterB = await snapshotCompanyB(client, fixture);
            expect(afterB).toEqual(beforeB);

            const audits = await client.query(
                `SELECT actor_id, company_id, app_id, installation_id, app_run_id,
                        target_id, details
                 FROM audit_log
                 WHERE company_id = $1
                   AND app_id = $2
                   AND trace_id LIKE 'app-gw-db-%'
                 ORDER BY id`,
                [fixture.companyA, fixture.appId]
            );
            expect(audits.rows.length).toBeGreaterThan(15);
            expect(audits.rows.every((row) => (
                row.actor_id === fixture.principalA.agent.id
                && row.company_id === fixture.companyA
                && row.app_id === fixture.appId
                && row.installation_id === fixture.installationA
                && row.app_run_id
                && TOOLS.includes(row.target_id)
            ))).toBe(true);
            const auditJson = JSON.stringify(audits.rows);
            expect(auditJson).not.toContain(SHARED_PHONE);
            expect(auditJson).not.toContain(SHARED_EMAIL);
            expect(auditJson).not.toContain(SHARED_SEARCH);
            expect(auditJson).not.toMatch(/nonce|source_code|arguments|response_data|token/i);
        } finally {
            maskingSpy?.mockRestore();
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            rateLimit.resetForTests();
        }
    });

    databaseTest('APP-DATA-001 Phase H reads enforce timezone, PII projection, T-own/T-foreign/T-blast, and route RBAC', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            const beforeB = await snapshotCompanyB(client, fixture);

            const leads = await invoke(client, fixture, 'svc.list_leads', {
                source: SHARED_SEARCH,
                created_from: '2026-08-03',
                created_to: '2026-08-03',
                limit: 100,
                offset: 0,
            });
            expect(leads.data.results.map((row) => row.id)).toEqual([fixture.ownedLeadA]);
            expect(leads.data.results[0]).not.toHaveProperty('phone');
            expect(leads.data.results[0]).not.toHaveProperty('email');

            const lead = await invoke(client, fixture, 'svc.get_lead', {
                lead_id: Number(fixture.ownedLeadA),
            });
            expect(lead.data).toEqual(expect.objectContaining({
                id: fixture.ownedLeadA,
                phone: SHARED_PHONE,
                email: SHARED_EMAIL,
                address: '1 App Way',
                job_type: 'Repair',
                lead_notes: 'Owned Lead notes',
            }));
            await expect(invoke(client, fixture, 'svc.get_lead', {
                lead_id: Number(fixture.foreignLeadB),
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

            const invoices = await invoke(client, fixture, 'svc.list_invoices', {
                job_id: Number(fixture.ownedJobA),
                created_from: '2026-08-03',
                created_to: '2026-08-03',
                limit: 100,
                offset: 0,
            });
            expect(invoices.data.results).toEqual([
                expect.objectContaining({
                    id: fixture.ownedInvoiceA,
                    job_id: fixture.ownedJobA,
                    balance_due: '207.06',
                }),
            ]);

            const payments = await invoke(client, fixture, 'svc.list_payments', {
                job_id: Number(fixture.ownedJobA),
                paid_from: '2026-08-03',
                paid_to: '2026-08-03',
                limit: 100,
                offset: 0,
            });
            expect(payments.data.results).toEqual([
                expect.objectContaining({
                    id: fixture.ownedPaymentA,
                    job_id: fixture.ownedJobA,
                    invoice_id: fixture.ownedInvoiceA,
                    method: 'cash',
                    paid_at: '2026-08-04T03:30:00.000Z',
                }),
            ]);

            for (const [toolName, args] of [
                ['svc.list_leads', { created_from: '2026-08-04', created_to: '2026-08-04' }],
                ['svc.list_invoices', { created_from: '2026-08-04', created_to: '2026-08-04' }],
                ['svc.list_payments', { paid_from: '2026-08-04', paid_to: '2026-08-04' }],
                ['svc.list_invoices', { job_id: Number(fixture.foreignJobB) }],
                ['svc.list_payments', { job_id: Number(fixture.foreignJobB) }],
            ]) {
                const page = await invoke(client, fixture, toolName, args);
                expect(page.data.results).toEqual([]);
            }

            for (const [permission, calls] of [
                ['leads.view', [
                    ['svc.list_leads', {}],
                    ['svc.get_lead', { lead_id: Number(fixture.ownedLeadA) }],
                ]],
                ['invoices.view', [['svc.list_invoices', {}]]],
            ]) {
                await client.query(
                    `INSERT INTO company_membership_permission_overrides
                        (membership_id, permission_key, override_mode, created_by)
                     VALUES ($1, $2, 'deny', $3)`,
                    [fixture.humanA.membershipId, permission, fixture.humanA.id]
                );
                for (const [toolName, args] of calls) {
                    await expect(invoke(client, fixture, toolName, args))
                        .rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });
                }
                await client.query(
                    `DELETE FROM company_membership_permission_overrides
                     WHERE membership_id = $1 AND permission_key = $2`,
                    [fixture.humanA.membershipId, permission]
                );
            }
            for (const permission of ['payments.view', 'financial_data.view']) {
                await client.query(
                    `INSERT INTO company_membership_permission_overrides
                        (membership_id, permission_key, override_mode, created_by)
                     VALUES ($1, $2, 'deny', $3)`,
                    [fixture.humanA.membershipId, permission, fixture.humanA.id]
                );
            }
            await expect(invoke(client, fixture, 'svc.list_payments', {
                job_id: Number(fixture.ownedJobA),
            })).rejects.toMatchObject({ code: 'ACCESS_DENIED', httpStatus: 403 });

            expect(await snapshotCompanyB(client, fixture)).toEqual(beforeB);
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            rateLimit.resetForTests();
        }
    });

    databaseTest('SAB APP-GAP-F5 consume-time revocation + run/daily ceilings + live kill states', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            const context = await createRunContext(client, fixture);

            await expect(tokenService.resolveRunContext({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: context.run_id,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: crypto.randomBytes(32).toString('base64url'),
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_TOKEN_INVALID', httpStatus: 401 });
            await expect(tokenService.resolveRunContext({
                installation_id: String(fixture.installationB),
                version_id: String(fixture.versionId),
                run_id: context.run_id,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: 'a'.repeat(43),
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_TOKEN_INVALID', httpStatus: 401 });

            const outcomes = await Promise.allSettled(
                Array.from({ length: 6 }, () => tokenService.consumeRunCall(context))
            );
            expect(outcomes.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value).sort())
                .toEqual([1, 2, 3, 4, 5]);
            expect(outcomes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
            expect(outcomes.find((entry) => entry.status === 'rejected').reason)
                .toMatchObject({ code: 'RUN_CALL_LIMIT', httpStatus: 429 });
            const stored = await client.query(
                `SELECT status, gateway_calls_used, gateway_call_limit
                 FROM app_runs WHERE id = $1 AND company_id = $2`,
                [context.run_id, fixture.companyA]
            );
            expect(stored.rows[0]).toEqual({
                status: 'exhausted', gateway_calls_used: 5, gateway_call_limit: 5,
            });

            const dataMetered = context;
            const dataOutcomes = await Promise.allSettled(
                Array.from({ length: 11 }, () => tokenService.consumeRunDataCall(dataMetered))
            );
            expect(dataOutcomes.filter(entry => entry.status === 'fulfilled'))
                .toHaveLength(10);
            expect(dataOutcomes.filter(entry => entry.status === 'rejected'))
                .toHaveLength(1);
            expect(dataOutcomes.find(entry => entry.status === 'rejected').reason)
                .toMatchObject({
                    code: 'DATA_CALL_LIMIT',
                    message: 'Data call limit of 10 reached.',
                    httpStatus: 429,
                });
            const dataStored = await client.query(
                `SELECT data_calls_made
                 FROM app_runs
                 WHERE id = $1 AND company_id = $2`,
                [dataMetered.run_id, fixture.companyA]
            );
            expect(dataStored.rows[0].data_calls_made).toBe(10);

            const completed = await createRunContext(client, fixture);
            await tokenService.recordRunCompletion({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: completed.run_id,
                nonce: completed.nonce_for_test,
            }, {
                wall_ms: 41,
                gateway_calls: 0,
                data_calls: 0,
                egress_calls: 0,
                result_bytes: 17,
                error_code: null,
            });
            const storedCompletion = await client.query(
                `SELECT status, wall_ms, gateway_calls_made, result_bytes, error_code,
                        completed_at IS NOT NULL AS has_completed_at
                 FROM app_runs
                 WHERE id = $1 AND company_id = $2`,
                [completed.run_id, fixture.companyA]
            );
            expect(storedCompletion.rows[0]).toEqual({
                status: 'completed',
                wall_ms: '41',
                gateway_calls_made: 0,
                result_bytes: 17,
                error_code: null,
                has_completed_at: true,
            });

            await client.query(
                `DELETE FROM app_runtime_usage
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_gateway_call_limit = 2,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            const dailyLimited = await createRunContext(client, fixture);
            await expect(tokenService.consumeRunCall(dailyLimited)).resolves.toBe(1);
            await expect(tokenService.consumeRunCall(dailyLimited)).resolves.toBe(2);
            await expect(tokenService.consumeRunCall(dailyLimited)).rejects.toMatchObject({
                code: 'APP_RUNTIME_SUSPENDED', httpStatus: 403,
            });
            const dailyUsage = await client.query(
                `SELECT usage.gateway_calls_used, usage.daily_gateway_call_limit,
                        control.suspension_reason
                 FROM app_runtime_usage usage
                 JOIN app_runtime_installation_controls control
                   ON control.company_id = usage.company_id
                  AND control.app_id = usage.app_id
                  AND control.installation_id = usage.installation_id
                 WHERE usage.company_id = $1
                   AND usage.installation_id = $2
                   AND usage.usage_date = (NOW() AT TIME ZONE 'UTC')::date`,
                [fixture.companyA, fixture.installationA]
            );
            expect(dailyUsage.rows[0]).toEqual({
                gateway_calls_used: 2,
                daily_gateway_call_limit: 2,
                suspension_reason: 'DAILY_GATEWAY_CALL_LIMIT',
            });
            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_gateway_call_limit = 1000,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );

            const killCases = [
                {
                    name: 'run revoked',
                    breakSql: `UPDATE app_runs SET status='revoked', revoked_at=NOW() WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE app_runs SET status='issued', revoked_at=NULL, gateway_calls_used=0 WHERE id=$1 AND company_id=$2`,
                    params: (live) => [live.run_id, fixture.companyA],
                },
                {
                    name: 'principal revoked',
                    breakSql: `UPDATE app_installation_principals SET status='revoked', revoked_at=NOW() WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE app_installation_principals SET status='active', revoked_at=NULL WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.principalA.principal.id, fixture.companyA],
                },
                {
                    name: 'agent disabled',
                    breakSql: `UPDATE crm_users SET status='disabled' WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE crm_users SET status='active' WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.principalA.agent.id, fixture.companyA],
                },
                {
                    name: 'installation disconnected',
                    breakSql: `UPDATE marketplace_installations SET status='disconnected' WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE marketplace_installations SET status='connected' WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.installationA, fixture.companyA],
                },
                {
                    name: 'app disabled',
                    breakSql: `UPDATE marketplace_apps SET status='disabled' WHERE id=$1`,
                    restoreSql: `UPDATE marketplace_apps SET status='published' WHERE id=$1`,
                    params: () => [fixture.appId],
                },
                {
                    name: 'company suspended',
                    breakSql: `UPDATE companies SET status='suspended' WHERE id=$1`,
                    restoreSql: `UPDATE companies SET status='active' WHERE id=$1`,
                    params: () => [fixture.companyA],
                },
                {
                    name: 'delegator disabled',
                    breakSql: `UPDATE crm_users SET status='disabled' WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE crm_users SET status='active' WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.humanA.id, fixture.companyA],
                },
                {
                    name: 'membership disabled',
                    breakSql: `UPDATE company_memberships SET status='disabled' WHERE id=$1 AND company_id=$2`,
                    restoreSql: `UPDATE company_memberships SET status='active' WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.humanA.membershipId, fixture.companyA],
                },
                {
                    name: 'installer cleared',
                    breakSql: `UPDATE marketplace_installations SET installed_by=NULL WHERE id=$1 AND company_id=$2 AND $3::uuid IS NOT NULL`,
                    restoreSql: `UPDATE marketplace_installations SET installed_by=$3 WHERE id=$1 AND company_id=$2`,
                    params: () => [fixture.installationA, fixture.companyA, fixture.humanA.id],
                },
                {
                    name: 'version revoked',
                    breakSql: `UPDATE app_versions SET status='revoked' WHERE id=$1 AND app_id=$2`,
                    restoreSql: null,
                    params: () => [fixture.versionId, fixture.appId],
                },
            ];

            for (const killCase of killCases) {
                const live = await createRunContext(client, fixture);
                const params = killCase.params(live);
                await client.query(killCase.breakSql, params);
                await expect(tokenService.consumeRunCall(live)).rejects.toMatchObject({
                    code: 'APP_RUNTIME_INACTIVE', httpStatus: 403,
                });
                await expect(tokenService.resolveRunContext({
                    installation_id: String(fixture.installationA),
                    version_id: String(fixture.versionId),
                    run_id: live.run_id,
                    exp: Math.floor(Date.now() / 1000) + 300,
                    nonce: live.nonce_for_test,
                })).rejects.toMatchObject({ code: 'APP_RUNTIME_INACTIVE', httpStatus: 403 });
                if (killCase.restoreSql) await client.query(killCase.restoreSql, params);
            }

        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('APP-DATA-001 Phase G creates, tenant-isolates, deduplicates, attributes, and budgets Tasks', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            const context = await createRunContext(client, fixture);
            const beforeB = await snapshotCompanyB(client, fixture);
            const args = {
                parent_type: 'job',
                parent_id: Number(fixture.ownedJobA),
                description: 'Review the app finding before dispatch.',
                due_at: '2026-08-03',
            };

            const first = await appRuntimeTaskService.createTaskInTransaction(
                context,
                args,
                client
            );
            const second = await appRuntimeTaskService.createTaskInTransaction(
                context,
                args,
                client
            );
            expect(first.deduplicated).toBe(false);
            expect(second).toMatchObject({
                deduplicated: true,
                task: { id: first.task.id, status: 'open' },
            });

            const stored = await client.query(
                `SELECT id, company_id, job_id, title, status, owner_user_id,
                        author_user_id, created_by, kind, agent_type, agent_input,
                        agent_status, due_at
                 FROM tasks
                 WHERE company_id = $1 AND id = $2`,
                [fixture.companyA, first.task.id]
            );
            expect(stored.rows).toHaveLength(1);
            expect(stored.rows[0]).toMatchObject({
                company_id: fixture.companyA,
                job_id: fixture.ownedJobA,
                title: args.description,
                status: 'open',
                owner_user_id: null,
                author_user_id: fixture.principalA.agent.id,
                created_by: 'agent',
                kind: 'agent',
                agent_type: 'app',
                agent_input: {
                    source: 'app',
                    installation_id: String(fixture.installationA),
                },
                agent_status: 'succeeded',
            });
            expect(stored.rows[0].due_at.toISOString()).toBe('2026-08-03T04:00:00.000Z');

            await client.query(
                `UPDATE tasks
                 SET status = 'done', completed_at = NOW()
                 WHERE company_id = $1 AND id = $2`,
                [fixture.companyA, first.task.id]
            );
            const afterCompletion = await appRuntimeTaskService.createTaskInTransaction(
                context,
                args,
                client
            );
            expect(afterCompletion).toMatchObject({ deduplicated: false });
            expect(afterCompletion.task.id).not.toBe(first.task.id);

            await expect(appRuntimeTaskService.createTaskInTransaction(context, {
                ...args,
                parent_id: Number(fixture.foreignJobB),
                description: 'Must not cross the tenant boundary.',
            }, client)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            const afterB = await snapshotCompanyB(client, fixture);
            expect(afterB).toEqual(beforeB);

            const metered = await createRunContext(client, fixture);
            await expect(tokenService.consumeRunWriteCall(metered)).resolves.toBe(1);
            await expect(tokenService.consumeRunWriteCall(metered)).resolves.toBe(2);
            await expect(tokenService.consumeRunWriteCall(metered)).resolves.toBe(3);
            await expect(tokenService.consumeRunWriteCall(metered)).rejects.toMatchObject({
                code: 'WRITE_CALL_LIMIT',
                message: 'Write call limit of 3 reached.',
                httpStatus: 429,
            });
            const writeMeter = await client.query(
                `SELECT write_calls_made
                 FROM app_runs
                 WHERE id = $1 AND company_id = $2`,
                [metered.run_id, fixture.companyA]
            );
            expect(writeMeter.rows[0].write_calls_made).toBe(3);

            await client.query(
                `INSERT INTO tasks
                    (company_id, thread_id, job_id, title, description, status,
                     owner_user_id, author_user_id, created_by, kind, agent_type,
                     agent_input, agent_status)
                 SELECT $1, NULL, $2, 'phase-g-daily-' || ordinal,
                        'phase-g-daily-' || ordinal, 'open', NULL, $3,
                        'agent', 'agent', 'app',
                        jsonb_build_object(
                            'source', 'app',
                            'installation_id', $4::text
                        ),
                        'succeeded'
                 FROM generate_series(1, 98) AS ordinal`,
                [
                    fixture.companyA,
                    fixture.ownedJobA,
                    fixture.principalA.agent.id,
                    String(fixture.installationA),
                ]
            );
            await expect(appRuntimeTaskService.createTaskInTransaction(context, {
                ...args,
                description: 'The one-hundred-and-first Task must be refused.',
            }, client)).rejects.toMatchObject({
                code: 'TASK_DAILY_LIMIT',
                message: 'Daily task creation limit of 100 reached.',
                httpStatus: 429,
            });
            const createdToday = await client.query(
                `SELECT COUNT(*)::integer AS count
                 FROM tasks
                 WHERE company_id = $1
                   AND agent_type = 'app'
                   AND agent_input->>'installation_id' = $2`,
                [fixture.companyA, String(fixture.installationA)]
            );
            expect(createdToday.rows[0].count).toBe(100);
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            rateLimit.resetForTests();
        }
    });

    databaseTest('APP-DATA-001 Phase H creates, attributes, deduplicates, and tenant-isolates Notes', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            const context = await createRunContext(client, fixture);
            const authorization = {
                ownerUserId: fixture.humanA.id,
                ownerScopes: { job_visibility: 'all' },
            };
            const beforeB = await snapshotCompanyB(client, fixture);
            const args = {
                parent_type: 'lead',
                parent_id: Number(fixture.ownedLeadA),
                text: 'Confirm the diagnostic window before dispatch.',
            };

            const first = await appRuntimeNoteService.addNoteInTransaction(
                context,
                args,
                client,
                authorization
            );
            const second = await appRuntimeNoteService.addNoteInTransaction(
                context,
                args,
                client,
                authorization
            );
            expect(first.deduplicated).toBe(false);
            expect(second).toEqual({ note: first.note, deduplicated: true });

            const stored = await client.query(
                `SELECT structured_notes
                 FROM leads
                 WHERE id = $1 AND company_id = $2`,
                [fixture.ownedLeadA, fixture.companyA]
            );
            expect(stored.rows[0].structured_notes).toContainEqual(expect.objectContaining({
                id: first.note.id,
                text: args.text,
                created_by: fixture.principalA.agent.id,
                author: fixture.principalA.agent.full_name,
                source: 'app',
                installation_id: String(fixture.installationA),
                agent_type: 'app',
                agent_input: {
                    source: 'app',
                    installation_id: String(fixture.installationA),
                },
            }));
            expect(stored.rows[0].structured_notes.filter(note => note.id === first.note.id))
                .toHaveLength(1);

            await expect(appRuntimeNoteService.addNoteInTransaction(context, {
                ...args,
                parent_id: Number(fixture.foreignLeadB),
            }, client, authorization)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

            const providerAuthorization = {
                ownerUserId: fixture.humanA.id,
                ownerScopes: { job_visibility: 'assigned_only' },
            };
            await expect(appRuntimeNoteService.addNoteInTransaction(context, {
                parent_type: 'job',
                parent_id: Number(fixture.ownedJobA),
                text: 'Assigned provider-visible Job Note.',
            }, client, providerAuthorization)).resolves.toMatchObject({ deduplicated: false });
            await expect(appRuntimeNoteService.addNoteInTransaction(context, {
                parent_type: 'job',
                parent_id: Number(fixture.unassignedJobA),
                text: 'Must remain hidden from the provider.',
            }, client, providerAuthorization)).rejects.toMatchObject({
                code: 'NOT_FOUND',
                httpStatus: 404,
            });
            expect(await snapshotCompanyB(client, fixture)).toEqual(beforeB);
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            rateLimit.resetForTests();
        }
    });

    databaseTest('F6 membership deletion succeeds and the already-resolved next call fails closed', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            const live = await createRunContext(client, fixture);
            const deleted = await client.query(
                `DELETE FROM company_memberships
                 WHERE id = $1 AND company_id = $2
                 RETURNING id`,
                [fixture.humanA.membershipId, fixture.companyA]
            );
            expect(deleted.rows).toHaveLength(1);
            await expect(tokenService.consumeRunCall(live)).rejects.toMatchObject({
                code: 'APP_RUNTIME_INACTIVE', httpStatus: 403,
            });
            const orphanedPrincipal = await client.query(
                `SELECT delegated_by_user_id
                 FROM app_installation_principals
                 WHERE id = $1 AND company_id = $2`,
                [fixture.principalA.principal.id, fixture.companyA]
            );
            expect(orphanedPrincipal.rows[0].delegated_by_user_id).toBe(fixture.humanA.id);
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('F2 PostgreSQL usage ceiling auto-suspends and app_runs stores completion metrics', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));
            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_gateway_call_limit = 2,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            const metered = await createRunContext(client, fixture);
            const completed = await createRunContext(client, fixture);
            await expect(tokenService.consumeRunCall(metered)).resolves.toBe(1);
            await expect(tokenService.consumeRunCall(metered)).resolves.toBe(2);
            await expect(tokenService.consumeRunCall(metered)).rejects.toMatchObject({
                code: 'APP_RUNTIME_SUSPENDED', httpStatus: 403,
            });
            await tokenService.recordRunCompletion({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: completed.run_id,
                nonce: completed.nonce_for_test,
            }, {
                wall_ms: 29,
                gateway_calls: 0,
                data_calls: 0,
                egress_calls: 0,
                result_bytes: null,
                error_code: 'APP_RUNTIME_SUSPENDED',
            });
            const accounting = await client.query(
                `SELECT usage.gateway_calls_used,
                        usage.daily_gateway_call_limit,
                        control.suspension_reason,
                        run.wall_ms,
                        run.gateway_calls_made,
                        run.result_bytes,
                        run.error_code,
                        run.status
                 FROM app_runtime_usage usage
                 JOIN app_runtime_installation_controls control
                   ON control.company_id = usage.company_id
                  AND control.app_id = usage.app_id
                  AND control.installation_id = usage.installation_id
                 JOIN app_runs run
                   ON run.company_id = usage.company_id
                  AND run.app_id = usage.app_id
                  AND run.installation_id = usage.installation_id
                  AND run.id = $3
                 WHERE usage.company_id = $1
                   AND usage.installation_id = $2
                   AND usage.usage_date = (NOW() AT TIME ZONE 'UTC')::date`,
                [fixture.companyA, fixture.installationA, completed.run_id]
            );
            expect(accounting.rows[0]).toEqual({
                gateway_calls_used: 2,
                daily_gateway_call_limit: 2,
                suspension_reason: 'DAILY_GATEWAY_CALL_LIMIT',
                wall_ms: '29',
                gateway_calls_made: 0,
                result_bytes: null,
                error_code: 'APP_RUNTIME_SUSPENDED',
                status: 'failed',
            });
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('SAB APP-FINAL-P0 DB admission is hash-pinned, one-time, consent-live, metered, and required by calls/completion', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => client.query(text, params));

            const unstarted = await createRunContext(client, fixture, 'A', false);
            await expect(tokenService.consumeRunCall(unstarted)).rejects.toMatchObject({
                code: 'APP_RUNTIME_INACTIVE', httpStatus: 403,
            });
            await expect(tokenService.recordRunCompletion({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: unstarted.run_id,
                nonce: unstarted.nonce_for_test,
            }, {
                wall_ms: 1, gateway_calls: 0, data_calls: 0, egress_calls: 0,
                result_bytes: 4, error_code: null,
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_INACTIVE', httpStatus: 403 });
            await expect(tokenService.authorizeRunExecution(
                unstarted,
                '0'.repeat(64)
            )).rejects.toMatchObject({ code: 'APP_RUNTIME_SOURCE_MISMATCH', httpStatus: 403 });

            await client.query(
                `UPDATE marketplace_installations
                 SET metadata = jsonb_set(
                     metadata,
                     '{app_runtime,consented_tools}',
                     '[]'::jsonb,
                     true
                 )
                 WHERE id = $1 AND company_id = $2`,
                [fixture.installationA, fixture.companyA]
            );
            const noConsent = await tokenService.resolveRunContext({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: unstarted.run_id,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: unstarted.nonce_for_test,
            });
            await expect(tokenService.authorizeRunExecution(
                noConsent,
                fixture.artifactSha256
            )).rejects.toMatchObject({ code: 'TOOL_NOT_CONSENTED', httpStatus: 403 });
            await client.query(
                `UPDATE marketplace_installations
                 SET metadata = jsonb_set(
                     metadata,
                     '{app_runtime,consented_tools}',
                     $3::jsonb,
                     true
                 )
                 WHERE id = $1 AND company_id = $2`,
                [fixture.installationA, fixture.companyA, JSON.stringify(TOOLS)]
            );

            const live = await tokenService.resolveRunContext({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: unstarted.run_id,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: unstarted.nonce_for_test,
            });
            await expect(tokenService.authorizeRunExecution(
                live,
                fixture.artifactSha256
            )).resolves.toMatchObject({ runs_started: 1, wall_ms_used: 0 });
            await expect(tokenService.authorizeRunExecution(
                live,
                fixture.artifactSha256
            )).rejects.toMatchObject({ code: 'APP_RUNTIME_ALREADY_STARTED', httpStatus: 409 });
            await expect(tokenService.consumeRunCall(live)).resolves.toBe(1);

            await client.query(
                `DELETE FROM app_runtime_usage
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_run_limit = 1,
                     daily_wall_ms_limit = 600000,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            const admitted = await createRunContext(client, fixture, 'A', false);
            await expect(tokenService.authorizeRunExecution(
                admitted,
                fixture.artifactSha256
            )).resolves.toMatchObject({ runs_started: 1 });
            const overLimit = await createRunContext(client, fixture, 'A', false);
            await expect(tokenService.authorizeRunExecution(
                overLimit,
                fixture.artifactSha256
            )).rejects.toMatchObject({ code: 'APP_RUNTIME_DAILY_RUN_LIMIT', httpStatus: 429 });
            const runSuspension = await client.query(
                `SELECT suspension_reason
                 FROM app_runtime_installation_controls
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            expect(runSuspension.rows[0].suspension_reason).toBe('DAILY_RUN_LIMIT');

            await client.query(
                `DELETE FROM app_runtime_usage
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_run_limit = 10,
                     daily_wall_ms_limit = 1,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            const wallMetered = await createRunContext(client, fixture, 'A', false);
            await tokenService.authorizeRunExecution(wallMetered, fixture.artifactSha256);
            await tokenService.recordRunCompletion({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: wallMetered.run_id,
                nonce: wallMetered.nonce_for_test,
            }, {
                wall_ms: 2, gateway_calls: 0, data_calls: 0, egress_calls: 0,
                result_bytes: 4, error_code: null,
            });
            const wallSuspension = await client.query(
                `SELECT control.suspension_reason, usage.runs_started, usage.wall_ms_used
                 FROM app_runtime_installation_controls control
                 JOIN app_runtime_usage usage
                   ON usage.company_id = control.company_id
                  AND usage.app_id = control.app_id
                  AND usage.installation_id = control.installation_id
                 WHERE control.company_id = $1
                   AND control.installation_id = $2
                   AND usage.usage_date = (NOW() AT TIME ZONE 'UTC')::date`,
                [fixture.companyA, fixture.installationA]
            );
            expect(wallSuspension.rows[0]).toEqual({
                suspension_reason: 'DAILY_WALL_MS_LIMIT', runs_started: 1, wall_ms_used: '2',
            });

            await client.query(
                `UPDATE app_runtime_installation_controls
                 SET daily_wall_ms_limit = 600000,
                     suspended_at = NULL,
                     suspension_reason = NULL,
                     updated_at = NOW()
                 WHERE company_id = $1 AND installation_id = $2`,
                [fixture.companyA, fixture.installationA]
            );
            const revoked = await createRunContext(client, fixture);
            await client.query(
                `UPDATE app_runs
                 SET status = 'revoked', revoked_at = NOW()
                 WHERE id = $1 AND company_id = $2`,
                [revoked.run_id, fixture.companyA]
            );
            await expect(tokenService.recordRunCompletion({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: revoked.run_id,
                nonce: revoked.nonce_for_test,
            }, {
                wall_ms: 2, gateway_calls: 0, data_calls: 0, egress_calls: 0,
                result_bytes: 4, error_code: null,
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_INACTIVE', httpStatus: 403 });
            expect(await client.query(
                `SELECT status FROM app_runs WHERE id = $1 AND company_id = $2`,
                [revoked.run_id, fixture.companyA]
            )).toMatchObject({ rows: [{ status: 'revoked' }] });
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('APP-MOD-001 revoke kill-switch makes the next gateway resolution return 403', async () => {
        const client = await db.pool.connect();
        let dbSpy;
        try {
            await client.query('BEGIN');
            const fixture = await setupFixture(client);
            await client.query(
                `INSERT INTO app_studio_apps (app_id, company_id, created_by)
                 VALUES ($1, $2, $3)`,
                [fixture.appId, fixture.companyA, fixture.humanA.id]
            );
            dbSpy = jest.spyOn(db, 'query').mockImplementation((text, params) => (
                client.query(text, params)
            ));
            const live = await createRunContext(client, fixture);
            let savepointOpen = false;
            const transitionDatabase = {
                getClient: async () => ({
                    query: async (text, params) => {
                        if (text === 'BEGIN') {
                            savepointOpen = true;
                            return client.query('SAVEPOINT app_mod_revoke');
                        }
                        if (text === 'COMMIT') {
                            savepointOpen = false;
                            return client.query('RELEASE SAVEPOINT app_mod_revoke');
                        }
                        if (text === 'ROLLBACK') {
                            if (!savepointOpen) return undefined;
                            savepointOpen = false;
                            return client.query('ROLLBACK TO SAVEPOINT app_mod_revoke');
                        }
                        return client.query(text, params);
                    },
                    release: jest.fn(),
                }),
            };
            const transitionService = appVersionTransitionModule
                .createAppVersionTransitionService({ database: transitionDatabase });
            await expect(transitionService.revokeVersion({
                versionId: fixture.versionId,
                actorId: fixture.humanA.id,
                traceId: 'trace-app-mod-revoke',
            })).resolves.toMatchObject({ status: 'revoked' });

            await expect(tokenService.resolveRunContext({
                installation_id: String(fixture.installationA),
                version_id: String(fixture.versionId),
                run_id: live.run_id,
                exp: Math.floor(Date.now() / 1000) + 300,
                nonce: live.nonce_for_test,
            })).rejects.toMatchObject({ code: 'APP_RUNTIME_INACTIVE', httpStatus: 403 });
        } finally {
            dbSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
