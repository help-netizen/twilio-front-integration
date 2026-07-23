'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

const mockDbQuery = jest.fn();
const mockGetCallByCallSid = jest.fn();
const mockUpsertCall = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));
jest.mock('../backend/src/db/queries', () => ({
    getCallByCallSid: (...args) => mockGetCallByCallSid(...args),
    upsertCall: (...args) => mockUpsertCall(...args),
    findOrCreateTimeline: jest.fn(),
    upsertTranscript: jest.fn(),
    upsertRecording: jest.fn(),
}));
jest.mock('../backend/src/middleware/keycloakAuth', () => ({
    authenticate: (req, _res, next) => {
        req.user = { sub: 'sse-test-user' };
        next();
    },
    requireCompanyAccess: (req, res, next) => {
        const companyId = req.headers['x-company-id'] || null;
        if (!companyId) {
            return res.status(403).json({ code: 'TENANT_CONTEXT_REQUIRED' });
        }
        req.companyFilter = { company_id: companyId };
        return next();
    },
}));
jest.mock('../backend/src/middleware/authorization', () => ({
    requirePermission: () => (_req, _res, next) => next(),
}));

const realtimeService = require('../backend/src/services/realtimeService');
const eventsRouter = require('../backend/src/routes/events');
const vapiCallTimelineService = require('../backend/src/services/vapiCallTimelineService');

function fakeConnection(companyId) {
    const req = new EventEmitter();
    req.ip = '127.0.0.1';
    req.connection = { remoteAddress: '127.0.0.1' };
    if (companyId) req.companyFilter = { company_id: companyId };
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

function bytes(connection) {
    return connection.res.chunks.join('');
}

function connectPair() {
    const a = fakeConnection(COMPANY_A);
    const b = fakeConnection(COMPANY_B);
    realtimeService.addClient(a.req, a.res);
    realtimeService.addClient(b.req, b.res);
    return { a, b };
}

function makeApp() {
    const app = express();
    app.use('/events', eventsRouter);
    return app;
}

function listJavaScriptFiles(root) {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(root, entry.name);
        return entry.isDirectory() ? listJavaScriptFiles(absolute) : (
            entry.isFile() && entry.name.endsWith('.js') ? [absolute] : []
        );
    });
}

function readBalancedCall(source, start, token) {
    const open = start + token.length - 1;
    let parens = 1;
    let braces = 0;
    let brackets = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    const commas = [];

    for (let index = open + 1; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];
        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '/' && next === '/') {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') {
            quote = char;
            continue;
        }
        if (char === '(') parens += 1;
        else if (char === ')') {
            parens -= 1;
            if (parens === 0) {
                const boundaries = [open + 1, ...commas.map((position) => position + 1)];
                const ends = [...commas, index];
                return {
                    text: source.slice(start, index + 1),
                    args: boundaries.map((boundary, argIndex) => (
                        source.slice(boundary, ends[argIndex]).trim()
                    )),
                };
            }
        } else if (char === '{') braces += 1;
        else if (char === '}') braces -= 1;
        else if (char === '[') brackets += 1;
        else if (char === ']') brackets -= 1;
        else if (
            char === ','
            && parens === 1
            && braces === 0
            && brackets === 0
        ) {
            commas.push(index);
        }
    }
    throw new Error('Unterminated realtimeService.broadcast call');
}

function directBroadcastProducers() {
    const backendRoot = path.resolve(__dirname, '../backend/src');
    const token = 'realtimeService.broadcast(';
    const producers = [];
    for (const absolute of listJavaScriptFiles(backendRoot)) {
        const source = fs.readFileSync(absolute, 'utf8');
        let cursor = 0;
        while ((cursor = source.indexOf(token, cursor)) !== -1) {
            const call = readBalancedCall(source, cursor, token);
            const line = source.slice(0, cursor).split('\n').length;
            const eventMatch = call.args[0]?.match(/^['"]([^'"]+)['"]$/);
            producers.push({
                file: path.relative(path.resolve(__dirname, '..'), absolute),
                line,
                event: eventMatch?.[1] || '<dynamic>',
                args: call.args,
            });
            cursor += call.text.length;
        }
    }
    return producers.sort((left, right) => (
        left.file.localeCompare(right.file) || left.line - right.line
    ));
}

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbQuery.mockReset();
    mockGetCallByCallSid.mockReset();
    mockUpsertCall.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockUpsertCall.mockResolvedValue({ id: 71 });
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

describe('realtime SSE delivery and isolation', () => {
    test('delivers a scoped call.created frame to the matching company', () => {
        const a = fakeConnection(COMPANY_A);
        realtimeService.addClient(a.req, a.res);
        const connectedBytes = bytes(a);

        expect(realtimeService.broadcast('call.created', {
            company_id: COMPANY_A,
            id: 41,
            call_sid: 'CA-delivery',
        })).toEqual({ sent: 1, failed: 0 });

        const delivered = bytes(a).slice(connectedBytes.length);
        expect(delivered).toContain('event: call.created\n');
        expect(delivered).toContain(`data: ${JSON.stringify({
            company_id: COMPANY_A,
            id: 41,
            call_sid: 'CA-delivery',
        })}\n\n`);
    });

    test('T-blast: company A event writes zero bytes to company B after connected', () => {
        const { a, b } = connectPair();
        const aBefore = bytes(a);
        const bBefore = bytes(b);

        realtimeService.broadcast('call.created', {
            company_id: COMPANY_A,
            call_sid: 'CA-shared-natural-key',
        });

        expect(bytes(a).slice(aBefore.length)).toContain('CA-shared-natural-key');
        expect(bytes(b)).toBe(bBefore);
    });

    test('unscoped broadcasts fail closed, warn, and write zero bytes', () => {
        const { a, b } = connectPair();
        const before = { a: bytes(a), b: bytes(b) };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(realtimeService.broadcast('call.updated', {
            call_sid: 'CA-unscoped',
        })).toEqual({ sent: 0, failed: 0 });

        expect(bytes(a)).toBe(before.a);
        expect(bytes(b)).toBe(before.b);
        expect(warn).toHaveBeenCalledWith('[SSE] Dropped unscoped call.updated event');
    });

    test.each([
        [
            'publishCallUpdate',
            'call.updated',
            () => realtimeService.publishCallUpdate({
                eventType: 'call.updated',
                company_id: COMPANY_A,
                id: 1,
                call_sid: 'CA-update',
            }),
        ],
        [
            'publishCallCreated',
            'call.created',
            () => realtimeService.publishCallCreated({
                company_id: COMPANY_A,
                id: 2,
                call_sid: 'CA-created',
            }),
        ],
        [
            'publishMessageAdded',
            'message.added',
            () => realtimeService.publishMessageAdded(
                { id: 3, company_id: COMPANY_A },
                { id: 30 },
                300
            ),
        ],
        [
            'publishMessageDelivery',
            'message.delivery',
            () => realtimeService.publishMessageDelivery(
                'SM-delivery',
                'delivered',
                null,
                COMPANY_A
            ),
        ],
        [
            'publishConversationUpdate',
            'conversation.updated',
            () => realtimeService.publishConversationUpdate({
                id: 4,
                company_id: COMPANY_A,
            }),
        ],
        [
            'publishJobUpdate',
            'job.updated',
            () => realtimeService.publishJobUpdate({
                id: 5,
                company_id: COMPANY_A,
            }),
        ],
    ])('%s delivers %s only to its company', (_helper, eventType, publish) => {
        const { a, b } = connectPair();
        const aBefore = bytes(a);
        const bBefore = bytes(b);

        publish();

        expect(bytes(a).slice(aBefore.length)).toContain(`event: ${eventType}\n`);
        expect(bytes(b)).toBe(bBefore);
    });
});

describe('SSE subscription tenant guard', () => {
    test('addClient without companyFilter throws before opening or writing a stream', () => {
        const connection = fakeConnection(null);

        expect(() => realtimeService.addClient(connection.req, connection.res))
            .toThrow('SSE company context required');
        expect(connection.res.writeHead).not.toHaveBeenCalled();
        expect(bytes(connection)).toBe('');
    });

    test('GET /events/calls rejects a missing company before addClient', async () => {
        const addClient = jest.spyOn(realtimeService, 'addClient');

        const response = await request(makeApp()).get('/events/calls');

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ code: 'TENANT_CONTEXT_REQUIRED' });
        expect(addClient).not.toHaveBeenCalled();
    });
});

describe('SSE producer scoping audit', () => {
    test('all 22 direct broadcast producers carry a tenant source', () => {
        const producers = directBroadcastProducers();
        expect(producers.map(({ file, event }) => `${file}:${event}`)).toEqual([
            'backend/src/routes/calls.js:contact.read',
            'backend/src/routes/calls.js:contact.unread',
            'backend/src/routes/calls.js:timeline.read',
            'backend/src/routes/calls.js:timeline.unread',
            'backend/src/routes/pulse.js:thread.handled',
            'backend/src/routes/pulse.js:thread.snoozed',
            'backend/src/routes/pulse.js:thread.assigned',
            'backend/src/routes/pulse.js:thread.action_required',
            'backend/src/routes/pulse.js:thread.action_required',
            'backend/src/services/agentPresence.js:agent.status.changed',
            'backend/src/services/callFlowRuntime.js:group.call.voicemail',
            'backend/src/services/callFlowRuntime.js:group.call.queued',
            'backend/src/services/callFlowRuntime.js:group.call.queued',
            'backend/src/services/callFlowRuntime.js:group.call.accepted',
            'backend/src/services/conversationsService.js:thread.action_required',
            'backend/src/services/email/emailTimelineService.js:thread.action_required',
            'backend/src/services/inboxWorker.js:thread.action_required',
            'backend/src/services/mailAgentService.js:thread.action_required',
            'backend/src/services/realtimeTranscriptService.js:transcript.delta',
            'backend/src/services/realtimeTranscriptService.js:transcript.finalized',
            'backend/src/services/replyReadService.js:timeline.read',
            'backend/src/services/snoozeScheduler.js:thread.unsnoozed',
        ]);

        for (const producer of producers) {
            const payload = producer.args[1] || '';
            const hasThirdArgument = producer.args.length >= 3;
            const hasScopedPayload = /\bcompany_id\s*:|\bcompanyId\s*:/.test(payload);
            expect({
                producer: `${producer.file}:${producer.line}:${producer.event}`,
                scoped: hasThirdArgument || hasScopedPayload,
            }).toEqual({
                producer: `${producer.file}:${producer.line}:${producer.event}`,
                scoped: true,
            });
        }
    });
});

describe('real call-status producer smoke', () => {
    test('VAPI applyStatusUpdate publishes the attempt company to A and never B', async () => {
        const { a, b } = connectPair();
        const aBefore = bytes(a);
        const bBefore = bytes(b);
        mockGetCallByCallSid.mockImplementation(async (callSid, companyId) => ({
            id: 71,
            company_id: companyId,
            call_sid: callSid,
            direction: 'outbound',
            from_number: '+16175550100',
            to_number: '+16175550101',
            status: 'in-progress',
            is_final: false,
        }));

        await expect(vapiCallTimelineService.applyStatusUpdate({
            attempt: {
                company_id: COMPANY_A,
                vapi_call_id: 'vapi-sse-smoke',
                phone: '+16175550101',
            },
            message: {
                type: 'status-update',
                status: 'in-progress',
                call: {
                    id: 'vapi-sse-smoke',
                    phoneCallProviderId: 'CA-sse-smoke',
                },
            },
        })).resolves.toBe('CA-sse-smoke');

        expect(mockGetCallByCallSid).toHaveBeenCalledWith(
            'CA-sse-smoke',
            COMPANY_A
        );
        const delivered = bytes(a).slice(aBefore.length);
        expect(delivered).toContain('event: call.updated\n');
        expect(delivered).toContain('CA-sse-smoke');
        expect(delivered).toContain(COMPANY_A);
        expect(bytes(b)).toBe(bBefore);
    });
});
