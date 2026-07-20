const fs = require('fs');
const path = require('path');
const db = require('./connection');

let schemaReady = false;
let schemaReadyPromise = null;

function readMigration(filename) {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', filename), 'utf8');
}

async function ensureMarketplaceSchema(client = null) {
    if (schemaReady) return;

    if (client) {
        const query = queryFor(client);
        await query(`SELECT pg_advisory_xact_lock(hashtext('blanc_marketplace_schema'))`);
        await query(`
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ language 'plpgsql';
        `);
        await query(readMigration('083_create_marketplace_apps.sql'));
        await query(readMigration('087_seed_mail_secretary_marketplace_app.sql'));
        await query(readMigration('088_seed_vapi_ai_marketplace_app.sql'));
        // F018 Stripe Payments: connected accounts, sessions, webhook log + seed app.
        await query(readMigration('113_create_stripe_connected_accounts.sql'));
        await query(readMigration('114_create_stripe_payment_sessions.sql'));
        await query(readMigration('115_create_stripe_webhook_events.sql'));
        await query(readMigration('116_seed_stripe_payments_marketplace_app.sql'));
        // SLOT-ENGINE-001 Phase 2: Smart Slot Engine app (gate-only, no credential).
        await query(readMigration('126_seed_smart_slot_engine_marketplace_app.sql'));
        await query(readMigration('117_create_stripe_terminal_locations.sql'));
        // SEND-DOC-001: Google Email app + repoint mail-secretary's dependency_cta.
        // MUST run AFTER 087 (which re-seeds mail-secretary's old /settings/email path)
        // so this update wins on every schema-ensure, and so google-email self-heals.
        await query(readMigration('132_seed_google_email_marketplace_app.sql'));
        // ONBTEL-001: Telephony — Twilio tile. Derived connection (company_telephony
        // is the source of truth) — no marketplace_installations rows are ever created.
        await query(readMigration('145_seed_telephony_twilio_marketplace_app.sql'));
        // REPAIR-ADVISOR-001: AI Repair Advisor tile (gate-only, no credential) —
        // resolves through the generic install path, like the smart-slot-engine seed.
        await query(readMigration('161_seed_ai_repair_advisor_marketplace_app.sql'));
        // MARKETPLACE-LEADGEN-SPLIT-001: rename lead-generator → "Website Leads"
        // + four per-source lead apps + default-company auto-connect on the
        // SHARED live credential. MUST run AFTER 083 (whose ON CONFLICT DO UPDATE
        // re-asserts the old "Lead Generator" name on every boot — the
        // 132-after-087 precedent). Installation seed = all-statuses NOT EXISTS:
        // boot replays never duplicate rows nor resurrect a disconnected one.
        await query(readMigration('170_split_lead_generator_marketplace_apps.sql'));
        // OUTBOUND-LEAD-CALL-001: Outbound Lead Caller tile (gate-only, no
        // credential; setup page via metadata.setup_path). Boot-replayed AFTER
        // 083 per the ordering rule. The DDL migration is deliberately NOT in
        // this list (schema migration, not a seed).
        await query(readMigration('176_seed_outbound_lead_caller_marketplace_app.sql'));
        // AGENT-CALL-WINDOW-001: separate marketplace identity/settings surface
        // for the parts finish-visit robot. Seed-only; DDL migration 189 stays in
        // the normal migration path.
        await query(readMigration('190_seed_outbound_parts_caller_marketplace_app.sql'));
        // INSPECTOR-AGENT-001: daily stalled-record reviewer. Seed-only; DDL
        // migration 191 stays in the normal migration path. Replay before the
        // assistant repair so the standard description layer remains last.
        await query(readMigration('192_seed_inspector_marketplace_app.sql'));
        // ASSISTANT-BOT-001: restore bot-facing descriptions after app seeds overwrite metadata.
        // MUST run AFTER every app seed above (it patches their metadata).
        await query(readMigration('173_seed_assistant_app_descriptions.sql'));
        return;
    }

    if (!schemaReadyPromise) {
        schemaReadyPromise = (async () => {
            const pooledClient = await db.pool.connect();
            try {
                await pooledClient.query('BEGIN');
                await ensureMarketplaceSchema(pooledClient);
                await pooledClient.query('COMMIT');
                schemaReady = true;
            } catch (err) {
                await pooledClient.query('ROLLBACK');
                schemaReadyPromise = null;
                throw err;
            } finally {
                pooledClient.release();
            }
        })();
    }

    return schemaReadyPromise;
}

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

async function reconcileRevokedInstallations(companyId, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    await query(
        `UPDATE marketplace_installations mi
         SET status = 'revoked',
             disconnected_at = COALESCE(disconnected_at, ai.revoked_at),
             updated_at = NOW()
         FROM api_integrations ai
         WHERE mi.api_integration_id = ai.id
           AND mi.company_id = $1
           AND mi.status IN ('connected', 'provisioning_failed')
           AND ai.revoked_at IS NOT NULL`,
        [companyId]
    );
}

async function listPublishedAppsWithInstallation(companyId, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    await reconcileRevokedInstallations(companyId, client);
    const { rows } = await query(
        `SELECT
            a.id,
            a.app_key,
            a.name,
            a.provider_name,
            a.category,
            a.app_type,
            a.short_description,
            a.long_description,
            a.logo_url,
            a.docs_url,
            a.support_email,
            a.privacy_url,
            a.requested_scopes,
            a.provisioning_mode,
            a.status,
            a.metadata,
            i.id AS installation_id,
            i.status AS installation_status,
            i.installed_at,
            i.disconnected_at,
            i.provisioning_error,
            ai.last_used_at
         FROM marketplace_apps a
         LEFT JOIN LATERAL (
             SELECT *
             FROM marketplace_installations mi
             WHERE mi.app_id = a.id
               AND mi.company_id = $1
             ORDER BY mi.created_at DESC
             LIMIT 1
         ) i ON true
         LEFT JOIN api_integrations ai ON ai.id = i.api_integration_id
         WHERE a.status = 'published'
         ORDER BY a.category ASC, a.name ASC`,
        [companyId]
    );
    return rows;
}

// ASSISTANT-BOT-001 A2: deliberately skips schema setup and revoked-installation
// reconciliation so this company-scoped assistant snapshot is a pure read.
async function getAppConnectionSnapshot(companyId, client = null) {
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT
            a.app_key,
            a.name,
            a.category,
            i.status AS installation_status,
            i.metadata->'settings' AS installation_settings
         FROM marketplace_apps a
         LEFT JOIN LATERAL (
             SELECT mi.status, mi.metadata
             FROM marketplace_installations mi
             WHERE mi.app_id = a.id
               AND mi.company_id = $1
             ORDER BY mi.created_at DESC
             LIMIT 1
         ) i ON true
         WHERE a.status = 'published'
         ORDER BY a.category ASC, a.name ASC`,
        [companyId]
    );
    return rows;
}

async function getPublishedAppByKey(appKey, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT *
         FROM marketplace_apps
         WHERE app_key = $1
           AND status = 'published'
         LIMIT 1`,
        [appKey]
    );
    return rows[0] || null;
}

async function findActiveInstallation(companyId, appId, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    await reconcileRevokedInstallations(companyId, client);
    const { rows } = await query(
        `SELECT i.*, ai.key_id, ai.last_used_at
         FROM marketplace_installations i
         LEFT JOIN api_integrations ai ON ai.id = i.api_integration_id
         WHERE i.company_id = $1
           AND i.app_id = $2
           AND i.status IN ('connected', 'provisioning_failed')
         ORDER BY i.created_at DESC
         LIMIT 1`,
        [companyId, appId]
    );
    return rows[0] || null;
}

// RELY-LEADS-SETTINGS-001 P-14: this ingest hot-path read deliberately skips
// ensureMarketplaceSchema/reconcileRevokedInstallations. A missing table throws
// to the filter's fail-open boundary instead of adding schema work per lead.
async function getConnectedRelySettings(companyId) {
    const { rows } = await db.query(
        `SELECT mi.metadata
         FROM marketplace_installations mi
         JOIN marketplace_apps ma ON ma.id = mi.app_id
         WHERE mi.company_id = $1
           AND ma.app_key = 'rely-leads'
           AND mi.status = 'connected'
         ORDER BY mi.created_at DESC
         LIMIT 1`,
        [companyId]
    );
    return rows[0] || null;
}

async function listInstallations(companyId, includeInactive = false, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    await reconcileRevokedInstallations(companyId, client);
    const inactiveWhere = includeInactive ? '' : `AND i.status IN ('connected', 'provisioning_failed')`;
    const { rows } = await query(
        `SELECT
            i.id,
            i.company_id,
            i.app_id,
            i.api_integration_id,
            i.status,
            i.installed_at,
            i.disconnected_at,
            i.provisioning_error,
            i.external_installation_id,
            a.app_key,
            a.name AS app_name,
            a.provider_name,
            a.category,
            a.requested_scopes,
            ai.key_id,
            ai.revoked_at,
            ai.last_used_at
         FROM marketplace_installations i
         JOIN marketplace_apps a ON a.id = i.app_id
         LEFT JOIN api_integrations ai ON ai.id = i.api_integration_id
         WHERE i.company_id = $1
         ${inactiveWhere}
         ORDER BY i.created_at DESC`,
        [companyId]
    );
    return rows;
}

async function getInstallationById(companyId, installationId, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    await reconcileRevokedInstallations(companyId, client);
    const { rows } = await query(
        `SELECT
            i.*,
            a.app_key,
            a.name AS app_name,
            a.requested_scopes,
            a.provisioning_mode,
            a.provisioning_url,
            a.metadata AS app_metadata,
            ai.key_id,
            ai.revoked_at,
            ai.last_used_at
         FROM marketplace_installations i
         JOIN marketplace_apps a ON a.id = i.app_id
         LEFT JOIN api_integrations ai ON ai.id = i.api_integration_id
         WHERE i.company_id = $1
           AND i.id = $2`,
        [companyId, installationId]
    );
    return rows[0] || null;
}

async function createInstallation({ companyId, appId, actorId, status = 'provisioning_failed' }, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO marketplace_installations
            (company_id, app_id, status, installed_by, installed_at, last_provisioning_attempt_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING *`,
        [companyId, appId, status, actorId || null]
    );
    return rows[0];
}

async function updateInstallationCredential(companyId, installationId, apiIntegrationId, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE marketplace_installations
         SET api_integration_id = $3,
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
         RETURNING *`,
        [companyId, installationId, apiIntegrationId]
    );
    return rows[0] || null;
}

async function setInstallationSettings(companyId, installationId, settingsObject, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE marketplace_installations
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('settings', $3::jsonb),
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
         RETURNING *`,
        [companyId, installationId, JSON.stringify(settingsObject)]
    );
    return rows[0] || null;
}

async function revokeCredentialById(apiIntegrationId, companyId, client = null) {
    if (!apiIntegrationId) return null;
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE api_integrations
         SET revoked_at = COALESCE(revoked_at, NOW()),
             updated_at = NOW()
         WHERE id = $1
           AND company_id = $2
         RETURNING id, key_id, revoked_at`,
        [apiIntegrationId, companyId]
    );
    return rows[0] || null;
}

async function countOtherActiveInstallationsOnCredential(
    companyId,
    apiIntegrationId,
    excludeInstallationId,
    client = null
) {
    if (!apiIntegrationId) return 0;
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `SELECT COUNT(*)::int AS count
         FROM marketplace_installations
         WHERE company_id = $1
           AND api_integration_id = $2
           AND id <> $3
           AND status IN ('connected', 'provisioning_failed')`,
        [companyId, apiIntegrationId, excludeInstallationId]
    );
    return rows[0].count;
}

async function markInstallationConnected({ companyId, installationId, externalInstallationId = null }, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE marketplace_installations
         SET status = 'connected',
             provisioning_error = NULL,
             external_installation_id = COALESCE($3, external_installation_id),
             disconnected_at = NULL,
             disconnected_by = NULL,
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
         RETURNING *`,
        [companyId, installationId, externalInstallationId]
    );
    return rows[0] || null;
}

async function markProvisioningFailed({ companyId, installationId, error }, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE marketplace_installations
         SET status = 'provisioning_failed',
             provisioning_error = $3,
             last_provisioning_attempt_at = NOW(),
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
         RETURNING *`,
        [companyId, installationId, error]
    );
    return rows[0] || null;
}

async function markDisconnected({ companyId, installationId, actorId, status = 'disconnected' }, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `UPDATE marketplace_installations
         SET status = $3,
             disconnected_by = $4,
             disconnected_at = NOW(),
             updated_at = NOW()
         WHERE company_id = $1
           AND id = $2
         RETURNING *`,
        [companyId, installationId, status, actorId || null]
    );
    return rows[0] || null;
}

async function writeEvent({
    companyId,
    installationId = null,
    appId = null,
    apiIntegrationId = null,
    actorId = null,
    eventType,
    requestId = null,
    payload = {},
}, client = null) {
    await ensureMarketplaceSchema(client);
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO marketplace_installation_events
            (company_id, installation_id, app_id, api_integration_id, actor_id, event_type, request_id, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING *`,
        [
            companyId,
            installationId,
            appId,
            apiIntegrationId,
            actorId,
            eventType,
            requestId,
            JSON.stringify(payload || {}),
        ]
    );
    return rows[0];
}

module.exports = {
    ensureMarketplaceSchema,
    reconcileRevokedInstallations,
    listPublishedAppsWithInstallation,
    getAppConnectionSnapshot,
    getPublishedAppByKey,
    findActiveInstallation,
    getConnectedRelySettings,
    listInstallations,
    getInstallationById,
    createInstallation,
    updateInstallationCredential,
    setInstallationSettings,
    revokeCredentialById,
    countOtherActiveInstallationsOnCredential,
    markInstallationConnected,
    markProvisioningFailed,
    markDisconnected,
    writeEvent,
};
