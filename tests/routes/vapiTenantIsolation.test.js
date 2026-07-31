'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-0000-0000-000000000001';
const COMPANY_B = '00000000-0000-0000-0000-000000000099';

const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

let state;
const mockDbQuery = jest.fn(async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (text.startsWith('CREATE TABLE IF NOT EXISTS')) return { rows: [] };

    if (text.startsWith('SELECT id, tenant_id, company_id') && text.includes('FROM provider_connections')) {
        const scoped = text.includes('company_id = $1');
        return {
            rows: state.connections
                .filter(row => (scoped ? row.company_id === params[0] : row.tenant_id === params[0]))
                .filter(row => row.provider === 'vapi')
                .map(row => ({ ...row })),
        };
    }

    if (text.startsWith('INSERT INTO provider_connections')) {
        const scoped = text.includes('(id, tenant_id, company_id, provider');
        const row = {
            id: params[0],
            tenant_id: params[1],
            company_id: scoped ? params[1] : null,
            provider: 'vapi',
            environment: params[2],
            status: 'active',
            display_name: params[4],
        };
        state.connections.push(row);
        return { rows: [{ ...row }] };
    }

    if (text.startsWith('UPDATE provider_connections')) {
        const scoped = text.includes('company_id = $4') && text.includes("provider = 'vapi'");
        const row = state.connections.find(item => (
            item.id === params[2]
            && (scoped ? item.company_id === params[3] : item.tenant_id === params[3])
        ));
        if (row) row.status = params[0] || row.status;
        return { rows: row ? [{ ...row }] : [] };
    }

    if (text.startsWith('DELETE FROM provider_connections')) {
        const scoped = text.includes('company_id = $2') && text.includes("provider = 'vapi'");
        const index = state.connections.findIndex(item => (
            item.id === params[0]
            && (scoped ? item.company_id === params[1] : item.tenant_id === params[1])
        ));
        if (index < 0) return { rows: [] };
        const [row] = state.connections.splice(index, 1);
        return { rows: [{ id: row.id }] };
    }

    if (text.startsWith('SELECT resource.*')) {
        const scoped = text.includes('resource.company_id = $1')
            && text.includes('connection.company_id = resource.company_id');
        const rows = state.resources.filter(resource => {
            const connection = state.connections.find(item => item.id === resource.provider_connection_id);
            return connection && connection.provider === 'vapi'
                && (scoped
                    ? resource.company_id === params[0] && connection.company_id === resource.company_id
                    : resource.tenant_id === params[0]);
        });
        return { rows: rows.map(row => ({ ...row })) };
    }

    if (text.startsWith('INSERT INTO vapi_tenant_resources')) {
        const scoped = text.includes('connection.company_id = $2');
        const connection = state.connections.find(item => (
            item.id === params[2]
            && item.provider === 'vapi'
            && (!scoped || item.company_id === params[1])
        ));
        if (!connection) return { rows: [] };
        const row = {
            id: params[0], tenant_id: params[1], company_id: scoped ? params[1] : null,
            provider_connection_id: connection.id, environment: params[3],
            vapi_phone_number_id: params[4], sip_uri: params[5], server_url: params[6],
        };
        state.resources.push(row);
        return { rows: [{ ...row }] };
    }

    if (text.startsWith('SELECT profile.*')) {
        const scoped = text.includes('profile.company_id = $1')
            && text.includes('connection.company_id = profile.company_id');
        const rows = state.profiles.filter(profile => {
            const connection = state.connections.find(item => item.id === profile.provider_connection_id);
            return profile.is_active && connection && connection.provider === 'vapi'
                && (scoped
                    ? profile.company_id === params[0] && connection.company_id === profile.company_id
                    : profile.tenant_id === params[0]);
        });
        return { rows: rows.map(row => ({ ...row })) };
    }

    if (text.startsWith('INSERT INTO vapi_assistant_profiles')) {
        const scoped = text.includes('connection.company_id = $2');
        const connection = state.connections.find(item => (
            item.id === params[2]
            && item.provider === 'vapi'
            && (!scoped || item.company_id === params[1])
        ));
        if (!connection) return { rows: [] };
        const row = {
            id: params[0], tenant_id: params[1], company_id: scoped ? params[1] : null,
            provider_connection_id: connection.id, slug: params[3], purpose: params[4],
            base_config_json: params[5], vapi_assistant_id: params[6], version: params[7],
            is_active: true,
        };
        state.profiles.push(row);
        return { rows: [{ ...row }] };
    }

    if (text.startsWith('UPDATE vapi_assistant_profiles')) {
        const scoped = text.includes('company_id = $8');
        const row = state.profiles.find(item => (
            item.id === params[6]
            && (scoped ? item.company_id === params[7] : item.tenant_id === params[7])
        ));
        if (row) row.slug = params[0] || row.slug;
        return { rows: row ? [{ ...row }] : [] };
    }

    if (text.startsWith('SELECT * FROM call_flow_node_configs')) {
        const scoped = text.includes('company_id = $1');
        const row = state.nodes.find(item => (
            item.flow_id === params[1]
            && item.node_id === params[2]
            && item.is_active
            && (scoped ? item.company_id === params[0] : item.tenant_id === params[0])
        ));
        return { rows: row ? [{ ...row }] : [] };
    }

    if (text.startsWith('INSERT INTO call_flow_node_configs')) {
        const scoped = text.includes('(id, tenant_id, company_id')
            && text.includes('ON CONFLICT (company_id, flow_id, node_id)');
        const companyId = scoped ? params[1] : null;
        let row = state.nodes.find(item => (
            item.flow_id === params[2]
            && item.node_id === params[3]
            && (scoped ? item.company_id === companyId : item.tenant_id === params[1])
        ));
        if (!row) {
            row = {
                id: params[0], tenant_id: params[1], company_id: companyId,
                flow_id: params[2], node_id: params[3], node_kind: params[4],
                config_json: params[5], version: '1', is_active: true,
            };
            state.nodes.push(row);
        } else {
            row.config_json = params[5];
            row.version = String(Number(row.version) + 1);
        }
        return { rows: [{ ...row }] };
    }

    if (text.startsWith('SELECT run.*')) {
        const scoped = text.includes('run.company_id = $1') && text.includes("run.provider = 'vapi'");
        const rows = state.runs.filter(run => (
            run.provider === 'vapi'
            && (scoped ? run.company_id === params[0] : run.tenant_id === params[0])
        ));
        return { rows: rows.map(row => ({ ...row })) };
    }

    return { rows: [] };
});

jest.mock('../../backend/src/db/connection', () => ({ query: (...args) => mockDbQuery(...args) }));

const router = require('../../backend/src/routes/vapi');

function makeApp(companyId) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { crmUser: { id: `user-${companyId}` } };
        req.companyFilter = { company_id: companyId };
        req.authz = { permissions: ['tenant.integrations.manage'] };
        next();
    });
    app.use('/api/vapi', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    state = {
        connections: [
            { id: 'conn-b', tenant_id: 'default', company_id: COMPANY_B, provider: 'vapi', environment: 'prod', status: 'active' },
            { id: 'conn-a', tenant_id: 'default', company_id: COMPANY_A, provider: 'vapi', environment: 'prod', status: 'active' },
        ],
        resources: [
            { id: 'res-b', tenant_id: 'default', company_id: COMPANY_B, provider_connection_id: 'conn-b', sip_uri: 'sip:b', environment: 'prod' },
            { id: 'res-a', tenant_id: 'default', company_id: COMPANY_A, provider_connection_id: 'conn-a', sip_uri: 'sip:a', environment: 'prod' },
        ],
        profiles: [
            { id: 'profile-b', tenant_id: 'default', company_id: COMPANY_B, provider_connection_id: 'conn-b', slug: 'b', is_active: true },
            { id: 'profile-a', tenant_id: 'default', company_id: COMPANY_A, provider_connection_id: 'conn-a', slug: 'a', is_active: true },
        ],
        nodes: [
            { id: 'node-b', tenant_id: 'default', company_id: COMPANY_B, flow_id: 'flow-1', node_id: 'node-1', node_kind: 'vapi_agent', config_json: '{"owner":"B"}', version: '1', is_active: true },
            { id: 'node-a', tenant_id: 'default', company_id: COMPANY_A, flow_id: 'flow-1', node_id: 'node-1', node_kind: 'vapi_agent', config_json: '{"owner":"A"}', version: '1', is_active: true },
        ],
        runs: [
            { id: 'run-b', tenant_id: 'default', company_id: COMPANY_B, provider: 'vapi' },
            { id: 'run-a', tenant_id: 'default', company_id: COMPANY_A, provider: 'vapi' },
        ],
    };
});

test('T-own/T-foreign/T-blast: every management read returns only company A records', async () => {
    const beforeB = JSON.parse(JSON.stringify({
        connection: state.connections[0], resource: state.resources[0],
        profile: state.profiles[0], node: state.nodes[0], run: state.runs[0],
    }));
    const app = makeApp(COMPANY_A);

    const [connections, resources, profiles, node, runs] = await Promise.all([
        request(app).get('/api/vapi/connections'),
        request(app).get('/api/vapi/resources'),
        request(app).get('/api/vapi/assistant-profiles'),
        request(app).get('/api/vapi/node-configs/flow-1/node-1'),
        request(app).get('/api/vapi/ai-runs'),
    ]);

    expect(connections.body.data.map(row => row.id)).toEqual(['conn-a']);
    expect(resources.body.data.map(row => row.id)).toEqual(['res-a']);
    expect(profiles.body.data.map(row => row.id)).toEqual(['profile-a']);
    expect(node.body.data).toMatchObject({ id: 'node-a', company_id: COMPANY_A, config: { owner: 'A' } });
    expect(runs.body.data.map(row => row.id)).toEqual(['run-a']);
    expect({
        connection: state.connections[0], resource: state.resources[0],
        profile: state.profiles[0], node: state.nodes[0], run: state.runs[0],
    }).toEqual(beforeB);
});

test('T-foreign/T-blast: company B cannot mutate or attach through ABC Homes IDs', async () => {
    const app = makeApp(COMPANY_B);
    const beforeA = JSON.parse(JSON.stringify({
        connection: state.connections[1], profile: state.profiles[1], resources: state.resources,
    }));

    const connections = await request(app).get('/api/vapi/connections');
    const resources = await request(app).get('/api/vapi/resources');
    const profiles = await request(app).get('/api/vapi/assistant-profiles');
    const node = await request(app).get('/api/vapi/node-configs/flow-1/node-1');
    const runs = await request(app).get('/api/vapi/ai-runs');
    const updateConnection = await request(app).put('/api/vapi/connections/conn-a').send({ status: 'disabled' });
    const deleteConnection = await request(app).delete('/api/vapi/connections/conn-a');
    const createResource = await request(app).post('/api/vapi/resources').send({
        provider_connection_id: 'conn-a', sip_uri: 'sip:cross-company', company_id: COMPANY_A,
    });
    const createProfile = await request(app).post('/api/vapi/assistant-profiles').send({
        provider_connection_id: 'conn-a', slug: 'cross-company', company_id: COMPANY_A,
    });
    const updateProfile = await request(app).put('/api/vapi/assistant-profiles/profile-a').send({ slug: 'overwritten' });

    expect(connections.body.data.map(row => row.id)).toEqual(['conn-b']);
    expect(resources.body.data.map(row => row.id)).toEqual(['res-b']);
    expect(profiles.body.data.map(row => row.id)).toEqual(['profile-b']);
    expect(node.body.data.id).toBe('node-b');
    expect(runs.body.data.map(row => row.id)).toEqual(['run-b']);
    expect([updateConnection.status, deleteConnection.status, createResource.status, createProfile.status, updateProfile.status])
        .toEqual([404, 404, 404, 404, 404]);
    expect({
        connection: state.connections[1], profile: state.profiles[1], resources: state.resources,
    }).toEqual(beforeA);
});

test('T-own: creates and updates remain bound to the authenticated company despite body tenant fields', async () => {
    const app = makeApp(COMPANY_A);
    const connection = await request(app).post('/api/vapi/connections').send({
        api_key: 'secret-key', environment: 'staging', company_id: COMPANY_B, tenant_id: 'default',
    });
    const resource = await request(app).post('/api/vapi/resources').send({
        provider_connection_id: 'conn-a', sip_uri: 'sip:new-a', company_id: COMPANY_B,
    });
    const profile = await request(app).post('/api/vapi/assistant-profiles').send({
        provider_connection_id: 'conn-a', slug: 'new-a', company_id: COMPANY_B,
    });
    const node = await request(app).put('/api/vapi/node-configs/flow-1/node-1').send({
        config: { owner: 'A-updated' }, company_id: COMPANY_B,
    });

    expect(connection.status).toBe(200);
    expect(connection.body.data.company_id).toBe(COMPANY_A);
    expect(JSON.stringify(connection.body)).not.toContain('secret-key');
    expect(resource.body.data).toMatchObject({ company_id: COMPANY_A, provider_connection_id: 'conn-a' });
    expect(profile.body.data).toMatchObject({ company_id: COMPANY_A, provider_connection_id: 'conn-a' });
    expect(node.body.data).toMatchObject({ company_id: COMPANY_A, config: { owner: 'A-updated' } });
    expect(state.nodes.find(row => row.id === 'node-b').config_json).toBe('{"owner":"B"}');
});
