const db = require('../db/connection');
const marketplaceQueries = require('../db/marketplaceQueries');
const emailQueries = require('../db/emailQueries');
const integrationsService = require('./integrationsService');
const provisioningService = require('./marketplaceProvisioningService');
const emailMailboxService = require('./emailMailboxService');
const telephonyTenantService = require('./telephonyTenantService');

class MarketplaceServiceError extends Error {
    constructor(message, code, httpStatus = 400) {
        super(message);
        this.name = 'MarketplaceServiceError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

// SLOT-ENGINE-001 Phase 2: app_key gate for the Smart Slot Engine integration.
const SMART_SLOT_ENGINE_APP_KEY = 'smart-slot-engine';

// REPAIR-ADVISOR-001: app_key gate for the AI Repair Advisor integration.
// Gate-only (provisioning_mode='none', seed 161) — like smart-slot-engine it
// resolves through the GENERIC marketplace_installations status='connected' path;
// NO isAppConnected special-case (only google-email/telephony-twilio are special).
const AI_REPAIR_ADVISOR_APP_KEY = 'ai-repair-advisor';

// SEND-DOC-001 §4.3: the Google Email marketplace app (seeded with
// provisioning_mode='none' and NO install row) derives its connected state from
// the REAL Gmail mailbox, not a marketplace_installations row. Special-cased in
// listApps + isAppConnected; all other apps are untouched.
const GOOGLE_EMAIL_APP_KEY = 'google-email';

/**
 * Mailbox-derived connected boolean for the Google Email app.
 * Connected ⇔ a Gmail mailbox exists AND its status is 'connected'. Any other
 * status (reconnect_required / sync_error / disconnected) or no mailbox ⇒ false.
 */
async function isGoogleEmailMailboxConnected(companyId) {
    const mailbox = await emailMailboxService.getMailboxStatus(companyId);
    return Boolean(mailbox) && mailbox.provider === 'gmail' && mailbox.status === 'connected';
}

/**
 * Build the SYNTHETIC installation overlay for the Google Email app from the real
 * mailbox. No marketplace_installations row is created or read. Mirrors the
 * installation shape the app-list path returns for other apps (mapAppRow) so the
 * frontend needs no special handling, plus exposes external_installation_id (the
 * connected email) per SEND-DOC-001. Returns null when no mailbox exists.
 */
async function buildGoogleEmailInstallationOverlay(companyId) {
    const mailbox = await emailMailboxService.getMailboxStatus(companyId);
    if (!mailbox) return null;
    const connected = mailbox.provider === 'gmail' && mailbox.status === 'connected';
    return {
        id: null,
        status: connected ? 'connected' : 'disconnected',
        installed_at: connected ? mailbox.created_at || null : null,
        disconnected_at: null,
        provisioning_error: null,
        last_used_at: connected ? mailbox.last_synced_at || null : null,
        external_installation_id: connected ? mailbox.email_address || null : null,
    };
}

// ONBTEL-001 §2.2: the Telephony — Twilio marketplace app (seeded with
// provisioning_mode='none', metadata.derived_connection=true and NO install row
// EVER) derives its connected state from company_telephony via
// telephonyTenantService. Special-cased in listApps + isAppConnected; installApp
// rejects ANY derived_connection app before an installation row is created.
const TELEPHONY_TWILIO_APP_KEY = 'telephony-twilio';

/**
 * Build the SYNTHETIC installation overlay for the Telephony — Twilio app from
 * the company's real telephony state (ONBTEL-001 §2.2). No
 * marketplace_installations row is created or read. Not connected (no
 * company_telephony row, or an autonomous-mode row with a NULL subaccount SID)
 * ⇒ null, so the tile shows Available/Configure. The Twilio subaccount SID is
 * NEVER exposed in any field. getTelephonyState errors bubble up, exactly like
 * the google-email overlay.
 */
async function buildTelephonyTwilioInstallationOverlay(companyId) {
    const state = await telephonyTenantService.getTelephonyState(companyId);
    if (!state.connected) return null;
    return {
        id: null,
        status: 'connected',
        installed_at: state.connected_at ?? null,
        disconnected_at: null,
        provisioning_error: null,
        last_used_at: null,
        external_installation_id: null,
    };
}

/**
 * Whether the given marketplace app is connected (gate-only check) for a company.
 * True iff the app is published AND an active installation exists with status 'connected'.
 */
async function isAppConnected(companyId, appKey) {
    // SEND-DOC-001 §5.10: google-email connected-state comes from the mailbox, not
    // an install row — the mail-secretary gate resolves from truth.
    if (appKey === GOOGLE_EMAIL_APP_KEY) {
        return isGoogleEmailMailboxConnected(companyId);
    }
    // ONBTEL-001 §2.2: telephony-twilio connected-state comes from
    // company_telephony (telephonyTenantService), never an install row — the
    // same derived pattern as google-email above.
    if (appKey === TELEPHONY_TWILIO_APP_KEY) {
        const state = await telephonyTenantService.getTelephonyState(companyId);
        return state.connected === true;
    }
    const app = await marketplaceQueries.getPublishedAppByKey(appKey);
    if (!app) return false;
    const installation = await marketplaceQueries.findActiveInstallation(companyId, app.id);
    return Boolean(installation) && installation.status === 'connected';
}

function toScopeArray(scopes) {
    if (Array.isArray(scopes)) return scopes.map(String);
    if (typeof scopes === 'string') {
        try {
            const parsed = JSON.parse(scopes);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}

function toMetadataObject(metadata) {
    if (!metadata) return {};
    if (typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;
    if (typeof metadata === 'string') {
        try {
            const parsed = JSON.parse(metadata);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

function accessSummary(app) {
    const metadata = toMetadataObject(app.metadata || app.app_metadata);
    if (Array.isArray(metadata.access_summary)) return metadata.access_summary;

    const labels = {
        full_access: 'Full tenant API access',
        'leads:read': 'Read leads',
        'leads:create': 'Create leads',
        'leads:update': 'Update leads',
        'contacts:read': 'Read contacts',
        'contacts:create': 'Create contacts',
        'contacts:update': 'Update contacts',
        'jobs:read': 'Read jobs',
        'jobs:create': 'Create jobs',
        'jobs:update': 'Update jobs',
        'calls:read': 'Read call metadata',
        'calls.transcripts:read': 'Read call transcripts',
        'email:read': 'Read email',
        'email:send': 'Send email',
        'tasks:read': 'Read tasks',
        'tasks:create': 'Create tasks',
        'tasks:update': 'Update tasks',
        'notes:read': 'Read notes',
        'notes:create': 'Create notes',
        'analytics:read': 'Read analytics',
    };

    return toScopeArray(app.requested_scopes).map(scope => labels[scope] || scope);
}

async function validateInstallPrerequisites(app, companyId) {
    const metadata = toMetadataObject(app.metadata || app.app_metadata);
    if (!metadata.requires_connected_gmail) return;

    const mailbox = await emailQueries.getMailboxByCompany(companyId);
    if (!mailbox || mailbox.provider !== 'gmail' || mailbox.status !== 'connected') {
        throw new MarketplaceServiceError(
            'Mail Secretary requires a connected Gmail mailbox. Connect Gmail in Settings > Email, then install this module.',
            'GMAIL_REQUIRED',
            409
        );
    }
}

function mapAppRow(row) {
    const installation = row.installation_id ? {
        id: row.installation_id,
        status: row.installation_status,
        installed_at: row.installed_at,
        disconnected_at: row.disconnected_at,
        provisioning_error: row.provisioning_error,
        last_used_at: row.last_used_at,
    } : null;

    return {
        id: row.id,
        app_key: row.app_key,
        name: row.name,
        provider_name: row.provider_name,
        category: row.category,
        app_type: row.app_type,
        short_description: row.short_description,
        long_description: row.long_description,
        logo_url: row.logo_url,
        docs_url: row.docs_url,
        support_email: row.support_email,
        privacy_url: row.privacy_url,
        requested_scopes: toScopeArray(row.requested_scopes),
        access_summary: accessSummary(row),
        provisioning_mode: row.provisioning_mode,
        status: row.status,
        metadata: row.metadata || {},
        installation,
    };
}

function mapInstallationRow(row) {
    return {
        id: row.id,
        app_key: row.app_key,
        app_name: row.app_name,
        provider_name: row.provider_name,
        category: row.category,
        status: row.status,
        requested_scopes: toScopeArray(row.requested_scopes),
        installed_at: row.installed_at,
        disconnected_at: row.disconnected_at,
        provisioning_error: row.provisioning_error,
        external_installation_id: row.external_installation_id,
        key_id: row.key_id,
        revoked_at: row.revoked_at,
        last_used_at: row.last_used_at,
    };
}

function sanitizeProvisioningError(err) {
    return provisioningService.sanitizeErrorMessage(err?.message || 'Provisioning failed');
}

async function listApps(companyId) {
    const rows = await marketplaceQueries.listPublishedAppsWithInstallation(companyId);
    const apps = rows.map(mapAppRow);

    // SEND-DOC-001 §4.3: overlay the google-email app's installation with a
    // synthetic one derived from the real Gmail mailbox. This OVERRIDES any
    // install-row state mapAppRow produced (a stale row never wins). All other
    // apps are returned exactly as mapAppRow built them.
    const googleEmail = apps.find(app => app.app_key === GOOGLE_EMAIL_APP_KEY);
    if (googleEmail) {
        googleEmail.installation = await buildGoogleEmailInstallationOverlay(companyId);
    }

    // ONBTEL-001 §2.2: same derived-overlay pattern for telephony-twilio — the
    // installation is synthesized from company_telephony (no install row is ever
    // created for this app; a stale row never wins). getTelephonyState errors
    // bubble, exactly like the google-email overlay above.
    const telephonyTwilio = apps.find(app => app.app_key === TELEPHONY_TWILIO_APP_KEY);
    if (telephonyTwilio) {
        telephonyTwilio.installation = await buildTelephonyTwilioInstallationOverlay(companyId);
    }

    return apps;
}

async function listInstallations(companyId, includeInactive = false) {
    const rows = await marketplaceQueries.listInstallations(companyId, includeInactive);
    return rows.map(mapInstallationRow);
}

async function createCredentialForInstallation({ app, companyId, installationId, client }) {
    return integrationsService.createIntegration(
        `Marketplace: ${app.name}`,
        toScopeArray(app.requested_scopes),
        null,
        companyId,
        {
            client,
            marketplaceAppId: app.id,
            marketplaceInstallationId: installationId,
        }
    );
}

async function writeCredentialRevokedEvent({ companyId, installationId, appId, apiIntegrationId, actorId, requestId, reason }, client) {
    if (!apiIntegrationId) return;
    await marketplaceQueries.writeEvent({
        companyId,
        installationId,
        appId,
        apiIntegrationId,
        actorId,
        eventType: 'credential_revoked',
        requestId,
        payload: { reason },
    }, client);
}

async function installApp(companyId, actorId, appKey, { requestId = null, req = null } = {}) {
    let app;
    let installation;
    let credential;

    await marketplaceQueries.ensureMarketplaceSchema();

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        app = await marketplaceQueries.getPublishedAppByKey(appKey, client);
        if (!app) {
            throw new MarketplaceServiceError('Marketplace app not found.', 'APP_NOT_FOUND', 404);
        }

        const active = await marketplaceQueries.findActiveInstallation(companyId, app.id, client);
        if (active) {
            throw new MarketplaceServiceError('App is already installed for this company.', 'APP_ALREADY_INSTALLED', 409);
        }

        // ONBTEL-001 §2.2 fail-safe: apps whose connected-state is DERIVED from
        // their own domain (metadata.derived_connection === true, e.g.
        // telephony-twilio) are never installed through the marketplace — their
        // setup page owns the connect flow. Data-driven (no app_key hardcode),
        // rejected BEFORE any installation row is created.
        const appMetadata = toMetadataObject(app.metadata || app.app_metadata);
        if (appMetadata.derived_connection === true) {
            throw new MarketplaceServiceError(
                'This app is configured from its setup page.',
                'DERIVED_CONNECTION_APP',
                409
            );
        }

        await validateInstallPrerequisites(app, companyId);

        installation = await marketplaceQueries.createInstallation({
            companyId,
            appId: app.id,
            actorId,
            status: 'provisioning_failed',
        }, client);

        if (app.provisioning_mode !== 'none') {
            credential = await createCredentialForInstallation({
                app,
                companyId,
                installationId: installation.id,
                client,
            });

            installation = await marketplaceQueries.updateInstallationCredential(
                companyId,
                installation.id,
                credential.id,
                client
            );
        }

        await marketplaceQueries.writeEvent({
            companyId,
            installationId: installation.id,
            appId: app.id,
            apiIntegrationId: credential?.id || null,
            actorId,
            eventType: 'connect_requested',
            requestId,
            payload: { app_key: app.app_key, scopes: toScopeArray(app.requested_scopes), provisioning_mode: app.provisioning_mode },
        }, client);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        if (err instanceof MarketplaceServiceError) throw err;
        if (err.code === '23505') {
            throw new MarketplaceServiceError('App is already installed for this company.', 'APP_ALREADY_INSTALLED', 409);
        }
        throw err;
    } finally {
        client.release();
    }

    if (app.provisioning_mode === 'push_credentials') {
        try {
            const provisioned = await provisioningService.pushCredentials({
                app,
                installation,
                credential,
                companyId,
                requestId,
                req,
            });

            const doneClient = await db.pool.connect();
            try {
                await doneClient.query('BEGIN');
                installation = await marketplaceQueries.markInstallationConnected({
                    companyId,
                    installationId: installation.id,
                    externalInstallationId: provisioned.external_installation_id,
                }, doneClient);
                await marketplaceQueries.writeEvent({
                    companyId,
                    installationId: installation.id,
                    appId: app.id,
                    apiIntegrationId: credential.id,
                    actorId,
                    eventType: 'connected',
                    requestId,
                    payload: { external_installation_id: provisioned.external_installation_id || null },
                }, doneClient);
                await doneClient.query('COMMIT');
            } catch (err) {
                await doneClient.query('ROLLBACK');
                throw err;
            } finally {
                doneClient.release();
            }
        } catch (err) {
            const message = sanitizeProvisioningError(err);
            const failClient = await db.pool.connect();
            try {
                await failClient.query('BEGIN');
                const revoked = await marketplaceQueries.revokeCredentialById(credential.id, companyId, failClient);
                if (revoked) {
                    await writeCredentialRevokedEvent({
                        companyId,
                        installationId: installation.id,
                        appId: app.id,
                        apiIntegrationId: credential.id,
                        actorId,
                        requestId,
                        reason: 'provisioning_failed',
                    }, failClient);
                }
                installation = await marketplaceQueries.markProvisioningFailed({
                    companyId,
                    installationId: installation.id,
                    error: message,
                }, failClient);
                await marketplaceQueries.writeEvent({
                    companyId,
                    installationId: installation.id,
                    appId: app.id,
                    apiIntegrationId: credential.id,
                    actorId,
                    eventType: 'provisioning_failed',
                    requestId,
                    payload: { error: message },
                }, failClient);
                await failClient.query('COMMIT');
            } catch (failErr) {
                await failClient.query('ROLLBACK');
                throw failErr;
            } finally {
                failClient.release();
            }
            throw new MarketplaceServiceError(message, 'PROVISIONING_FAILED', 502);
        }
    } else {
        const doneClient = await db.pool.connect();
        try {
            await doneClient.query('BEGIN');
            installation = await marketplaceQueries.markInstallationConnected({
                companyId,
                installationId: installation.id,
            }, doneClient);
            await marketplaceQueries.writeEvent({
                companyId,
                installationId: installation.id,
                appId: app.id,
                apiIntegrationId: credential?.id || null,
                actorId,
                eventType: 'connected',
                requestId,
                payload: { provisioning_mode: app.provisioning_mode },
            }, doneClient);
            await doneClient.query('COMMIT');
        } catch (err) {
            await doneClient.query('ROLLBACK');
            throw err;
        } finally {
            doneClient.release();
        }
    }

    return mapInstallationRow({
        ...installation,
        app_key: app.app_key,
        app_name: app.name,
        provider_name: app.provider_name,
        category: app.category,
        requested_scopes: app.requested_scopes,
        key_id: credential?.key_id,
        revoked_at: null,
        last_used_at: null,
    });
}

async function disconnectInstallation(companyId, actorId, installationId, { requestId = null } = {}) {
    await marketplaceQueries.ensureMarketplaceSchema();

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const installation = await marketplaceQueries.getInstallationById(companyId, installationId, client);
        if (!installation) {
            throw new MarketplaceServiceError('Installation not found.', 'INSTALLATION_NOT_FOUND', 404);
        }
        if (!['connected', 'provisioning_failed'].includes(installation.status)) {
            throw new MarketplaceServiceError('Installation is not active.', 'INSTALLATION_NOT_ACTIVE', 409);
        }

        const revoked = await marketplaceQueries.revokeCredentialById(installation.api_integration_id, companyId, client);
        if (revoked) {
            await writeCredentialRevokedEvent({
                companyId,
                installationId,
                appId: installation.app_id,
                apiIntegrationId: installation.api_integration_id,
                actorId,
                requestId,
                reason: 'disconnect',
            }, client);
        }
        const updated = await marketplaceQueries.markDisconnected({
            companyId,
            installationId,
            actorId,
            status: !installation.api_integration_id || revoked ? 'disconnected' : 'revoked',
        }, client);

        await marketplaceQueries.writeEvent({
            companyId,
            installationId,
            appId: installation.app_id,
            apiIntegrationId: installation.api_integration_id,
            actorId,
            eventType: 'disconnected',
            requestId,
            payload: { credential_revoked: Boolean(revoked) },
        }, client);

        await client.query('COMMIT');
        return {
            id: updated.id,
            status: updated.status,
            disconnected_at: updated.disconnected_at,
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function retryProvisioning(companyId, actorId, installationId, { requestId = null, req = null } = {}) {
    await marketplaceQueries.ensureMarketplaceSchema();

    const current = await marketplaceQueries.getInstallationById(companyId, installationId);
    if (!current) {
        throw new MarketplaceServiceError('Installation not found.', 'INSTALLATION_NOT_FOUND', 404);
    }
    if (current.status !== 'provisioning_failed' || current.provisioning_mode !== 'push_credentials') {
        throw new MarketplaceServiceError('Installation is not retryable.', 'INSTALLATION_NOT_RETRYABLE', 409);
    }

    const app = await marketplaceQueries.getPublishedAppByKey(current.app_key);
    if (!app) {
        throw new MarketplaceServiceError('Marketplace app not found.', 'APP_NOT_FOUND', 404);
    }

    let credential;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const revoked = await marketplaceQueries.revokeCredentialById(current.api_integration_id, companyId, client);
        if (revoked) {
            await writeCredentialRevokedEvent({
                companyId,
                installationId,
                appId: app.id,
                apiIntegrationId: current.api_integration_id,
                actorId,
                requestId,
                reason: 'retry_provisioning',
            }, client);
        }
        credential = await createCredentialForInstallation({
            app,
            companyId,
            installationId,
            client,
        });
        await marketplaceQueries.updateInstallationCredential(companyId, installationId, credential.id, client);
        await marketplaceQueries.writeEvent({
            companyId,
            installationId,
            appId: app.id,
            apiIntegrationId: credential.id,
            actorId,
            eventType: 'retry_requested',
            requestId,
            payload: { app_key: app.app_key },
        }, client);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    try {
        const provisioned = await provisioningService.pushCredentials({
            app,
            installation: { id: installationId },
            credential,
            companyId,
            requestId,
            req,
        });
        const doneClient = await db.pool.connect();
        try {
            await doneClient.query('BEGIN');
            const updated = await marketplaceQueries.markInstallationConnected({
                companyId,
                installationId,
                externalInstallationId: provisioned.external_installation_id,
            }, doneClient);
            await marketplaceQueries.writeEvent({
                companyId,
                installationId,
                appId: app.id,
                apiIntegrationId: credential.id,
                actorId,
                eventType: 'connected',
                requestId,
                payload: { external_installation_id: provisioned.external_installation_id || null },
            }, doneClient);
            await doneClient.query('COMMIT');
            return mapInstallationRow({
                ...updated,
                app_key: app.app_key,
                app_name: app.name,
                provider_name: app.provider_name,
                category: app.category,
                requested_scopes: app.requested_scopes,
                key_id: credential.key_id,
                revoked_at: null,
                last_used_at: null,
            });
        } catch (err) {
            await doneClient.query('ROLLBACK');
            throw err;
        } finally {
            doneClient.release();
        }
    } catch (err) {
        const message = sanitizeProvisioningError(err);
        const failClient = await db.pool.connect();
        try {
            await failClient.query('BEGIN');
            const revoked = await marketplaceQueries.revokeCredentialById(credential.id, companyId, failClient);
            if (revoked) {
                await writeCredentialRevokedEvent({
                    companyId,
                    installationId,
                    appId: app.id,
                    apiIntegrationId: credential.id,
                    actorId,
                    requestId,
                    reason: 'provisioning_failed',
                }, failClient);
            }
            await marketplaceQueries.markProvisioningFailed({ companyId, installationId, error: message }, failClient);
            await marketplaceQueries.writeEvent({
                companyId,
                installationId,
                appId: app.id,
                apiIntegrationId: credential.id,
                actorId,
                eventType: 'provisioning_failed',
                requestId,
                payload: { error: message },
            }, failClient);
            await failClient.query('COMMIT');
        } catch (failErr) {
            await failClient.query('ROLLBACK');
            throw failErr;
        } finally {
            failClient.release();
        }
        throw new MarketplaceServiceError(message, 'PROVISIONING_FAILED', 502);
    }
}

module.exports = {
    MarketplaceServiceError,
    SMART_SLOT_ENGINE_APP_KEY,
    AI_REPAIR_ADVISOR_APP_KEY,
    isAppConnected,
    listApps,
    listInstallations,
    installApp,
    disconnectInstallation,
    retryProvisioning,
    _toScopeArray: toScopeArray,
    _accessSummary: accessSummary,
};
