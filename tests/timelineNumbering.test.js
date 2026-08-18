'use strict';

const fs = require('fs');
const path = require('path');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/queries', () => ({}));
jest.mock('../backend/src/db/conversationsQueries', () => ({}));
jest.mock('../backend/src/db/emailQueries', () => ({}));
jest.mock('../backend/src/services/contactsService', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/pulseMaskingService', () => ({
    getMaskViewer: jest.fn(async () => false),
    redactPulsePayload: jest.fn(payload => payload),
    buildMaskedSmsTargets: jest.fn(() => []),
}));

const db = require('../backend/src/db/connection');
const timelinesQueries = require('../backend/src/db/timelinesQueries');
const pulseRouter = require('../backend/src/routes/pulse');

async function invokeByCode(code, {
    companyId = COMPANY_A,
    permissions = ['pulse.view'],
} = {}) {
    const routeIndex = pulseRouter.stack.findIndex(layer => (
        layer.route?.path === '/timeline/by-code/:code' && layer.route.methods.get
    ));
    if (routeIndex < 0) throw new Error('Timeline by-code route not found');

    const handlers = [];
    for (let index = 0; index <= routeIndex; index++) {
        const layer = pulseRouter.stack[index];
        if (!layer.route) handlers.push(layer.handle);
        if (index === routeIndex) {
            handlers.push(...layer.route.stack.map(routeLayer => routeLayer.handle));
        }
    }

    const req = {
        method: 'GET',
        originalUrl: `/api/pulse/timeline/by-code/${code}`,
        params: { code },
        user: { sub: 'kc-user', crmUser: { id: 'crm-user' } },
        authz: { permissions, scopes: { job_visibility: 'all' } },
    };
    if (companyId) req.companyFilter = { company_id: companyId };
    const res = {
        statusCode: 200,
        body: undefined,
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };

    async function dispatch(index) {
        if (index >= handlers.length) return;
        let nextPromise = null;
        const next = (error) => {
            if (error) throw error;
            nextPromise = dispatch(index + 1);
            return nextPromise;
        };
        await handlers[index](req, res, next);
        if (nextPromise) await nextPromise;
    }
    await dispatch(0);
    return { status: res.statusCode, body: res.body };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('TIMELINE-NUMBERING migration contract', () => {
    const migrationsDir = path.join(__dirname, '..', 'backend', 'db', 'migrations');
    const forward = fs.readFileSync(path.join(migrationsDir, '284_timeline_numbering.sql'), 'utf8');
    const rollback = fs.readFileSync(path.join(migrationsDir, 'rollback_284_timeline_numbering.sql'), 'utf8');

    test('adds only a durable public_code using the existing jobs Feistel key', () => {
        expect(forward).toContain('ALTER TABLE timelines');
        expect(forward).toContain('ADD COLUMN IF NOT EXISTS public_code TEXT');
        expect(forward).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_timelines_public_code');
        expect(forward).toContain("current_setting('app.job_code_feistel_key')::BIGINT");
        expect(forward).toContain('CREATE OR REPLACE FUNCTION timeline_public_code(p_id BIGINT)');
        expect(forward).toContain('CREATE TRIGGER trg_timelines_assign_public_code');
        expect(forward).toContain('NEW.public_code := timeline_public_code(NEW.id)');
        expect(forward).toContain('SET public_code = timeline_public_code(id)');
        expect(forward).not.toMatch(/ALTER TABLE calls/i);
        expect(forward).not.toMatch(/timeline_(?:number|seq)/i);
    });

    test('rollback removes only the additive timeline-code objects', () => {
        expect(rollback).toContain('DROP TRIGGER IF EXISTS trg_timelines_assign_public_code ON timelines');
        expect(rollback).toContain('DROP FUNCTION IF EXISTS timeline_public_code(BIGINT)');
        expect(rollback).toContain('DROP INDEX IF EXISTS uq_timelines_public_code');
        expect(rollback).toContain('DROP COLUMN IF EXISTS public_code');
        expect(rollback).not.toMatch(/ALTER TABLE calls/i);
    });
});

describe('getTimelineByCode(publicCode)', () => {
    test('is deliberately global and returns company_id for caller tenant isolation', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: '77', company_id: COMPANY_A, public_code: 'Tl7Ab' }],
        });

        await expect(timelinesQueries.getTimelineByCode('Tl7Ab')).resolves.toEqual({
            id: '77',
            company_id: COMPANY_A,
            public_code: 'Tl7Ab',
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('SELECT id, company_id, public_code');
        expect(sql).toContain('WHERE public_code = $1');
        expect(sql).not.toContain('company_id = $2');
        expect(params).toEqual(['Tl7Ab']);
    });

    test('returns null for an unknown code', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });

        await expect(timelinesQueries.getTimelineByCode('xxxxx')).resolves.toBeNull();
    });
});

describe('GET /api/pulse/timeline/by-code/:code', () => {
    test('returns the numeric id and public_code for the session company', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: '77', company_id: COMPANY_A, public_code: 'Tl7Ab' }],
        });

        const response = await invokeByCode('Tl7Ab');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            ok: true,
            data: { id: '77', public_code: 'Tl7Ab' },
        });
    });

    test('returns 404 for a cross-tenant code without exposing its id', async () => {
        db.query.mockResolvedValueOnce({
            rows: [{ id: '88', company_id: COMPANY_B, public_code: 'Frn88' }],
        });

        const response = await invokeByCode('Frn88');

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Timeline not found' });
        expect(JSON.stringify(response.body)).not.toContain('88');
    });

    test('fails closed without session company context before the global lookup', async () => {
        const response = await invokeByCode('Tl7Ab', { companyId: null });

        expect(response.status).toBe(403);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('inherits pulse.view and denies before the global lookup', async () => {
        const response = await invokeByCode('Tl7Ab', { permissions: [] });

        expect(response.status).toBe(403);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('the literal by-code route is registered above /timeline/:contactId', () => {
        const paths = pulseRouter.stack
            .filter(layer => layer.route)
            .map(layer => layer.route.path);

        expect(paths.indexOf('/timeline/by-code/:code')).toBeGreaterThanOrEqual(0);
        expect(paths.indexOf('/timeline/by-code/:code'))
            .toBeLessThan(paths.indexOf('/timeline/:contactId'));
    });
});

test('Pulse conversation-list SQL projects timeline_public_code beside timeline_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await timelinesQueries.getUnifiedTimelinePage({
        companyId: COMPANY_A,
        taskContentScope: { canViewAll: true, userId: null },
    });

    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain('tl.id as timeline_id');
    expect(sql).toContain('tl.public_code as timeline_public_code');
});

test('Pulse response mappers expose timeline_public_code on list and detail shapes', () => {
    const callsRoute = fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'src', 'routes', 'calls.js'),
        'utf8'
    );
    const pulseRoute = fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'src', 'routes', 'pulse.js'),
        'utf8'
    );

    expect(callsRoute).toContain('timeline_public_code: c.timeline_public_code || null');
    expect(pulseRoute.match(/timeline_public_code: timeline\?\.public_code \|\| null/g))
        .toHaveLength(2);
});
