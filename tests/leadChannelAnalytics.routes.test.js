'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn(() => Promise.resolve()),
}));

jest.mock('../backend/src/services/leadChannelAnalyticsService', () => {
    class LeadChannelAnalyticsError extends Error {
        constructor(code, message, httpStatus = 400) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        LeadChannelAnalyticsError,
        getSummary: jest.fn(),
        getGeoPerformance: jest.fn(),
        getBreakdown: jest.fn(),
        getDataQuality: jest.fn(),
    };
});

const analytics = require('../backend/src/services/leadChannelAnalyticsService');
const router = require('../backend/src/routes/leadChannelAnalytics');
const { requirePermission } = require('../backend/src/middleware/authorization');

const COMPANY_ID = '00000000-0000-4000-8000-000000000212';
const POISONED_LEGACY_COMPANY_ID = '00000000-0000-4000-8000-000000000999';

const ROLE_PERMISSIONS = {
    tenant_admin: ['reports.financial.view', 'lead_source.view'],
    manager: ['reports.financial.view', 'lead_source.view'],
    dispatcher: ['lead_source.view'],
    provider: ['reports.financial.view'],
};

const SUMMARY_RESPONSE = {
    kpis: {
        leads: 2,
        converted: 1,
        visit_completed: 1,
        jobs_done: 1,
        revenue_net_cents: 10000,
        call_cost_cents: 124,
        ad_spend_cents: 0,
        roas: null,
        marketing_contribution_cents: 9876,
    },
    funnel: [
        { stage: 'leads', count: 2, conv_pct: 100 },
        { stage: 'converted', count: 1, conv_pct: 50 },
        { stage: 'visit_completed', count: 1, conv_pct: 50 },
        { stage: 'job_is_done', count: 1, conv_pct: 50 },
    ],
    period: {
        from: '2026-07-01',
        to: '2026-07-31',
        timezone: 'America/New_York',
    },
};

const BREAKDOWN_RESPONSE = {
    dimension: 'channel',
    rows: [{
        key: 'source_test',
        label: 'Google Ads',
        leads: 2,
        jobs_done: 1,
        revenue_net_cents: 10000,
        ad_spend_cents: null,
        roas: null,
        marketing_contribution_cents: 9876,
        funnel_counts: {
            leads: 2,
            converted: 1,
            visit_completed: 1,
            jobs_done: 1,
        },
    }],
    totals: {
        leads: 2,
        jobs_done: 1,
        revenue_net_cents: 10000,
        ad_spend_cents: 0,
        roas: null,
        marketing_contribution_cents: 9876,
        funnel_counts: {
            leads: 2,
            converted: 1,
            visit_completed: 1,
            jobs_done: 1,
        },
    },
};

const DATA_QUALITY_RESPONSE = {
    attribution_coverage_pct: 50,
    unallocated_spend_cents: 0,
    tax_basis_unknown_cents: 1234,
    connected_sources: [],
};

const GEO_RESPONSE = {
    period: {
        from: '2026-07-01',
        to: '2026-07-31',
        timezone: 'America/New_York',
    },
    zones: [{ area: 'Downtown', zip_count: 2 }],
    rows: [{
        zip: '02108',
        area: 'Downtown',
        in_configured_area: true,
        geometry: {
            google_place_id: 'place-02108',
            lat: 42.357,
            lon: -71.063,
            status: 'resolved',
        },
        google_lsa: {
            converted_count: 1,
            ad_spend_cents: 400,
            revenue_net_cents: 1200,
            cpa_cents: 400,
            avg_revenue_cents: 1200,
            roas: 3,
            spend_is_modeled: true,
        },
        elocal: {
            converted_count: 0,
            ad_spend_cents: 0,
            revenue_net_cents: 0,
            cpa_cents: null,
            avg_revenue_cents: null,
            roas: null,
            spend_is_modeled: false,
        },
    }],
    quality: {
        unmapped_converted_count: 0,
        unmapped_revenue_net_cents: 0,
        unmapped_spend_cents: 0,
        unallocated_google_lsa_spend_cents: 0,
        centroid_only_zip_count: 0,
        missing_geometry_zip_count: 0,
    },
};

function responseDouble() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function routeHandler(pathname) {
    const layer = router.stack.find(item => item.route?.path === pathname);
    if (!layer) throw new Error(`Missing route handler for ${pathname}`);
    return layer.route.stack[0].handle;
}

async function invokeAs(role, pathname, query) {
    const req = {
        method: 'GET',
        originalUrl: `/api/lead-channel-analytics${pathname}`,
        query,
        user: { crmUser: { id: 'crm-user' } },
        authz: {
            scope: 'tenant',
            permissions: ROLE_PERMISSIONS[role],
        },
        companyFilter: { company_id: COMPANY_ID },
        companyId: POISONED_LEGACY_COMPANY_ID,
    };
    const res = responseDouble();
    const gates = [
        requirePermission('reports.financial.view'),
        requirePermission('lead_source.view'),
    ];

    for (const gate of gates) {
        let allowed = false;
        gate(req, res, () => { allowed = true; });
        if (!allowed) return res;
    }
    await routeHandler(pathname)(req, res);
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
    analytics.getSummary.mockResolvedValue(SUMMARY_RESPONSE);
    analytics.getGeoPerformance.mockResolvedValue(GEO_RESPONSE);
    analytics.getBreakdown.mockResolvedValue(BREAKDOWN_RESPONSE);
    analytics.getDataQuality.mockResolvedValue(DATA_QUALITY_RESPONSE);
});

describe('LEAD-CHANNEL-ANALYTICS-001 route response contracts', () => {
    test('summary returns the exact backend contract and only companyFilter tenant', async () => {
        const response = await invokeAs('tenant_admin', '/summary', {
            from: '2026-07-01',
            to: '2026-07-31',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(SUMMARY_RESPONSE);
        expect(analytics.getSummary).toHaveBeenCalledWith(COMPANY_ID, {
            from: '2026-07-01',
            to: '2026-07-31',
        });
        expect(analytics.getSummary.mock.calls[0]).not.toContain(
            POISONED_LEGACY_COMPANY_ID
        );
    });

    test('breakdown returns the exact backend contract', async () => {
        const response = await invokeAs('manager', '/breakdown', {
            dimension: 'channel',
            from: '2026-07-01',
            to: '2026-07-31',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(BREAKDOWN_RESPONSE);
        expect(analytics.getBreakdown).toHaveBeenCalledWith(COMPANY_ID, {
            dimension: 'channel',
            from: '2026-07-01',
            to: '2026-07-31',
        });
    });

    test('geo returns the exact contract and only companyFilter tenant', async () => {
        const response = await invokeAs('tenant_admin', '/geo', {
            from: '2026-07-01',
            to: '2026-07-31',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(GEO_RESPONSE);
        expect(analytics.getGeoPerformance).toHaveBeenCalledWith(COMPANY_ID, {
            from: '2026-07-01',
            to: '2026-07-31',
        });
        expect(analytics.getGeoPerformance.mock.calls[0]).not.toContain(
            POISONED_LEGACY_COMPANY_ID
        );
    });

    test('data-quality returns the exact backend contract', async () => {
        const response = await invokeAs('manager', '/data-quality', {
            from: '2026-07-01',
            to: '2026-07-31',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(DATA_QUALITY_RESPONSE);
        expect(analytics.getDataQuality).toHaveBeenCalledWith(COMPANY_ID, {
            from: '2026-07-01',
            to: '2026-07-31',
        });
    });

    test('service validation errors use the stable error envelope', async () => {
        analytics.getBreakdown.mockRejectedValueOnce(
            new analytics.LeadChannelAnalyticsError(
                'INVALID_DIMENSION',
                'dimension must be channel, area, or technician'
            )
        );
        const response = await invokeAs('tenant_admin', '/breakdown', {
            dimension: 'campaign',
            from: '2026-07-01',
            to: '2026-07-31',
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toEqual({
            error: {
                code: 'INVALID_DIMENSION',
                message: 'dimension must be channel, area, or technician',
            },
        });
    });
});

describe('LEAD-CHANNEL-ANALYTICS-001 R-matrix', () => {
    const endpoints = [
        ['summary', 'getSummary', '/summary', {}],
        ['geo', 'getGeoPerformance', '/geo', {}],
        ['breakdown', 'getBreakdown', '/breakdown', { dimension: 'area' }],
        ['data-quality', 'getDataQuality', '/data-quality', {}],
    ];

    test.each(endpoints.flatMap(([surface, method, pathname, extraQuery]) => (
        ['tenant_admin', 'manager']
            .map(role => [role, surface, method, pathname, extraQuery])
    )))('%s is allowed on %s', async (
        role,
        _surface,
        method,
        pathname,
        extraQuery
    ) => {
        const response = await invokeAs(role, pathname, {
            from: '2026-07-01',
            to: '2026-07-31',
            ...extraQuery,
        });

        expect(response.statusCode).toBe(200);
        expect(analytics[method]).toHaveBeenCalledTimes(1);
    });

    test.each(endpoints.flatMap(([surface, method, pathname, extraQuery]) => (
        ['dispatcher', 'provider']
            .map(role => [role, surface, method, pathname, extraQuery])
    )))('%s is denied on %s', async (
        role,
        _surface,
        method,
        pathname,
        extraQuery
    ) => {
        const response = await invokeAs(role, pathname, {
            from: '2026-07-01',
            to: '2026-07-31',
            ...extraQuery,
        });

        expect(response.statusCode).toBe(403);
        expect(response.body.code).toBe('ACCESS_DENIED');
        expect(analytics[method]).not.toHaveBeenCalled();
    });
});

describe('LEAD-CHANNEL-ANALYTICS-001 production mount', () => {
    test('mounts behind auth, tenant resolution, and both independent permissions', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'server.js'),
            'utf8'
        );
        expect(source).toContain(
            "const leadChannelAnalyticsRouter = require('../backend/src/routes/leadChannelAnalytics');"
        );
        expect(source).toMatch(
            /app\.use\(\s*'\/api\/lead-channel-analytics',\s*authenticate,\s*requireCompanyAccess,\s*requirePermission\('reports\.financial\.view'\),\s*requirePermission\('lead_source\.view'\),\s*leadChannelAnalyticsRouter\s*\);/
        );
        expect(source).not.toMatch(
            /requirePermission\('reports\.financial\.view',\s*'lead_source\.view'\)/
        );
    });
});
