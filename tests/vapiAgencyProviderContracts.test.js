'use strict';

const fs = require('fs');
const path = require('path');

const {
    VapiContractError,
    parseVapiServerMessageJson,
    parseVapiEndOfCallReportJson,
    parseVapiGetCallJson,
    sanitizeVapiServerMessageJson,
} = require('../backend/src/services/vapiProviderContracts');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'vapi-agency');

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function parseFixtureObject(name) {
    return JSON.parse(fixture(name));
}

function expectContractError(fn, code, contractPath) {
    try {
        fn();
        throw new Error('expected parser to reject payload');
    } catch (error) {
        expect(error).toBeInstanceOf(VapiContractError);
        expect(error.code).toBe(code);
        expect(error.path).toBe(contractPath);
    }
}

describe('VAPI-AGENCY-001 T1 — documented server-message contracts', () => {
    test('fixture manifest pins contract version 1 and provenance', () => {
        const manifest = parseFixtureObject('manifest.v1.json');

        expect(manifest.contractVersion).toBe(1);
        expect(manifest.fixtures).toHaveLength(6);
        expect(manifest.fixtures.filter((entry) => entry.live).map((entry) => entry.file))
            .toEqual([
                'get-call.inbound-analysis.production-sanitized.json',
                'get-call.inbound-short.production-sanitized.json',
                'get-call.outbound-live.production-sanitized.json',
            ]);
        expect(manifest.liveEvidence).toEqual(expect.objectContaining({
            serverMessageTypesObserved: ['status-update', 'end-of-call-report'],
            serverMessageBodiesCaptured: false,
            getCallStableMeasurements: 2,
            getCallStableMeasurementSpacingSeconds: 240,
        }));
    });

    test('assistant-request establishes call identity without inventing an assistant', () => {
        const result = parseVapiServerMessageJson(fixture('assistant-request.docs.json'));

        expect(result).toEqual({
            contractVersion: 1,
            kind: 'assistant-request',
            call: {
                id: 'call_fixture_assistant_request',
                orgId: 'org_fixture_platform',
                type: 'inboundPhoneCall',
                status: 'ringing',
                createdAt: '2026-01-04T12:00:00.000Z',
            },
        });
        expect(result.call.assistantId).toBeUndefined();
    });

    test('status-update requires matching, known message and call statuses', () => {
        const result = parseVapiServerMessageJson(fixture('status-update.docs.json'));

        expect(result.kind).toBe('status-update');
        expect(result.status).toBe('in-progress');
        expect(result.call).toMatchObject({
            id: 'call_fixture_status_update',
            orgId: 'org_fixture_platform',
            assistantId: 'assistant_fixture_outbound',
            type: 'webCall',
            status: 'in-progress',
        });
    });

    test('end-of-call-report pins documented call-level cost provisionally', () => {
        const raw = fixture('end-of-call-report.docs-composed.json');
        const result = parseVapiEndOfCallReportJson(
            raw,
        );
        const identity = parseVapiServerMessageJson(
            fixture('end-of-call-report.docs-composed.json'),
        );

        expect(result.kind).toBe('end-of-call-report');
        expect(result.endedReason).toBe('customer-ended-call');
        expect(result.call).toMatchObject({
            id: 'call_fixture_end_of_call_report',
            assistantId: 'assistant_fixture_outbound',
            status: 'ended',
            endedReason: 'customer-ended-call',
        });
        expect(result.cost.supplierTotal).toBe('0.0107');
        expect(result.cost.components.stt).toBe('0.001');
        expect(identity.cost).toBeUndefined();

        const sanitized = sanitizeVapiServerMessageJson(raw);
        expect(sanitized.message.call.cost).toBe('0.0107');
        expect(sanitized.message.call.costBreakdown.analysisCostBreakdown.summary)
            .toBe('0.0001');
        expect(JSON.stringify(sanitized)).not.toMatch(
            /transcript|recording|phoneNumber|messages|artifact/i,
        );
        expect(sanitized.message).not.toHaveProperty('customer');
    });

    test('end-of-call cost placement is fail-closed until a live body proves another shape', () => {
        const payload = parseFixtureObject('end-of-call-report.docs-composed.json');
        payload.message.cost = payload.message.call.cost;
        payload.message.costBreakdown = payload.message.call.costBreakdown;
        delete payload.message.call.cost;
        delete payload.message.call.costBreakdown;

        expectContractError(
            () => parseVapiEndOfCallReportJson(JSON.stringify(payload)),
            'required_object',
            '$.message.call.costBreakdown',
        );
        const sanitized = sanitizeVapiServerMessageJson(JSON.stringify(payload));
        expect(sanitized.message.cost).toBe('0.0107');
        expect(sanitized.message.call.cost).toBeUndefined();
    });

    test('unknown additional fields are tolerated at every envelope level', () => {
        const payload = parseFixtureObject('status-update.docs.json');
        payload.providerEnvelopeVersion = 'future-v2';
        payload.message.futureMessageField = { enabled: true };
        payload.message.call.futureCallField = ['new', 'data'];

        expect(parseVapiServerMessageJson(JSON.stringify(payload))).toMatchObject({
            kind: 'status-update',
            status: 'in-progress',
        });
    });

    test.each([
        ['message envelope', {}, 'required_object', '$.message'],
        [
            'message type',
            { message: { call: {} } },
            'required_string',
            '$.message.type',
        ],
        [
            'call id',
            {
                message: {
                    type: 'assistant-request',
                    call: { orgId: 'org', type: 'webCall' },
                },
            },
            'required_string',
            '$.message.call.id',
        ],
    ])('fail-closed when required %s is absent', (_label, payload, code, contractPath) => {
        expectContractError(
            () => parseVapiServerMessageJson(JSON.stringify(payload)),
            code,
            contractPath,
        );
    });

    test.each([
        ['new-message-type', '$.message.type'],
        ['conversation-update', '$.message.type'],
    ])('fail-closed on unsupported message type %s', (type, contractPath) => {
        const payload = parseFixtureObject('status-update.docs.json');
        payload.message.type = type;

        expectContractError(
            () => parseVapiServerMessageJson(JSON.stringify(payload)),
            'unknown_value',
            contractPath,
        );
    });

    test('fail-closed on an unknown lifecycle status', () => {
        const payload = parseFixtureObject('status-update.docs.json');
        payload.message.status = 'provider-added-state';
        payload.message.call.status = 'provider-added-state';

        expectContractError(
            () => parseVapiServerMessageJson(JSON.stringify(payload)),
            'unknown_value',
            '$.message.status',
        );
    });

    test('fail-closed when envelope and call lifecycle status disagree', () => {
        const payload = parseFixtureObject('status-update.docs.json');
        payload.message.call.status = 'ringing';

        expectContractError(
            () => parseVapiServerMessageJson(JSON.stringify(payload)),
            'status_mismatch',
            '$.message.call.status',
        );
    });

    test('fail-closed on an unknown call type', () => {
        const payload = parseFixtureObject('assistant-request.docs.json');
        payload.message.call.type = 'provider-added-call-type';

        expectContractError(
            () => parseVapiServerMessageJson(JSON.stringify(payload)),
            'unknown_value',
            '$.message.call.type',
        );
    });
});

describe('VAPI-AGENCY-001 T1 — production-sanitized GET /call contracts', () => {
    test.each([
        [
            'get-call.inbound-analysis.production-sanitized.json',
            '0.0107',
            '0.001',
            '0.0021',
            '6788',
        ],
        [
            'get-call.inbound-short.production-sanitized.json',
            '0.0003',
            '0.0002',
            '0',
            '0',
        ],
        [
            'get-call.outbound-live.production-sanitized.json',
            '0.0565',
            '0.0052',
            '0.0007',
            '2325',
        ],
    ])(
        'normalizes %s without IEEE-754 arithmetic',
        (name, total, stt, evaluation, evaluationPromptTokens) => {
            const result = parseVapiGetCallJson(fixture(name));

            expect(result.kind).toBe('get-call');
            expect(result.contractVersion).toBe(1);
            expect(result.call).toMatchObject({
                orgId: 'org_fixture_platform',
                status: 'ended',
            });
            expect(result.cost.supplierTotal).toBe(total);
            expect(result.cost.components.stt).toBe(stt);
            expect(result.cost.analysis.costs.successEvaluation).toBe(evaluation);
            expect(result.cost.analysis.tokens.successEvaluationPromptTokens)
                .toBe(evaluationPromptTokens);
        },
    );

    test('live outbound readback has no provider Twilio SID and remains outbound', () => {
        const raw = fixture('get-call.outbound-live.production-sanitized.json');
        const source = JSON.parse(raw);
        const result = parseVapiGetCallJson(raw);

        expect(source).not.toHaveProperty('twilioCallSid');
        expect(result.call).toMatchObject({
            type: 'outboundPhoneCall',
            assistantId: 'assistant_fixture_outbound',
            endedReason: 'silence-timed-out',
            updatedAt: '2026-01-05T05:55:02.208Z',
        });
        expect(result.cost.supplierTotal).toBe('0.0565');
        expect(result.cost.analysis.costs.summary).toBe('0.0002');
    });

    test('call.cost is the only canonical total; components are never summed into it', () => {
        const raw = fixture('get-call.inbound-analysis.production-sanitized.json')
            .replace('"transport": 0,', '"transport": 999.123456789,');

        const result = parseVapiGetCallJson(raw);

        expect(result.cost.supplierTotal).toBe('0.0107');
        expect(result.cost.components.transport).toBe('999.123456789');
    });

    test('preserves a decimal larger and more precise than IEEE-754 can represent', () => {
        const exact = '12345678901234567890.1234567890123456789';
        const raw = fixture('get-call.inbound-analysis.production-sanitized.json')
            .replaceAll('0.0107', exact);

        expect(parseVapiGetCallJson(raw).cost.supplierTotal).toBe(exact);
    });

    test('normalizes provider scientific notation using decimal string operations', () => {
        const raw = fixture('get-call.inbound-short.production-sanitized.json')
            .replaceAll('0.0003', '3e-4');

        expect(parseVapiGetCallJson(raw).cost.supplierTotal).toBe('0.0003');
    });

    test('rejects a quoted money value: the boundary requires a JSON number wire type', () => {
        const raw = fixture('get-call.inbound-short.production-sanitized.json')
            .replace('"cost": 0.0003', '"cost": "0.0003"');

        expectContractError(
            () => parseVapiGetCallJson(raw),
            'required_json_number',
            '$.cost',
        );
    });

    test('rejects negative supplier cost', () => {
        const raw = fixture('get-call.inbound-short.production-sanitized.json')
            .replace('"cost": 0.0003', '"cost": -0.0003');

        expectContractError(
            () => parseVapiGetCallJson(raw),
            'negative_cost',
            '$.cost',
        );
    });

    test('rejects disagreement between call.cost and costBreakdown.total', () => {
        const raw = fixture('get-call.inbound-short.production-sanitized.json')
            .replace('"total": 0.0003', '"total": 0.0004');

        expectContractError(
            () => parseVapiGetCallJson(raw),
            'cost_total_mismatch',
            '$.costBreakdown.total',
        );
    });

    test('rejects missing required typed analysis evidence', () => {
        const payload = parseFixtureObject('get-call.inbound-short.production-sanitized.json');
        delete payload.costBreakdown.analysisCostBreakdown.summary;

        expectContractError(
            () => parseVapiGetCallJson(JSON.stringify(payload)),
            'required_json_number',
            '$.costBreakdown.analysisCostBreakdown.summary',
        );
    });

    test('tolerates unknown extra GET /call and costBreakdown fields', () => {
        const payload = parseFixtureObject('get-call.inbound-short.production-sanitized.json');
        payload.providerAddedObject = { version: 2 };
        payload.costBreakdown.futureCostCategory = 0.00001;

        expect(parseVapiGetCallJson(JSON.stringify(payload)).cost.supplierTotal).toBe('0.0003');
    });

    test('requires the raw provider JSON instead of an already float-coerced object', () => {
        const payload = parseFixtureObject('get-call.inbound-short.production-sanitized.json');

        expectContractError(
            () => parseVapiGetCallJson(payload),
            'raw_json_required',
            '$',
        );
    });

    test('rejects an impossible calendar timestamp', () => {
        const payload = parseFixtureObject('get-call.inbound-short.production-sanitized.json');
        payload.startedAt = '2026-02-31T18:30:00.213Z';

        expectContractError(
            () => parseVapiGetCallJson(JSON.stringify(payload)),
            'invalid_timestamp',
            '$.startedAt',
        );
    });
});
