'use strict';

const EventEmitter = require('events');

const COMPANY_ID = '00000000-0000-4000-8000-00000000000a';
const FORBIDDEN_VALUES = [
    'private message body',
    '+16175550123',
    'Ada Customer',
    '123 Main Street',
    '42.75',
    'private AI summary',
];

const realtimeService = require('../backend/src/services/realtimeService');
const realtimeTranscriptService = require('../backend/src/services/realtimeTranscriptService');
const {
    INVALIDATION_RESOURCES,
    SAFE_COMPANY_EVENTS,
} = require('../backend/src/services/realtimePayloadPolicy');

function fakeConnection(companyId) {
    const req = new EventEmitter();
    req.ip = '127.0.0.1';
    req.connection = { remoteAddress: '127.0.0.1' };
    req.companyFilter = { company_id: companyId };
    const chunks = [];
    const res = {
        writeHead: jest.fn(),
        write: jest.fn((chunk) => {
            chunks.push(String(chunk));
            return true;
        }),
        end: jest.fn(),
        chunks,
    };
    return { req, res };
}

function payloads(connection) {
    return connection.res.chunks
        .map(chunk => chunk.match(/^data: (.*)$/m)?.[1])
        .filter(Boolean)
        .map(value => JSON.parse(value));
}

function poisonPayload(eventType) {
    return {
        company_id: COMPANY_ID,
        eventType,
        id: 'foreign-record-id',
        message: { body: FORBIDDEN_VALUES[0] },
        phone_number: FORBIDDEN_VALUES[1],
        contact: { name: FORBIDDEN_VALUES[2], address: FORBIDDEN_VALUES[3] },
        amount: Number(FORBIDDEN_VALUES[4]),
        ai_summary: FORBIDDEN_VALUES[5],
    };
}

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const connectionId of [...realtimeService.clients.keys()]) {
        realtimeService.removeClient(connectionId);
    }
    jest.restoreAllMocks();
});

afterAll(() => {
    realtimeService.stopKeepAlive();
});

describe('company SSE payload safety', () => {
    test.each(Object.entries(INVALIDATION_RESOURCES))(
        '%s strips all record fields and emits only a PII-free %s invalidation',
        (eventType, resource) => {
            const connection = fakeConnection(COMPANY_ID);
            realtimeService.addClient(connection.req, connection.res);
            connection.res.chunks.length = 0;

            expect(realtimeService.broadcast(eventType, poisonPayload(eventType)))
                .toEqual({ sent: 1, failed: 0 });

            expect(payloads(connection)).toEqual([{
                type: eventType,
                company_id: COMPANY_ID,
                resource,
                invalidate: true,
            }]);
            const wire = connection.res.chunks.join('');
            FORBIDDEN_VALUES.forEach(value => expect(wire).not.toContain(value));
            expect(wire).not.toContain('foreign-record-id');
        }
    );

    test('task.changed preserves only its established company invalidation payload', () => {
        expect(Object.keys(SAFE_COMPANY_EVENTS)).toEqual(['task.changed']);
        const connection = fakeConnection(COMPANY_ID);
        realtimeService.addClient(connection.req, connection.res);
        connection.res.chunks.length = 0;

        realtimeService.broadcast('task.changed', poisonPayload('task.changed'));

        expect(payloads(connection)).toEqual([{ company_id: COMPANY_ID }]);
    });

    test('unregistered company events fail closed instead of forwarding a DTO', () => {
        const connection = fakeConnection(COMPANY_ID);
        realtimeService.addClient(connection.req, connection.res);
        connection.res.chunks.length = 0;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(realtimeService.broadcast('record.full_dto', poisonPayload('record.full_dto')))
            .toEqual({ sent: 0, failed: 0 });

        expect(connection.res.chunks).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            '[SSE] Dropped non-allowlisted record.full_dto event'
        );
    });

    test('realtime transcript sessions fail closed without company context', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(realtimeTranscriptService.createSession('CA-unscoped', {})).toBeNull();
        expect(realtimeTranscriptService.getActiveSessions()).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            '[TranscriptSvc:CA-unscoped] Company context required, skipping'
        );
    });
});
