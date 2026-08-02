'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const db = require('../backend/src/db/connection');
const repository = require('../backend/src/services/appBuilderRepository');

const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const RUNTIME_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '220_app_runtime_gateway.sql'),
    'utf8'
);
const BUILDER_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '221_app_studio_builder.sql'),
    'utf8'
);
const BUILDER_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_221_app_studio_builder.sql'),
    'utf8'
);
const GAP_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '222_app_studio_gap_fixes.sql'),
    'utf8'
);
const GAP_ROLLBACK = fs.readFileSync(
    path.join(MIGRATIONS, 'rollback_222_app_studio_gap_fixes.sql'),
    'utf8'
);
const MODERATION_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '223_app_version_moderation.sql'),
    'utf8'
);
const VIEW_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '228_app_view_phase_a.sql'),
    'utf8'
);
const SCHEDULE_SCHEMA = fs.readFileSync(
    path.join(MIGRATIONS, '229_app_view_phase_b.sql'),
    'utf8'
);

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
    test('APP-BUILD-001 tenancy DB release blocker: PostgreSQL must be available', () => {
        throw new Error(`APP-BUILD-001 tenancy DB tests are pending: ${DATABASE.reason}`);
    });
}

async function insertCompany(client, label) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [id, `APP BUILD ${label}`, `app-build-${label.toLowerCase()}-${id}`]
    );
    return id;
}

async function insertAdmin(client, companyId, label) {
    const user = await client.query(
        `INSERT INTO crm_users
            (keycloak_sub, email, full_name, role, status, company_id,
             platform_role, onboarding_status, kind)
         VALUES ($1, $2, $3, 'company_admin', 'active', $4,
                 'none', 'active', 'user')
         RETURNING id`,
        [
            `app-build-${label}-${randomUUID()}`,
            `app-build-${label}-${randomUUID()}@example.test`,
            `APP BUILD ${label}`,
            companyId,
        ]
    );
    await client.query(
        `INSERT INTO company_memberships
            (user_id, company_id, role, role_key, status)
         VALUES ($1, $2, 'company_admin', 'tenant_admin', 'active')`,
        [user.rows[0].id, companyId]
    );
    return user.rows[0].id;
}

async function insertOwnedApp(client, companyId, actorId, label) {
    const app = await client.query(
        `INSERT INTO marketplace_apps
            (app_key, name, provider_name, category, app_type, short_description,
             requested_scopes, provisioning_mode, status, metadata)
         VALUES ($1, 'Shared Builder Name', 'Albusto App Studio', 'custom', 'private',
                 'Shared builder description', '[]'::jsonb, 'none', 'draft', $2::jsonb)
         RETURNING id`,
        [
            `app-build-${label}-${randomUUID()}`,
            JSON.stringify({
                assistant: {
                    what_it_does: 'Test app', prerequisites: [], setup_steps: [],
                    outcome: 'Test', recommend_when: [], gotchas: [],
                },
            }),
        ]
    );
    await client.query(
        `INSERT INTO app_studio_apps (app_id, company_id, created_by)
         VALUES ($1, $2, $3)`,
        [app.rows[0].id, companyId, actorId]
    );
    return app.rows[0].id;
}

async function insertChatVersion(client, companyId, actorId, appId) {
    const chat = await client.query(
        `INSERT INTO app_build_chats (company_id, app_id, created_by, title)
         VALUES ($1, $2, $3, 'Shared Builder Chat')
         RETURNING id`,
        [companyId, appId, actorId]
    );
    const source = 'export async function run(ctx) { return { value: ctx.input.today }; }';
    const sha = crypto.createHash('sha256').update(source).digest('hex');
    const version = await client.query(
        `INSERT INTO app_versions
            (app_id, version_number, source_code, source_sha256, scanner_report, status, created_by)
         VALUES ($1, $2, $3, $4, '{"parsed":true}'::jsonb, 'draft', $5)
         RETURNING id`,
        [appId, `builder-${randomUUID()}`, source, sha, actorId]
    );
    await client.query(
        `INSERT INTO app_build_messages
            (company_id, chat_id, app_id, role, text, model, token_usage, version_id)
         VALUES ($1, $2, $3, 'assistant', 'Shared generated description',
                 'test-model', '{"total_tokens":10}'::jsonb, $4)`,
        [companyId, chat.rows[0].id, appId, version.rows[0].id]
    );
    return { chatId: chat.rows[0].id, versionId: version.rows[0].id };
}

async function snapshotCompany(client, companyId) {
    const { rows } = await client.query(
        `SELECT
            (SELECT COALESCE(jsonb_agg(to_jsonb(chat) ORDER BY chat.id), '[]'::jsonb)
             FROM app_build_chats chat WHERE chat.company_id = $1) AS chats,
            (SELECT COALESCE(jsonb_agg(to_jsonb(message) ORDER BY message.id), '[]'::jsonb)
             FROM app_build_messages message WHERE message.company_id = $1) AS messages,
            (SELECT COALESCE(jsonb_agg(to_jsonb(owned) ORDER BY owned.app_id), '[]'::jsonb)
             FROM app_studio_apps owned WHERE owned.company_id = $1) AS owned_apps,
            (SELECT COALESCE(jsonb_agg(to_jsonb(version) ORDER BY version.id), '[]'::jsonb)
             FROM app_versions version
             JOIN app_studio_apps owned ON owned.app_id = version.app_id
             WHERE owned.company_id = $1) AS versions,
            (SELECT COALESCE(jsonb_agg(to_jsonb(audit) ORDER BY audit.id), '[]'::jsonb)
             FROM audit_log audit WHERE audit.company_id = $1) AS audits,
            (SELECT COALESCE(jsonb_agg(to_jsonb(usage) ORDER BY usage.usage_date), '[]'::jsonb)
             FROM app_builder_usage_counters usage WHERE usage.company_id = $1) AS usage`,
        [companyId]
    );
    return rows[0];
}

describe('APP-BUILD-001 migration and tenant isolation', () => {
    test('migration declares composite ownership and a matching rollback', () => {
        expect(BUILDER_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS app_studio_apps');
        expect(BUILDER_SCHEMA).toContain('uq_app_studio_apps_company_app');
        expect(BUILDER_SCHEMA).toContain('fk_app_build_chats_owned_app');
        expect(BUILDER_SCHEMA).toContain('fk_app_build_messages_chat');
        expect(BUILDER_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS app_builder_usage_counters');
        expect(BUILDER_ROLLBACK).toContain('DROP TABLE IF EXISTS app_build_messages');
        expect(BUILDER_ROLLBACK).not.toMatch(/DELETE FROM marketplace_apps|DROP TABLE IF EXISTS app_versions/);
    });

    databaseTest('migration applies twice and forward → rollback → forward preserves Phase 1 artifacts', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(RUNTIME_SCHEMA);
            await client.query(BUILDER_SCHEMA);
            await client.query(BUILDER_SCHEMA);
            await client.query(BUILDER_ROLLBACK);
            await client.query(BUILDER_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT to_regclass('app_studio_apps')::text AS owned,
                        to_regclass('app_build_chats')::text AS chats,
                        to_regclass('app_build_messages')::text AS messages,
                        to_regclass('app_builder_usage_counters')::text AS usage,
                        to_regclass('app_versions')::text AS versions`
            );
            expect(rolledBack.rows[0]).toEqual({
                owned: null,
                chats: null,
                messages: null,
                usage: null,
                versions: 'app_versions',
            });
            await client.query(BUILDER_SCHEMA);
            const reapplied = await client.query(
                `SELECT to_regclass('app_studio_apps')::text AS owned,
                        to_regclass('app_build_chats')::text AS chats,
                        to_regclass('app_build_messages')::text AS messages,
                        to_regclass('app_builder_usage_counters')::text AS usage`
            );
            expect(reapplied.rows[0]).toEqual({
                owned: 'app_studio_apps',
                chats: 'app_build_chats',
                messages: 'app_build_messages',
                usage: 'app_builder_usage_counters',
            });
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('APP-GAP-FIX-001 migration 222 applies twice and has a matching rollback', async () => {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(RUNTIME_SCHEMA);
            await client.query(BUILDER_SCHEMA);
            await client.query(GAP_SCHEMA);
            await client.query(GAP_SCHEMA);
            const applied = await client.query(
                `SELECT to_regclass('app_runtime_usage')::text AS usage,
                        to_regclass('app_runtime_installation_controls')::text AS controls,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runs' AND column_name = 'wall_ms'
                        ) AS run_metrics,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_build_messages'
                              AND column_name = 'retention_expires_at'
                        ) AS retention`
            );
            expect(applied.rows[0]).toEqual({
                usage: 'app_runtime_usage',
                controls: 'app_runtime_installation_controls',
                run_metrics: true,
                retention: true,
            });
            await client.query(GAP_ROLLBACK);
            await client.query(GAP_ROLLBACK);
            const rolledBack = await client.query(
                `SELECT to_regclass('app_runtime_usage')::text AS usage,
                        to_regclass('app_runtime_installation_controls')::text AS controls,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_runs' AND column_name = 'wall_ms'
                        ) AS run_metrics,
                        EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_name = 'app_build_messages'
                              AND column_name = 'retention_expires_at'
                        ) AS retention`
            );
            expect(rolledBack.rows[0]).toEqual({
                usage: null,
                controls: null,
                run_metrics: false,
                retention: false,
            });
            await client.query(GAP_SCHEMA);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });

    databaseTest('T-own/T-foreign/T-blast: chats and versions are invisible and immutable across companies', async () => {
        const client = await db.pool.connect();
        let connectSpy;
        let querySpy;
        try {
            await client.query('BEGIN');
            await client.query(RUNTIME_SCHEMA);
            await client.query(BUILDER_SCHEMA);
            await client.query(BUILDER_SCHEMA);
            await client.query(GAP_SCHEMA);
            await client.query(MODERATION_SCHEMA);
            await client.query(VIEW_SCHEMA);
            await client.query(SCHEDULE_SCHEMA);
            const companyA = await insertCompany(client, 'A');
            const companyB = await insertCompany(client, 'B');
            const actorA = await insertAdmin(client, companyA, 'admin-a');
            const actorB = await insertAdmin(client, companyB, 'admin-b');
            const appA = await insertOwnedApp(client, companyA, actorA, 'a');
            const appB = await insertOwnedApp(client, companyB, actorB, 'b');
            const fixtureA = await insertChatVersion(client, companyA, actorA, appA);
            const fixtureB = await insertChatVersion(client, companyB, actorB, appB);
            await client.query(
                `UPDATE app_build_messages
                 SET retention_expires_at = NOW() - INTERVAL '1 day'
                 WHERE company_id IN ($1, $2)`,
                [companyA, companyB]
            );
            const usageDate = new Date().toISOString().slice(0, 10);
            await client.query(
                `INSERT INTO app_builder_usage_counters
                    (company_id, usage_date, generations_used)
                 VALUES ($1, $3, 7), ($2, $3, 7)`,
                [companyA, companyB, usageDate]
            );

            let savepointOpen = false;
            const transactionalClient = {
                query: async (text, params) => {
                    if (text === 'BEGIN') {
                        savepointOpen = true;
                        return client.query('SAVEPOINT app_builder_repository');
                    }
                    if (text === 'COMMIT') {
                        savepointOpen = false;
                        return client.query('RELEASE SAVEPOINT app_builder_repository');
                    }
                    if (text === 'ROLLBACK') {
                        if (!savepointOpen) return undefined;
                        savepointOpen = false;
                        return client.query('ROLLBACK TO SAVEPOINT app_builder_repository');
                    }
                    return client.query(text, params);
                },
                release: jest.fn(),
            };
            connectSpy = jest.spyOn(db, 'getClient').mockResolvedValue(transactionalClient);
            querySpy = jest.spyOn(db, 'query').mockImplementation(
                (text, params) => client.query(text, params)
            );
            const beforeB = await snapshotCompany(client, companyB);
            await expect(repository.reserveDailyGeneration(companyA, 50))
                .resolves.toMatchObject({ generations_used: 8 });
            await expect(repository.reserveDailyGeneration(companyA, 8)).resolves.toBeNull();

            const ownChats = await repository.listChats(companyA);
            expect(ownChats.map(chat => String(chat.app_id))).toEqual([String(appA)]);
            const ownMessages = await repository.getMessages(companyA, fixtureA.chatId);
            expect(ownMessages.messages).toHaveLength(1);
            const ownVersions = await repository.listVersions(companyA, appA);
            expect(ownVersions.versions).toHaveLength(1);
            expect(ownVersions.versions[0]).not.toHaveProperty('source_code');

            await expect(repository.getMessages(companyA, fixtureB.chatId))
                .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            await expect(repository.listVersions(companyA, appB))
                .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            await expect(repository.createChat(companyA, actorA, {
                appId: appB,
                title: 'Shared Builder Chat',
            })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
            await expect(repository.appendUserMessage(
                companyA,
                actorA,
                fixtureB.chatId,
                'Shared generated description'
            )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

            await expect(repository.deleteExpiredMessages(companyA, {
                now: new Date(),
                batchSize: 100,
            })).resolves.toBe(1);
            const retainedChat = await repository.getMessages(companyA, fixtureA.chatId);
            expect(retainedChat.chat.id).toBe(fixtureA.chatId);
            expect(retainedChat.messages).toHaveLength(0);
            expect(await snapshotCompany(client, companyB)).toStrictEqual(beforeB);

            await expect(repository.listCompaniesWithExpiredMessages({
                now: new Date(),
                batchSize: 100,
            })).resolves.toContain(companyB);
            await expect(repository.deleteExpiredMessages(companyB, {
                now: new Date(),
                batchSize: 100,
            })).resolves.toBe(1);
            const globallyRetainedChat = await repository.getMessages(companyB, fixtureB.chatId);
            expect(globallyRetainedChat.chat.id).toBe(fixtureB.chatId);
            expect(globallyRetainedChat.messages).toHaveLength(0);
            const afterRetentionB = await snapshotCompany(client, companyB);

            await repository.appendUserMessage(
                companyA,
                actorA,
                fixtureA.chatId,
                'Shared generated description'
            );
            const generatedSource = `export async function run(ctx) {
                return ctx.callTool('svc.list_tasks', { limit: 1 });
            }`;
            const generatedSha = crypto.createHash('sha256').update(generatedSource).digest('hex');
            const versionCountBeforeBypass = await client.query(
                `SELECT COUNT(*)::integer AS count
                 FROM app_versions
                 WHERE app_id = $1`,
                [appA]
            );
            await expect(repository.persistSuccess({
                companyId: companyA,
                actorId: actorA,
                chatId: fixtureA.chatId,
                source: generatedSource,
                sourceSha256: generatedSha,
                scannerReport: { parsed: true, tools: ['svc.list_tasks'] },
                tools: ['svc.list_tasks'],
                description: 'Must not persist.',
                model: 'test-model',
                tokenUsage: {},
                newApp: { appKey: 'unused', name: 'Unused', metadata: {} },
            })).rejects.toMatchObject({
                code: 'APP_BUILDER_GATE_ATTESTATION_INVALID', httpStatus: 422,
            });
            await expect(repository.persistSuccess({
                companyId: companyA,
                actorId: actorA,
                chatId: fixtureA.chatId,
                source: generatedSource,
                sourceSha256: '0'.repeat(64),
                scannerReport: { parsed: true, dry_run: { ok: true }, tools: [] },
                tools: [],
                description: 'Must not persist either.',
                model: 'test-model',
                tokenUsage: {},
                newApp: { appKey: 'unused-2', name: 'Unused', metadata: {} },
            })).rejects.toMatchObject({
                code: 'APP_BUILDER_GATE_ATTESTATION_INVALID', httpStatus: 422,
            });
            const versionCountAfterBypass = await client.query(
                `SELECT COUNT(*)::integer AS count
                 FROM app_versions
                 WHERE app_id = $1`,
                [appA]
            );
            expect(versionCountAfterBypass.rows[0].count)
                .toBe(versionCountBeforeBypass.rows[0].count);
            const created = await repository.persistSuccess({
                companyId: companyA,
                actorId: actorA,
                chatId: fixtureA.chatId,
                source: generatedSource,
                sourceSha256: generatedSha,
                scannerReport: { parsed: true, tools: ['svc.list_tasks'], dry_run: { ok: true } },
                tools: ['svc.list_tasks'],
                description: 'Shared generated description',
                model: 'test-model',
                tokenUsage: { total_tokens: 10 },
                newApp: {
                    appKey: `unused-${randomUUID()}`,
                    name: 'Unused',
                    metadata: {},
                },
                requestId: 'req-app-builder-db',
            });
            expect(created).toMatchObject({
                app_id: appA,
                version: { source_sha256: generatedSha, status: 'draft', tools: ['svc.list_tasks'] },
                message: { version_id: created.version.id },
            });
            const audit = await client.query(
                `SELECT details
                 FROM audit_log
                 WHERE company_id = $1
                   AND action = 'app_builder.generation'
                   AND target_id = $2
                 ORDER BY id DESC
                 LIMIT 1`,
                [companyA, fixtureA.chatId]
            );
            expect(audit.rows[0].details).toMatchObject({
                outcome: 'created',
                model: 'test-model',
                version_id: created.version.id,
                token_usage: { total_tokens: 10 },
            });
            expect(JSON.stringify(audit.rows[0].details)).not.toContain(generatedSource);
            const newChat = await repository.createChat(companyA, actorA, {
                appId: null,
                title: 'New app',
            });
            const firstArtifact = await repository.persistSuccess({
                companyId: companyA,
                actorId: actorA,
                chatId: newChat.id,
                source: generatedSource,
                sourceSha256: generatedSha,
                scannerReport: { parsed: true, tools: [], dry_run: { ok: true } },
                tools: [],
                description: 'Creates a private fixture summary.',
                model: 'test-model',
                tokenUsage: { total_tokens: 11 },
                newApp: {
                    appKey: `custom-${randomUUID()}`,
                    name: 'Custom App Fixture',
                    metadata: {
                        app_studio: { generated: true },
                        assistant: {
                            what_it_does: 'Creates a private fixture summary.',
                            prerequisites: [],
                            setup_steps: [],
                            outcome: 'Creates a private fixture summary.',
                            recommend_when: [],
                            gotchas: [],
                        },
                    },
                },
                requestId: 'req-first-artifact',
            });
            const privateApp = await client.query(
                `SELECT app.status, app.app_type, app.metadata->'assistant' AS assistant,
                        owned.company_id
                 FROM marketplace_apps app
                 JOIN app_studio_apps owned
                   ON owned.app_id = app.id
                  AND owned.company_id = $1
                 WHERE app.id = $2
                   AND owned.company_id = $1`,
                [companyA, firstArtifact.app_id]
            );
            expect(privateApp.rows[0]).toMatchObject({
                status: 'draft',
                app_type: 'private',
                company_id: companyA,
                assistant: {
                    what_it_does: 'Creates a private fixture summary.',
                    prerequisites: [],
                    setup_steps: [],
                    outcome: 'Creates a private fixture summary.',
                    recommend_when: [],
                    gotchas: [],
                },
            });
            expect(await snapshotCompany(client, companyB)).toStrictEqual(afterRetentionB);

        } finally {
            querySpy?.mockRestore();
            connectSpy?.mockRestore();
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    });
});
