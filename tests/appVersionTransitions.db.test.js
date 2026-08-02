'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const db = require('../backend/src/db/connection');
const transitionModule = require('../backend/src/services/appVersionTransitionService');
const reviewService = require('../backend/src/services/appVersionReviewService');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const RUNTIME_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '220_app_runtime_gateway.sql'), 'utf8');
const BUILDER_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '221_app_studio_builder.sql'), 'utf8');
const GAP_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '222_app_studio_gap_fixes.sql'), 'utf8');
const MOD_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '223_app_version_moderation.sql'), 'utf8');
const VIEW_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '228_app_view_phase_a.sql'), 'utf8');
const SCHEDULE_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '229_app_view_phase_b.sql'), 'utf8');
const DATA_SCHEMA = fs.readFileSync(path.join(MIGRATIONS, '230_app_data_phase_d.sql'), 'utf8');
const MOD_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_223_app_version_moderation.sql'),
    'utf8'
);

jest.setTimeout(120000);

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
    test('APP-MOD-001 DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-MOD-001 DB tests are pending: ${DATABASE.reason}`);
    });
}

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function transactionalDatabase(client) {
    let sequence = 0;
    return {
        getClient: async () => {
            const savepoint = `app_mod_service_${sequence += 1}`;
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
                        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                        return client.query(`RELEASE SAVEPOINT ${savepoint}`);
                    }
                    return client.query(text, params);
                },
                release: jest.fn(),
            };
        },
    };
}

async function insertCompany(client, label) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [id, `APP MOD ${label}`, `app-mod-${label.toLowerCase()}-${id}`]
    );
    return id;
}

async function insertActor(client, companyId, label) {
    const { rows } = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, 'company_admin', 'active', $4,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-mod-${label}-${randomUUID()}`,
            `app-mod-${label}-${randomUUID()}@example.test`,
            `APP MOD ${label}`,
            companyId,
        ]
    );
    return rows[0].id;
}

async function insertOwnedApp(client, companyId, actorId, label) {
    const { rows } = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, $2, 'Albusto App Studio', 'custom', 'private',
                 'APP-MOD fixture', '[]'::jsonb, 'none', 'draft', $3::jsonb)
         RETURNING id`,
        [
            `app-mod-${label}-${randomUUID()}`,
            `APP MOD ${label}`,
            JSON.stringify({
                assistant: {
                    what_it_does: 'Tests app moderation.',
                    prerequisites: [],
                    setup_steps: [],
                    outcome: 'A moderated test artifact.',
                    recommend_when: [],
                    gotchas: [],
                },
            }),
        ]
    );
    await client.query(
        `INSERT INTO app_studio_apps (app_id, company_id, created_by)
         VALUES ($1, $2, $3)`,
        [rows[0].id, companyId, actorId]
    );
    await client.query(
        `INSERT INTO app_build_chats (company_id, app_id, created_by, title)
         VALUES ($1, $2, $3, 'Moderation fixture chat')`,
        [companyId, rows[0].id, actorId]
    );
    return rows[0].id;
}

async function insertDraft(client, appId, actorId, label = randomUUID()) {
    const source = `export async function run(ctx) { return { label: ${JSON.stringify(label)}, input: ctx.input }; }`;
    const { rows } = await client.query(
        `INSERT INTO app_versions
            (app_id, version_number, source_code, source_sha256,
             scanner_report, status, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'draft', $6)
         RETURNING id`,
        [
            appId,
            `builder-${label}`,
            source,
            digest(source),
            JSON.stringify({
                parsed: true,
                dry_run: { ok: true, usage: { wall_ms: 2 } },
            }),
            actorId,
        ]
    );
    await client.query(
        `INSERT INTO app_version_tools (version_id, tool_name)
         VALUES ($1, 'svc.list_jobs')`,
        [rows[0].id]
    );
    return { id: rows[0].id, source };
}

async function advanceTo(service, fixture, target, context) {
    const steps = {
        draft: [],
        submitted: ['submitted'],
        in_review: ['submitted', 'in_review'],
        approved: ['submitted', 'in_review', 'approved'],
        rejected: ['submitted', 'in_review', 'rejected'],
        published: ['submitted', 'in_review', 'approved', 'published'],
        revoked: ['submitted', 'in_review', 'approved', 'published', 'revoked'],
    }[target];
    for (const status of steps) {
        await service.transitionVersion({
            ...context,
            versionId: fixture.id,
            toStatus: status,
            ...(status === 'rejected' ? { reason: 'The artifact needs a safer implementation.' } : {}),
        });
    }
}

async function versionStatus(client, id, appId) {
    const { rows } = await client.query(
        `SELECT status FROM app_versions WHERE id = $1 AND app_id = $2`,
        [id, appId]
    );
    return rows[0]?.status;
}

describe('APP-MOD-001 migration and transition matrix', () => {
    test('migration number, transition trigger, lock hardening, and rollback are paired', () => {
        expect(MOD_SCHEMA).toContain("'rejected'");
        expect(MOD_SCHEMA).toContain('APP_VERSION_TRANSITION_SERVICE_REQUIRED');
        expect(MOD_SCHEMA).toContain('APP_VERSION_TRANSITION_INVALID');
        expect(MOD_SCHEMA).toContain('NEW.scanner_report IS DISTINCT FROM OLD.scanner_report');
        expect(MOD_SCHEMA).toMatch(/app_runtime_protect_version_tools[\s\S]*FOR UPDATE/);
        expect(MOD_ROLLBACK).toContain('DROP FUNCTION IF EXISTS app_version_enforce_transition');
        expect(MOD_ROLLBACK).toContain('DROP COLUMN IF EXISTS rejection_reason');
    });

    databaseTest('migration applies twice and forward → rollback → forward is repeatable', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(RUNTIME_SCHEMA);
            await client.query(BUILDER_SCHEMA);
            await client.query(GAP_SCHEMA);
            await client.query(MOD_SCHEMA);
            await client.query(MOD_SCHEMA);
            await client.query(MOD_ROLLBACK);
            await client.query(MOD_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'app_versions'
                      AND column_name = 'rejection_reason'
                 ) AS has_reason`
            );
            expect(rolledBack.rows[0].has_reason).toBe(false);
            await client.query(MOD_SCHEMA);
            const reapplied = await client.query(
                `SELECT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'app_versions'
                      AND column_name = 'rejection_reason'
                 ) AS has_reason,
                 EXISTS (
                    SELECT 1 FROM pg_trigger
                    WHERE tgname = 'trg_app_version_transition'
                      AND NOT tgisinternal
                 ) AS has_transition_trigger`
            );
            expect(reapplied.rows[0]).toEqual({
                has_reason: true,
                has_transition_trigger: true,
            });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('SAB APP-FINAL-P1 transition responses omit source and rejection sinks are scrubbed across the full matrix', async () => {
        const client = await db.pool.connect();
        let querySpy;
        let getClientSpy;
        try {
            await client.query('BEGIN');
            await client.query(RUNTIME_SCHEMA);
            await client.query(BUILDER_SCHEMA);
            await client.query(GAP_SCHEMA);
            await client.query(MOD_SCHEMA);
            await client.query(MOD_SCHEMA);
            await client.query(VIEW_SCHEMA);
            await client.query(SCHEDULE_SCHEMA);
            await client.query(DATA_SCHEMA);

            const companyA = await insertCompany(client, 'A');
            const companyB = await insertCompany(client, 'B');
            const actorA = await insertActor(client, companyA, 'actor-a');
            const actorB = await insertActor(client, companyB, 'actor-b');
            const appA = await insertOwnedApp(client, companyA, actorA, 'a');
            const appB = await insertOwnedApp(client, companyB, actorB, 'b');
            const service = transitionModule.createAppVersionTransitionService({
                database: transactionalDatabase(client),
            });
            const contextA = {
                appId: String(appA), companyId: companyA, actorId: actorA, traceId: 'trace-matrix',
            };

            const allowed = [
                ['draft', 'submitted'],
                ['submitted', 'in_review'],
                ['in_review', 'approved'],
                ['in_review', 'rejected'],
                ['approved', 'published'],
                ['published', 'revoked'],
            ];
            for (const [fromStatus, toStatus] of allowed) {
                const fixture = await insertDraft(client, appA, actorA);
                await advanceTo(service, fixture, fromStatus, contextA);
                const result = await service.transitionVersion({
                    ...contextA,
                    versionId: fixture.id,
                    toStatus,
                    ...(toStatus === 'rejected' ? { reason: 'Unsafe reflection path.' } : {}),
                });
                expect(result.status).toBe(toStatus);
                expect(result).not.toHaveProperty('source_code');
                expect(result).not.toHaveProperty('created_by');
                expect(result).not.toHaveProperty('reviewed_by');
                expect(result).not.toHaveProperty('company_id');
                expect(await versionStatus(client, fixture.id, appA)).toBe(toStatus);
            }

            const previouslyLiveVersionId = randomUUID();
            const installation = await client.query(
                `INSERT INTO marketplace_installations
                    (company_id, app_id, status, installed_by, installed_at, metadata)
                 VALUES ($1, $2, 'connected', $3, NOW(), $4::jsonb)
                 RETURNING id`,
                [
                    companyA,
                    appA,
                    actorA,
                    JSON.stringify({
                        app_runtime: {
                            version_id: previouslyLiveVersionId,
                            consented_tools: ['svc.list_jobs'],
                        },
                    }),
                ]
            );
            const rollout = await insertDraft(client, appA, actorA);
            await advanceTo(service, rollout, 'approved', contextA);
            const beforePublish = await client.query(
                `SELECT metadata->'app_runtime' AS runtime
                 FROM marketplace_installations
                 WHERE id = $1 AND company_id = $2`,
                [installation.rows[0].id, companyA]
            );
            expect(beforePublish.rows[0].runtime).toEqual({
                version_id: previouslyLiveVersionId,
                consented_tools: ['svc.list_jobs'],
            });
            await service.publishVersion({ ...contextA, versionId: rollout.id });
            const afterPublish = await client.query(
                `SELECT metadata->'app_runtime' AS runtime
                 FROM marketplace_installations
                 WHERE id = $1 AND company_id = $2`,
                [installation.rows[0].id, companyA]
            );
            expect(afterPublish.rows[0].runtime).toEqual({
                version_id: previouslyLiveVersionId,
                consented_tools: ['svc.list_jobs'],
            });

            const rejected = await insertDraft(client, appA, actorA);
            await advanceTo(service, rejected, 'rejected', contextA);
            const fork = await service.forkRejectedVersion({
                ...contextA,
                versionId: rejected.id,
            });
            expect(fork.status).toBe('draft');
            expect(fork).not.toHaveProperty('source_code');
            expect(fork).not.toHaveProperty('created_by');
            const forkTools = await client.query(
                `SELECT tool_name FROM app_version_tools WHERE version_id = $1 ORDER BY tool_name`,
                [fork.id]
            );
            expect(forkTools.rows.map(row => row.tool_name)).toEqual(['svc.list_jobs']);

            const statuses = ['draft', 'submitted', 'in_review', 'approved', 'rejected', 'published', 'revoked'];
            const allowedSet = new Set(allowed.map(edge => edge.join('->')));
            for (const fromStatus of statuses) {
                for (const toStatus of statuses) {
                    if (fromStatus === toStatus || allowedSet.has(`${fromStatus}->${toStatus}`)) continue;
                    const fixture = await insertDraft(client, appA, actorA);
                    await advanceTo(service, fixture, fromStatus, contextA);
                    await expect(service.transitionVersion({
                        ...contextA,
                        versionId: fixture.id,
                        toStatus,
                        reason: 'Forbidden transition reason.',
                    })).rejects.toMatchObject({
                        code: 'VERSION_TRANSITION_CONFLICT', httpStatus: 409,
                    });
                    expect(await versionStatus(client, fixture.id, appA)).toBe(fromStatus);
                }
            }

            const immutable = await insertDraft(client, appA, actorA);
            await service.submitVersion({ ...contextA, versionId: immutable.id });
            await service.startReview({ ...contextA, versionId: immutable.id });
            const idempotentReview = await service.startReview({
                ...contextA, versionId: immutable.id,
            });
            expect(idempotentReview).not.toHaveProperty('source_code');
            expect(await versionStatus(client, immutable.id, appA)).toBe('in_review');
            await client.query('SAVEPOINT immutable_source');
            await expect(client.query(
                `UPDATE app_versions SET source_code = 'changed' WHERE id = $1 AND app_id = $2`,
                [immutable.id, appA]
            )).rejects.toThrow(/APP_VERSION_ARTIFACT_IMMUTABLE/);
            await client.query('ROLLBACK TO SAVEPOINT immutable_source');
            await client.query('SAVEPOINT immutable_hash');
            await expect(client.query(
                `UPDATE app_versions SET source_sha256 = $3 WHERE id = $1 AND app_id = $2`,
                [immutable.id, appA, '0'.repeat(64)]
            )).rejects.toThrow(/APP_VERSION_ARTIFACT_IMMUTABLE/);
            await client.query('ROLLBACK TO SAVEPOINT immutable_hash');
            await client.query('SAVEPOINT immutable_tool');
            await expect(client.query(
                `INSERT INTO app_version_tools (version_id, tool_name)
                 VALUES ($1, 'svc.list_tasks')`,
                [immutable.id]
            )).rejects.toThrow(/APP_VERSION_TOOLS_IMMUTABLE/);
            await client.query('ROLLBACK TO SAVEPOINT immutable_tool');

            const sameStatement = await insertDraft(client, appA, actorA);
            await client.query('SAVEPOINT same_statement');
            await client.query(
                `SELECT set_config('app.version_transition_service', 'enabled', true)`
            );
            await expect(client.query(
                `UPDATE app_versions
                 SET status = 'submitted', source_code = 'changed'
                 WHERE id = $1 AND app_id = $2`,
                [sameStatement.id, appA]
            )).rejects.toThrow(/APP_VERSION_ARTIFACT_IMMUTABLE/);
            await client.query('ROLLBACK TO SAVEPOINT same_statement');

            const directStatus = await insertDraft(client, appA, actorA);
            await client.query('SAVEPOINT direct_status');
            await client.query(`SELECT set_config('app.version_transition_service', 'disabled', true)`);
            await expect(client.query(
                `UPDATE app_versions SET status = 'submitted' WHERE id = $1 AND app_id = $2`,
                [directStatus.id, appA]
            )).rejects.toThrow(/APP_VERSION_TRANSITION_SERVICE_REQUIRED/);
            await client.query('ROLLBACK TO SAVEPOINT direct_status');

            const sensitive = await insertDraft(client, appA, actorA);
            await service.submitVersion({ ...contextA, versionId: sensitive.id });
            await service.startReview({ ...contextA, versionId: sensitive.id });
            const rawReason = 'Bearer abcdefghijklmnop for customer@example.com at +16175550101';
            const rejectedSensitive = await service.rejectVersion({
                ...contextA,
                versionId: sensitive.id,
                reason: rawReason,
            });
            expect(rejectedSensitive.rejection_reason).toContain('[REDACTED_BEARER_TOKEN]');
            expect(rejectedSensitive.rejection_reason).toContain('[REDACTED_EMAIL]');
            expect(rejectedSensitive.rejection_reason).toContain('[REDACTED_PHONE]');
            expect(rejectedSensitive).not.toHaveProperty('source_code');
            const sensitiveSinks = await client.query(
                `SELECT version.rejection_reason,
                        (SELECT details
                         FROM audit_log audit
                         WHERE audit.company_id = owned.company_id
                           AND audit.action = 'app_version.transition'
                           AND audit.target_id = version.id::text
                         ORDER BY audit.id DESC
                         LIMIT 1) AS audit_details,
                        (SELECT message.text
                         FROM app_build_messages message
                         WHERE message.company_id = owned.company_id
                           AND message.app_id = version.app_id
                           AND message.version_id = version.id
                         ORDER BY message.id DESC
                         LIMIT 1) AS author_message
                 FROM app_versions version
                 JOIN app_studio_apps owned
                   ON owned.app_id = version.app_id
                  AND owned.company_id = $2
                 WHERE version.id = $1
                   AND version.app_id = owned.app_id`,
                [sensitive.id, companyA]
            );
            const serializedSinks = JSON.stringify(sensitiveSinks.rows[0]);
            expect(serializedSinks).not.toContain('abcdefghijklmnop');
            expect(serializedSinks).not.toContain('customer@example.com');
            expect(serializedSinks).not.toContain('+16175550101');

            const foreign = await insertDraft(client, appB, actorB);
            await service.submitVersion({
                appId: String(appB),
                companyId: companyB,
                actorId: actorB,
                versionId: foreign.id,
                traceId: 'trace-company-b',
            });
            const beforeB = await client.query(
                `SELECT jsonb_build_object(
                    'version', (SELECT to_jsonb(version)
                                FROM app_versions version
                                WHERE version.id = $1 AND version.app_id = $2),
                    'messages', (SELECT COALESCE(jsonb_agg(to_jsonb(message) ORDER BY message.id), '[]'::jsonb)
                                 FROM app_build_messages message
                                 WHERE message.company_id = $3),
                    'audits', (SELECT COALESCE(jsonb_agg(to_jsonb(audit) ORDER BY audit.id), '[]'::jsonb)
                               FROM audit_log audit
                               WHERE audit.company_id = $3)
                 ) AS snapshot`,
                [foreign.id, appB, companyB]
            );
            await expect(service.submitVersion({
                ...contextA,
                appId: String(appB),
                versionId: foreign.id,
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            const afterB = await client.query(
                `SELECT jsonb_build_object(
                    'version', (SELECT to_jsonb(version)
                                FROM app_versions version
                                WHERE version.id = $1 AND version.app_id = $2),
                    'messages', (SELECT COALESCE(jsonb_agg(to_jsonb(message) ORDER BY message.id), '[]'::jsonb)
                                 FROM app_build_messages message
                                 WHERE message.company_id = $3),
                    'audits', (SELECT COALESCE(jsonb_agg(to_jsonb(audit) ORDER BY audit.id), '[]'::jsonb)
                               FROM audit_log audit
                               WHERE audit.company_id = $3)
                 ) AS snapshot`,
                [foreign.id, appB, companyB]
            );
            expect(afterB.rows[0].snapshot).toStrictEqual(beforeB.rows[0].snapshot);

            querySpy = jest.spyOn(db, 'query').mockImplementation((text, params) => (
                client.query(text, params)
            ));
            const queue = await reviewService.listReviews({ status: 'pending', page: 1, limit: 100 });
            expect(queue.requests.some(row => String(row.company_id) === companyA)).toBe(true);
            expect(queue.requests.some(row => String(row.company_id) === companyB)).toBe(true);

            getClientSpy = jest.spyOn(db, 'getClient').mockImplementation(
                transactionalDatabase(client).getClient
            );
            const rejectedReview = await reviewService.getReview(rejected.id, {
                actorId: actorA,
                traceId: 'trace-review-detail',
                includeCode: true,
            });
            expect(rejectedReview.version.source_code).toBe(rejected.source);
            expect(rejectedReview.version.sandbox_run).toMatchObject({ ok: true });
            expect(rejectedReview.chats.flatMap(chat => chat.messages).some(message => (
                message.text.includes('The artifact needs a safer implementation.')
            ))).toBe(true);

            const transitionAudits = await client.query(
                `SELECT details
                 FROM audit_log
                 WHERE company_id = $1
                   AND action = 'app_version.transition'`,
                [companyA]
            );
            expect(transitionAudits.rows.length).toBeGreaterThan(0);
            expect(JSON.stringify(transitionAudits.rows)).not.toContain(rejected.source);
        } finally {
            getClientSpy?.mockRestore();
            querySpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});

databaseTest('SAB APP-MOD-P1-05 concurrent approve requires FOR UPDATE: exactly one succeeds', async () => {
    const admin = await db.pool.connect();
    const schema = `app_mod_race_${randomUUID().replace(/-/g, '')}`;
    const quotedSchema = `"${schema}"`;
    try {
        await admin.query(`CREATE SCHEMA ${quotedSchema}`);
        await admin.query(`SET search_path TO ${quotedSchema}, public`);
        await admin.query(`
            CREATE TABLE marketplace_apps (
                id BIGINT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE app_studio_apps (
                app_id BIGINT PRIMARY KEY,
                company_id UUID NOT NULL
            );
            CREATE TABLE app_versions (
                id UUID PRIMARY KEY,
                app_id BIGINT NOT NULL,
                version_number TEXT NOT NULL,
                source_code TEXT NOT NULL,
                source_sha256 CHAR(64) NOT NULL,
                scanner_report JSONB NOT NULL DEFAULT '{}'::jsonb,
                status TEXT NOT NULL,
                created_by UUID,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                submitted_at TIMESTAMPTZ,
                reviewed_by UUID,
                reviewed_at TIMESTAMPTZ,
                published_at TIMESTAMPTZ,
                rejection_reason TEXT
            );
            CREATE TABLE audit_log (
                id BIGSERIAL PRIMARY KEY,
                actor_id UUID,
                action TEXT NOT NULL,
                target_type TEXT,
                target_id TEXT,
                company_id UUID,
                details JSONB NOT NULL DEFAULT '{}'::jsonb,
                trace_id TEXT
            );
        `);
        const companyId = randomUUID();
        const actorId = randomUUID();
        const versionId = randomUUID();
        const source = 'export async function run() { return true; }';
        await admin.query(
            `INSERT INTO marketplace_apps (id, name, status)
             VALUES (1, 'Race app', 'draft')`
        );
        await admin.query(
            `INSERT INTO app_studio_apps (app_id, company_id) VALUES (1, $1)`,
            [companyId]
        );
        await admin.query(
            `INSERT INTO app_versions
                (id, app_id, version_number, source_code, source_sha256, status)
             VALUES ($1, 1, 'builder-race', $2, $3, 'in_review')`,
            [versionId, source, digest(source)]
        );

        const raceDatabase = {
            getClient: async () => {
                const client = await db.pool.connect();
                await client.query(`SET search_path TO ${quotedSchema}, public`);
                return client;
            },
        };
        const service = transitionModule.createAppVersionTransitionService({
            database: raceDatabase,
            afterVersionLock: () => new Promise(resolve => setTimeout(resolve, 120)),
        });
        const outcomes = await Promise.allSettled([
            service.approveVersion({ versionId, actorId, traceId: 'race-a' }),
            service.approveVersion({ versionId, actorId, traceId: 'race-b' }),
        ]);
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect(outcomes.find(result => result.status === 'rejected').reason).toMatchObject({
            code: 'VERSION_TRANSITION_CONFLICT',
            httpStatus: 409,
        });
        const stored = await admin.query(
            `SELECT status FROM app_versions WHERE id = $1 AND app_id = 1`,
            [versionId]
        );
        expect(stored.rows[0].status).toBe('approved');
    } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => {});
        admin.release();
    }
});
