'use strict';

/**
 * RELY-LEADS-SETTINGS-001 T3 — ingest hook, server-owned marker, and badge exclusion.
 *
 * Named sabotage controls exercised during implementation:
 * SAB-FILTER-DROP, SAB-NONRELY-FILTERED, SAB-GUARD-STRIP-DROP,
 * SAB-BADGE-PREDICATE-DROP.
 */

const fs = require('fs');
const path = require('path');

const mockCompanyId = '00000000-0000-0000-0000-00000000a301';
const COMPANY = mockCompanyId;
const mockPass = (_req, _res, next) => next();

jest.mock('../backend/src/middleware/integrationsAuth', () => ({
    rejectLegacyAuth: mockPass,
    validateHeaders: mockPass,
    authenticateIntegration: (req, _res, next) => {
        req.integrationCompanyId = mockCompanyId;
        next();
    },
}));
jest.mock('../backend/src/middleware/integrationScopes', () => ({
    requireIntegrationScope: () => mockPass,
}));
jest.mock('../backend/src/middleware/rateLimiter', () => mockPass);

const mockResolveContact = jest.fn();
jest.mock('../backend/src/services/contactDedupeService', () => ({
    resolveContact: mockResolveContact,
}));

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: mockQuery,
    pool: { connect: jest.fn() },
}));

const mockBroadcast = jest.fn();
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: mockBroadcast }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));

const mockResolveTransition = jest.fn();
jest.mock('../backend/src/services/fsmService', () => ({
    resolveTransition: mockResolveTransition,
}));

const mockEvaluateRelyLead = jest.fn();
jest.mock('../backend/src/services/relyLeadFilterService', () => {
    const actual = jest.requireActual('../backend/src/services/relyLeadFilterService');
    return { ...actual, evaluateRelyLead: mockEvaluateRelyLead };
});

const mockCreateLead = jest.fn();
const mockLeadsServiceError = class LeadsServiceError extends Error {};
jest.mock('../backend/src/services/leadsService', () => ({
    createLead: mockCreateLead,
    LeadsServiceError: mockLeadsServiceError,
}));

const express = require('express');
const request = require('supertest');
const router = require('../backend/src/routes/integrations-leads');
const leadsService = jest.requireActual('../backend/src/services/leadsService');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.requestId = 'req-rely-t3';
    next();
});
app.use(router);

function acceptVerdict(error = null) {
    return {
        accepted: true,
        reason: null,
        extracted: { zip: null, unit: null, brand: null },
        active: { zone: false, unit_types: false, brands: false },
        error,
    };
}

function rejectVerdict() {
    return {
        accepted: false,
        reason: 'out_of_area',
        extracted: { zip: '02888', unit: 'Dishwasher', brand: null },
        active: { zone: true, unit_types: true, brands: false },
        error: null,
    };
}

function basePayload(overrides = {}) {
    return {
        FirstName: 'Ada',
        LastName: 'L',
        Phone: '6175551212',
        ...overrides,
    };
}

function relyLogCalls(spy) {
    return spy.mock.calls.filter((call) => call[0] === '[RelyLeadFilter]');
}

function useCreateSqlDispatch(registeredFields = []) {
    mockQuery.mockImplementation(async (sql) => {
        if (/select 1 from leads where uuid/i.test(sql)) return { rows: [] };
        if (/select api_name from lead_custom_fields/i.test(sql)) {
            return { rows: registeredFields.map((api_name) => ({ api_name })) };
        }
        if (/insert into leads/i.test(sql)) {
            return { rows: [{ uuid: 'RL01', serial_id: 4242, id: 77 }] };
        }
        throw new Error(`Unexpected SQL in createLead test: ${sql}`);
    });
}

function findQueryCall(pattern) {
    return mockQuery.mock.calls.find(([sql]) => pattern.test(sql));
}

function metadataFromInsert() {
    const [sql, params] = findQueryCall(/insert into leads/i);
    const columns = sql.match(/INSERT INTO leads \(([^)]+)\)/i)[1]
        .split(',')
        .map((column) => column.trim());
    const metadataIndex = columns.indexOf('metadata');
    return metadataIndex === -1 ? undefined : JSON.parse(params[metadataIndex]);
}

function markerRow() {
    return {
        id: 77,
        uuid: 'RL01',
        serial_id: 4242,
        status: 'Submitted',
        lead_lost: false,
        created_at: null,
        lead_date_time: null,
        lead_end_date_time: null,
        payment_due_date: null,
        metadata: {
            rely_filter: {
                rejected: true,
                reason: 'out_of_area',
                evaluated_at: '2026-07-13T00:00:00.000Z',
                zip: '02888',
                unit: null,
                brand: null,
            },
        },
        team: [],
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockResolveContact.mockResolvedValue({ contact_id: null, status: 'skipped' });
    mockCreateLead.mockResolvedValue({ UUID: 'RL01', SerialId: 4242, ClientId: '77' });
    mockEvaluateRelyLead.mockResolvedValue(acceptVerdict());
    mockQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('Rely integration ingest route', () => {
    test('TC-F1-01 · non-Rely payloads remain byte-identical', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const payloads = [
            basePayload({ JobSource: 'Yelp' }),
            basePayload(),
            basePayload({ JobSource: 'RelyX' }),
        ];

        for (const payload of payloads) {
            const response = await request(app).post('/leads').send(payload);
            expect(response.status).toBe(201);
            expect(response.body).toEqual({
                success: true,
                lead_id: 'RL01',
                serial_id: 4242,
                contact_id: null,
                request_id: 'req-rely-t3',
            });
        }

        expect(mockEvaluateRelyLead).not.toHaveBeenCalled();
        expect(mockCreateLead).toHaveBeenCalledTimes(3);
        for (const call of mockCreateLead.mock.calls) {
            expect(call[1]).toBe(COMPANY);
            expect(call[2]).toBeUndefined();
        }
        expect(relyLogCalls(logSpy)).toHaveLength(0);
    });

    test("TC-F17-02 · ' RELY ' runs the filter with the integration company", async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const payload = basePayload({ JobSource: ' RELY ' });

        const response = await request(app).post('/leads').send(payload);

        expect(response.status).toBe(201);
        expect(mockEvaluateRelyLead).toHaveBeenCalledTimes(1);
        expect(mockEvaluateRelyLead).toHaveBeenCalledWith(
            expect.objectContaining({ JobSource: ' RELY ' }),
            COMPANY
        );
        expect(mockCreateLead.mock.calls[0][2]).toBeUndefined();
        const logs = relyLogCalls(logSpy);
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0][1])).toMatchObject({
            decision: 'accept',
            reason: null,
            company_id: COMPANY,
            lead_uuid: 'RL01',
            serial_id: 4242,
        });
    });

    test('TC-R1-01 · rejection adds the exact server marker without changing the 201 envelope', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        mockEvaluateRelyLead.mockResolvedValue(rejectVerdict());

        const response = await request(app).post('/leads').send(basePayload({
            JobSource: 'Rely',
            PostalCode: '02888',
            Description: 'Issue: Dishwasher',
        }));

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            success: true,
            lead_id: 'RL01',
            serial_id: 4242,
            contact_id: null,
            request_id: 'req-rely-t3',
        });
        expect(mockCreateLead).toHaveBeenCalledTimes(1);
        expect(mockCreateLead.mock.calls[0][2]).toEqual({
            systemMetadata: {
                rely_filter: {
                    rejected: true,
                    reason: 'out_of_area',
                    evaluated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                    zip: '02888',
                    unit: 'Dishwasher',
                    brand: null,
                },
            },
        });
        expect(mockResolveTransition).not.toHaveBeenCalled();
    });

    test('TC-R7-01 · accepted Rely lead has no marker options object', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const response = await request(app).post('/leads').send(basePayload({ JobSource: 'Rely' }));

        expect(response.status).toBe(201);
        expect(mockCreateLead.mock.calls[0][2]).toBeUndefined();
    });

    test('TC-D1-01 · logs exactly once after creation for reject, accept, and fail-open only', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const accept = acceptVerdict();
        const failOpen = acceptVerdict('settings read failed');
        mockEvaluateRelyLead
            .mockResolvedValueOnce(rejectVerdict())
            .mockResolvedValueOnce(accept)
            .mockResolvedValueOnce(failOpen);

        await request(app).post('/leads').send(basePayload({ JobSource: 'Rely' }));
        await request(app).post('/leads').send(basePayload({ JobSource: 'Rely' }));
        await request(app).post('/leads').send(basePayload({ JobSource: 'Rely' }));
        await request(app).post('/leads').send(basePayload({ JobSource: 'Yelp' }));

        const logIndexes = logSpy.mock.calls
            .map((call, index) => call[0] === '[RelyLeadFilter]' ? index : -1)
            .filter((index) => index !== -1);
        const logs = logIndexes.map((index) => JSON.parse(logSpy.mock.calls[index][1]));
        expect(logs).toHaveLength(3);
        expect(logs[0]).toEqual({
            decision: 'reject',
            reason: 'out_of_area',
            extracted: { zip: '02888', unit: 'Dishwasher', brand: null },
            active: { zone: true, unit_types: true, brands: false },
            company_id: COMPANY,
            lead_uuid: 'RL01',
            serial_id: 4242,
        });
        expect(logs[1]).toEqual({
            decision: 'accept',
            reason: null,
            extracted: accept.extracted,
            active: accept.active,
            company_id: COMPANY,
            lead_uuid: 'RL01',
            serial_id: 4242,
        });
        expect(logs[2]).toEqual({
            decision: 'accept',
            reason: null,
            extracted: failOpen.extracted,
            active: failOpen.active,
            fail_open_error: 'settings read failed',
            company_id: COMPANY,
            lead_uuid: 'RL01',
            serial_id: 4242,
        });
        for (let index = 0; index < 3; index++) {
            expect(mockCreateLead.mock.invocationCallOrder[index])
                .toBeLessThan(logSpy.mock.invocationCallOrder[logIndexes[index]]);
        }
    });
});

describe('server-owned rely_filter metadata', () => {
    test('TC-R2-01 · create strips both injection forms and lets the server marker win', async () => {
        useCreateSqlDispatch(['crm_ref', 'rely_filter']);
        const fields = {
            FirstName: 'A',
            Metadata: { rely_filter: { rejected: false }, other_key: 'keep' },
            rely_filter: 'x',
            crm_ref: 'zb-9',
        };

        await leadsService.createLead(fields, COMPANY);
        expect(metadataFromInsert()).toEqual({ other_key: 'keep', crm_ref: 'zb-9' });

        mockQuery.mockClear();
        mockBroadcast.mockClear();
        useCreateSqlDispatch(['crm_ref', 'rely_filter']);
        const serverMarker = {
            rejected: true,
            reason: 'out_of_area',
            evaluated_at: '2026-07-13T00:00:00.000Z',
            zip: '02888',
            unit: null,
            brand: null,
        };
        await leadsService.createLead(fields, COMPANY, {
            systemMetadata: { rely_filter: serverMarker },
        });

        expect(metadataFromInsert()).toEqual({
            other_key: 'keep',
            crm_ref: 'zb-9',
            rely_filter: serverMarker,
        });
        expect(leadsService.RESERVED_METADATA_KEYS).toEqual(['rely_filter']);
        expect(mockQuery.mock.calls.filter(([sql]) => /insert into leads/i.test(sql))).toHaveLength(1);
        expect(mockQuery.mock.calls.filter(([sql]) => /update leads set metadata/i.test(sql))).toHaveLength(0);
    });

    test('TC-R3-01 · update strips injection and preserves the existing server marker', async () => {
        mockQuery.mockImplementation(async (sql) => {
            if (/select api_name from lead_custom_fields/i.test(sql)) {
                return { rows: [{ api_name: 'rely_filter' }, { api_name: 'note' }] };
            }
            if (/select metadata from leads where uuid/i.test(sql)) {
                return {
                    rows: [{
                        metadata: {
                            rely_filter: { rejected: true, reason: 'out_of_area' },
                            note: 'x',
                        },
                    }],
                };
            }
            if (/update leads set/i.test(sql)) return { rows: [{ uuid: 'RL01', id: 77 }] };
            throw new Error(`Unexpected SQL in updateLead test: ${sql}`);
        });

        await leadsService.updateLead('RL01', {
            Comments: 'hi',
            Metadata: { rely_filter: { rejected: false }, note: 'y' },
        }, COMPANY);

        const [, params] = findQueryCall(/update leads set/i);
        const metadataParam = params.find((value) => (
            typeof value === 'string' && value.includes('"rely_filter"')
        ));
        expect(JSON.parse(metadataParam)).toEqual({
            rely_filter: { rejected: true, reason: 'out_of_area' },
            note: 'y',
        });
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'backend', 'src', 'services', 'leadsService.js'),
            'utf8'
        );
        expect(source).toMatch(/async function updateLead\(uuid, fields, companyId = null\)/);
    });

    test('TC-R5-01 · marker-bearing INSERT precedes the unchanged lead.created broadcast', async () => {
        useCreateSqlDispatch([]);
        const serverMarker = {
            rejected: true,
            reason: 'out_of_area',
            evaluated_at: '2026-07-13T00:00:00.000Z',
            zip: '02888',
            unit: null,
            brand: null,
        };

        await leadsService.createLead({ FirstName: 'A' }, COMPANY, {
            systemMetadata: { rely_filter: serverMarker },
        });

        expect(metadataFromInsert().rely_filter).toEqual(serverMarker);
        const insertIndex = mockQuery.mock.calls.findIndex(([sql]) => /insert into leads/i.test(sql));
        expect(mockQuery.mock.calls.filter(([sql]) => /insert into leads/i.test(sql))).toHaveLength(1);
        expect(mockQuery.mock.calls.filter(([sql]) => /update leads set metadata/i.test(sql))).toHaveLength(0);
        expect(mockQuery.mock.invocationCallOrder[insertIndex])
            .toBeLessThan(mockBroadcast.mock.invocationCallOrder[0]);
        expect(mockBroadcast).toHaveBeenCalledWith('lead.created', {
            company_id: COMPANY,
            status: 'Submitted',
            lead_id: '77',
        });
    });
});

describe('rejected lead read/count behavior', () => {
    test('TC-R4-01 · badge SQL excludes only rejected:true and retains the existing parameters', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }] });

        expect(await leadsService.countNewLeads(COMPANY)).toBe(2);

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/company_id\s*=\s*\$1/);
        expect(sql).toMatch(/lead_lost\s*=\s*false/);
        expect(sql).toMatch(/status\s*=\s*ANY/);
        expect(sql).toMatch(/NOT COALESCE\(metadata @> '\{"rely_filter":\{"rejected":true\}\}'::jsonb, false\)/);
        expect(params).toEqual([COMPANY, ['Submitted', 'New', 'Review']]);
    });

    test('TC-R6-01 · list and detail DTOs expose the marker through Metadata and top level', async () => {
        const row = markerRow();
        mockQuery
            .mockResolvedValueOnce({ rows: [{ total: 1 }] })
            .mockResolvedValueOnce({ rows: [{ ...row, __cursor_value: '2026-07-18T12:00:00.000001Z', __cursor_id: '77' }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [row] });

        const listed = await leadsService.listLeads({ companyId: COMPANY });
        const detail = await leadsService.getLeadByUUID('RL01', COMPANY);

        for (const lead of [listed.results[0], detail]) {
            expect(lead.Metadata.rely_filter).toEqual(row.metadata.rely_filter);
            expect(lead.rely_filter).toEqual(row.metadata.rely_filter);
        }
        const [listSql] = mockQuery.mock.calls.find(([sql]) => /SELECT l\.\*, c\.full_name AS contact_name/i.test(sql));
        expect(listSql).toMatch(/l\.company_id\s*=\s*\$1/);
        expect(listSql).toContain("l.status NOT IN ('Lost', 'Converted')");
    });
});
