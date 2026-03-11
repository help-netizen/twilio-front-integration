/**
 * VAPI Integration API
 *
 * Provider Connections:
 *   GET    /api/vapi/connections           — List tenant connections
 *   POST   /api/vapi/connections           — Create a new connection
 *   PUT    /api/vapi/connections/:id       — Update connection
 *   DELETE /api/vapi/connections/:id       — Delete connection
 *
 * Tenant Resources (SIP Ingress):
 *   GET    /api/vapi/resources             — List SIP ingress resources
 *   POST   /api/vapi/resources             — Register a new SIP ingress
 *
 * Assistant Profiles:
 *   GET    /api/vapi/assistant-profiles    — List profiles
 *   POST   /api/vapi/assistant-profiles    — Create a profile
 *   PUT    /api/vapi/assistant-profiles/:id — Update profile
 *
 * Node Configs:
 *   GET    /api/vapi/node-configs/:flowId/:nodeId — Get node config
 *   PUT    /api/vapi/node-configs/:flowId/:nodeId — Save/update node config
 *
 * AI Runs:
 *   GET    /api/vapi/ai-runs              — List recent AI call runs
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const crypto = require('crypto');

// Default tenant for single-tenant mode
const DEFAULT_TENANT = 'default';

// ─── Ensure tables ───────────────────────────────────────────────────────────
let tablesEnsured = false;
async function ensureTables() {
    if (tablesEnsured) return;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS provider_connections (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                provider TEXT NOT NULL DEFAULT 'vapi',
                environment TEXT NOT NULL DEFAULT 'prod',
                status TEXT NOT NULL DEFAULT 'connecting',
                encrypted_credentials_json TEXT,
                display_name TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS vapi_tenant_resources (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                provider_connection_id TEXT NOT NULL,
                environment TEXT NOT NULL DEFAULT 'prod',
                vapi_phone_number_id TEXT,
                sip_uri TEXT,
                server_url TEXT,
                assistant_request_secret TEXT,
                is_active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS vapi_assistant_profiles (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                provider_connection_id TEXT NOT NULL,
                slug TEXT NOT NULL,
                purpose TEXT,
                base_config_json TEXT,
                vapi_assistant_id TEXT,
                version TEXT NOT NULL DEFAULT '1.0.0',
                is_active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS call_flow_node_configs (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                flow_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                node_kind TEXT NOT NULL DEFAULT 'vapi_agent',
                config_json TEXT NOT NULL DEFAULT '{}',
                version TEXT NOT NULL DEFAULT '1',
                is_active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS call_ai_runs (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                call_id TEXT,
                call_sid TEXT,
                flow_id TEXT,
                node_id TEXT,
                provider TEXT NOT NULL DEFAULT 'vapi',
                provider_connection_id TEXT,
                provider_call_id TEXT,
                provider_assistant_id TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                started_at TIMESTAMPTZ,
                ended_at TIMESTAMPTZ,
                duration_sec INTEGER,
                transcript_ref TEXT,
                summary_ref TEXT,
                recording_ref TEXT,
                dial_call_status TEXT,
                node_output TEXT,
                metadata_json TEXT DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);
        tablesEnsured = true;
        console.log('[Vapi] Tables ensured');
    } catch (err) {
        console.error('[Vapi] Failed to ensure tables:', err.message);
    }
}

function genId(prefix = 'vapi') {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Provider Connections
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/connections', async (req, res) => {
    try {
        await ensureTables();
        const result = await db.query(
            `SELECT id, tenant_id, provider, environment, status, display_name, created_at, updated_at
             FROM provider_connections
             WHERE tenant_id = $1
             ORDER BY created_at DESC`,
            [DEFAULT_TENANT]
        );
        res.json({ ok: true, data: result.rows });
    } catch (err) {
        console.error('[Vapi] GET connections error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch connections' });
    }
});

router.post('/connections', async (req, res) => {
    try {
        await ensureTables();
        const { environment, api_key, display_name } = req.body;

        if (!api_key) {
            return res.status(400).json({ ok: false, error: 'api_key is required' });
        }

        const id = genId('conn');

        // Test the API key by calling Vapi
        let vapiOrgName = '';
        try {
            const fetch = (await import('node-fetch')).default;
            const testResp = await fetch('https://api.vapi.ai/assistant?limit=1', {
                headers: { 'Authorization': `Bearer ${api_key}` }
            });
            if (!testResp.ok) {
                return res.status(400).json({ ok: false, error: 'Invalid Vapi API key' });
            }
            vapiOrgName = 'Verified';
        } catch (fetchErr) {
            console.error('[Vapi] API key test failed:', fetchErr.message);
            return res.status(400).json({ ok: false, error: 'Could not verify API key' });
        }

        await db.query(
            `INSERT INTO provider_connections (id, tenant_id, provider, environment, status, encrypted_credentials_json, display_name)
             VALUES ($1, $2, 'vapi', $3, 'active', $4, $5)`,
            [id, DEFAULT_TENANT, environment || 'prod', JSON.stringify({ api_key }), display_name || `VAPI ${environment || 'prod'}`]
        );

        const result = await db.query('SELECT * FROM provider_connections WHERE id = $1', [id]);
        // Remove credentials from response
        const row = result.rows[0];
        delete row.encrypted_credentials_json;

        res.json({ ok: true, data: row });
    } catch (err) {
        console.error('[Vapi] POST connection error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to create connection' });
    }
});

router.put('/connections/:id', async (req, res) => {
    try {
        await ensureTables();
        const { id } = req.params;
        const { status, display_name } = req.body;

        const result = await db.query(
            `UPDATE provider_connections
             SET status = COALESCE($1, status), display_name = COALESCE($2, display_name)
             WHERE id = $3 AND tenant_id = $4
             RETURNING id, tenant_id, provider, environment, status, display_name, created_at, updated_at`,
            [status, display_name, id, DEFAULT_TENANT]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Connection not found' });
        }

        res.json({ ok: true, data: result.rows[0] });
    } catch (err) {
        console.error('[Vapi] PUT connection error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to update connection' });
    }
});

router.delete('/connections/:id', async (req, res) => {
    try {
        await ensureTables();
        const { id } = req.params;

        const result = await db.query(
            'DELETE FROM provider_connections WHERE id = $1 AND tenant_id = $2 RETURNING id',
            [id, DEFAULT_TENANT]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Connection not found' });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('[Vapi] DELETE connection error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to delete connection' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tenant Resources (SIP Ingress)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/resources', async (req, res) => {
    try {
        await ensureTables();
        const result = await db.query(
            `SELECT * FROM vapi_tenant_resources WHERE tenant_id = $1 ORDER BY created_at DESC`,
            [DEFAULT_TENANT]
        );
        res.json({ ok: true, data: result.rows });
    } catch (err) {
        console.error('[Vapi] GET resources error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch resources' });
    }
});

router.post('/resources', async (req, res) => {
    try {
        await ensureTables();
        const { provider_connection_id, environment, vapi_phone_number_id, sip_uri, server_url } = req.body;

        if (!provider_connection_id || !sip_uri) {
            return res.status(400).json({ ok: false, error: 'provider_connection_id and sip_uri are required' });
        }

        const id = genId('res');
        await db.query(
            `INSERT INTO vapi_tenant_resources (id, tenant_id, provider_connection_id, environment, vapi_phone_number_id, sip_uri, server_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, DEFAULT_TENANT, provider_connection_id, environment || 'prod', vapi_phone_number_id, sip_uri, server_url]
        );

        const result = await db.query('SELECT * FROM vapi_tenant_resources WHERE id = $1', [id]);
        res.json({ ok: true, data: result.rows[0] });
    } catch (err) {
        console.error('[Vapi] POST resource error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to create resource' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Assistant Profiles
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/assistant-profiles', async (req, res) => {
    try {
        await ensureTables();
        const result = await db.query(
            `SELECT * FROM vapi_assistant_profiles WHERE tenant_id = $1 AND is_active = true ORDER BY created_at DESC`,
            [DEFAULT_TENANT]
        );
        res.json({ ok: true, data: result.rows });
    } catch (err) {
        console.error('[Vapi] GET profiles error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch profiles' });
    }
});

router.post('/assistant-profiles', async (req, res) => {
    try {
        await ensureTables();
        const { provider_connection_id, slug, purpose, base_config_json, vapi_assistant_id, version } = req.body;

        if (!provider_connection_id || !slug) {
            return res.status(400).json({ ok: false, error: 'provider_connection_id and slug are required' });
        }

        const id = genId('prof');
        await db.query(
            `INSERT INTO vapi_assistant_profiles (id, tenant_id, provider_connection_id, slug, purpose, base_config_json, vapi_assistant_id, version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, DEFAULT_TENANT, provider_connection_id, slug, purpose, base_config_json || '{}', vapi_assistant_id, version || '1.0.0']
        );

        const result = await db.query('SELECT * FROM vapi_assistant_profiles WHERE id = $1', [id]);
        res.json({ ok: true, data: result.rows[0] });
    } catch (err) {
        console.error('[Vapi] POST profile error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to create profile' });
    }
});

router.put('/assistant-profiles/:id', async (req, res) => {
    try {
        await ensureTables();
        const { id } = req.params;
        const { slug, purpose, base_config_json, vapi_assistant_id, version, is_active } = req.body;

        const result = await db.query(
            `UPDATE vapi_assistant_profiles
             SET slug = COALESCE($1, slug), purpose = COALESCE($2, purpose),
                 base_config_json = COALESCE($3, base_config_json),
                 vapi_assistant_id = COALESCE($4, vapi_assistant_id),
                 version = COALESCE($5, version),
                 is_active = COALESCE($6, is_active)
             WHERE id = $7 AND tenant_id = $8
             RETURNING *`,
            [slug, purpose, base_config_json, vapi_assistant_id, version, is_active, id, DEFAULT_TENANT]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: 'Profile not found' });
        }

        res.json({ ok: true, data: result.rows[0] });
    } catch (err) {
        console.error('[Vapi] PUT profile error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to update profile' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Node Configs
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/node-configs/:flowId/:nodeId', async (req, res) => {
    try {
        await ensureTables();
        const { flowId, nodeId } = req.params;

        const result = await db.query(
            `SELECT * FROM call_flow_node_configs
             WHERE tenant_id = $1 AND flow_id = $2 AND node_id = $3 AND is_active = true`,
            [DEFAULT_TENANT, flowId, nodeId]
        );

        if (result.rows.length === 0) {
            return res.json({ ok: true, data: null });
        }

        const row = result.rows[0];
        row.config = JSON.parse(row.config_json || '{}');
        res.json({ ok: true, data: row });
    } catch (err) {
        console.error('[Vapi] GET node config error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch node config' });
    }
});

router.put('/node-configs/:flowId/:nodeId', async (req, res) => {
    try {
        await ensureTables();
        const { flowId, nodeId } = req.params;
        const { config, node_kind } = req.body;

        const configJson = JSON.stringify(config || {});
        const id = genId('ncfg');

        // Upsert
        const result = await db.query(
            `INSERT INTO call_flow_node_configs (id, tenant_id, flow_id, node_id, node_kind, config_json)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, flow_id, node_id) DO UPDATE
             SET config_json = EXCLUDED.config_json,
                 node_kind = COALESCE(EXCLUDED.node_kind, call_flow_node_configs.node_kind),
                 version = (CAST(call_flow_node_configs.version AS INTEGER) + 1)::TEXT
             RETURNING *`,
            [id, DEFAULT_TENANT, flowId, nodeId, node_kind || 'vapi_agent', configJson]
        );

        const row = result.rows[0];
        row.config = JSON.parse(row.config_json || '{}');
        res.json({ ok: true, data: row });
    } catch (err) {
        console.error('[Vapi] PUT node config error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to save node config' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AI Runs (read-only from frontend)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/ai-runs', async (req, res) => {
    try {
        await ensureTables();
        const limit = parseInt(req.query.limit) || 50;

        const result = await db.query(
            `SELECT * FROM call_ai_runs
             WHERE tenant_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [DEFAULT_TENANT, limit]
        );

        res.json({ ok: true, data: result.rows });
    } catch (err) {
        console.error('[Vapi] GET ai-runs error:', err.message);
        res.status(500).json({ ok: false, error: 'Failed to fetch AI runs' });
    }
});

module.exports = router;
