'use strict';

const {
    MAX_CURSOR_LENGTH,
    InvalidCursorError,
    InvalidCursorRequestError,
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    timestampCursorExpression,
    bigintCursorExpression,
} = require('../backend/src/utils/listCursor');

const BASE_SCOPE = {
    endpoint: 'jobs',
    company: '41',
    visibility: { mode: 'assigned', provider: '88' },
    filters: { search: 'boiler', status: ['open', 'scheduled'] },
    sort: 'start_date',
    direction: 'desc',
    limit: 50,
};

const FINGERPRINT = createCursorFingerprint(BASE_SCOPE);
const EXPECTED = {
    endpoint: 'jobs',
    sort: 'start_date',
    direction: 'desc',
    fingerprint: FINGERPRINT,
    valueTypes: ['boolean', { type: 'timestamp', nullable: true }, 'bigint'],
};

function payload(overrides = {}) {
    return {
        endpoint: 'jobs',
        sort: 'start_date',
        direction: 'desc',
        fingerprint: FINGERPRINT,
        values: [false, '2026-07-18T14:15:16.123456Z', '900719925474099312345'],
        ...overrides,
    };
}

function rawToken(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function expectInvalidCursor(callback) {
    expect(callback).toThrow(expect.objectContaining({
        name: 'InvalidCursorError',
        code: 'INVALID_CURSOR',
        statusCode: 400,
    }));
}

describe('list cursor codec', () => {
    test('roundtrips an opaque tuple without losing microseconds or Number-unsafe BIGINT text', () => {
        const token = encodeCursor(payload(), EXPECTED);

        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(token).not.toMatch(/[=+/]/);
        expect(decodeCursor(token, EXPECTED)).toEqual({ v: 1, ...payload() });
    });

    test('canonical fingerprints ignore object insertion order', () => {
        const reordered = {
            limit: 50,
            direction: 'desc',
            filters: { status: ['open', 'scheduled'], search: 'boiler' },
            visibility: { provider: '88', mode: 'assigned' },
            company: '41',
            endpoint: 'jobs',
            sort: 'start_date',
        };

        expect(createCursorFingerprint(reordered)).toBe(FINGERPRINT);
        expect(FINGERPRINT).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    test.each([
        ['endpoint', { endpoint: 'payments' }],
        ['company', { company: '42' }],
        ['provider scope', { visibility: { mode: 'all', provider: null } }],
        ['task actor scope', { actor: { id: '99', manager: false } }],
        ['filter', { filters: { search: 'furnace', status: ['open', 'scheduled'] } }],
        ['sort', { sort: 'created_at' }],
        ['direction', { direction: 'asc' }],
        ['page size', { limit: 51 }],
    ])('changing %s changes the query fingerprint', (_label, change) => {
        expect(createCursorFingerprint({ ...BASE_SCOPE, ...change })).not.toBe(FINGERPRINT);
    });

    test('rejects malformed, oversized, unsupported, and non-canonical tokens', () => {
        const validEnvelope = { v: 1, ...payload() };
        const malformed = [
            '',
            null,
            42,
            'not+base64/',
            Buffer.from('not json', 'utf8').toString('base64url'),
            `${rawToken(validEnvelope)}=`,
            'A'.repeat(MAX_CURSOR_LENGTH + 1),
            rawToken([]),
            rawToken({ ...validEnvelope, v: 2 }),
            rawToken({ ...validEnvelope, extra: true }),
            rawToken({ ...validEnvelope, endpoint: 'unknown' }),
            rawToken({ ...validEnvelope, direction: 'sideways' }),
            rawToken({ ...validEnvelope, sort: 'start_date; DROP TABLE jobs' }),
        ];

        for (const token of malformed) expectInvalidCursor(() => decodeCursor(token, EXPECTED));
    });

    test('rejects a cursor reused across endpoint, sort, direction, fingerprint, or tuple shape', () => {
        const token = encodeCursor(payload(), EXPECTED);
        const mismatches = [
            { ...EXPECTED, endpoint: 'leads' },
            { ...EXPECTED, sort: 'created_at' },
            { ...EXPECTED, direction: 'asc' },
            { ...EXPECTED, fingerprint: createCursorFingerprint({ ...BASE_SCOPE, company: '999' }) },
            { ...EXPECTED, valueTypes: ['timestamp', 'bigint'] },
        ];

        for (const mismatch of mismatches) expectInvalidCursor(() => decodeCursor(token, mismatch));
    });

    test('rejects wrong tuple types, invalid dates, and numeric BIGINT values', () => {
        const invalidValues = [
            ['false', '2026-07-18T14:15:16.123456Z', '10'],
            [false, '2026-07-18T14:15:16.123Z', '10'],
            [false, '2026-02-30T14:15:16.123456Z', '10'],
            [false, '2026-07-18T14:15:16.123456+00:00', '10'],
            [false, '2026-07-18T14:15:16.123456Z', 9007199254740992],
            [false, '2026-07-18T14:15:16.123456Z', '01'],
            [false, '2026-07-18T14:15:16.123456Z', '-1'],
        ];

        for (const values of invalidValues) {
            expectInvalidCursor(() => decodeCursor(rawToken({ v: 1, ...payload({ values }) }), EXPECTED));
        }
    });

    test('supports nullable sort values only when their descriptor permits null', () => {
        const token = encodeCursor(payload({ values: [true, null, '44'] }), EXPECTED);
        expect(decodeCursor(token, EXPECTED).values).toEqual([true, null, '44']);

        expectInvalidCursor(() => decodeCursor(token, {
            ...EXPECTED,
            valueTypes: ['boolean', 'timestamp', 'bigint'],
        }));
    });
});

describe('list cursor SQL helpers', () => {
    test('builds an ascending tuple predicate with stable bind order', () => {
        const result = buildKeysetPredicate([
            { expression: 'LOWER(c.last_name)', direction: 'asc', type: 'text' },
            { expression: 'c.id', direction: 'asc', type: 'bigint' },
        ], ['smith', '900719925474099312345'], 4);

        expect(result).toEqual({
            sql: '((LOWER(c.last_name) > $4::text) OR (LOWER(c.last_name) IS NOT DISTINCT FROM $4::text AND c.id > $5::bigint))',
            params: ['smith', '900719925474099312345'],
        });
        expect(result.sql).not.toContain('smith');
        expect(result.sql).not.toContain('900719925474099312345');
    });

    test('builds a descending tuple predicate', () => {
        const result = buildKeysetPredicate([
            { expression: 'l.created_at', direction: 'desc', type: 'timestamp' },
            { expression: 'l.id', direction: 'desc', type: 'bigint' },
        ], ['2026-07-18T14:15:16.000001Z', '19']);

        expect(result.sql).toBe('((l.created_at < $1::timestamptz) OR (l.created_at IS NOT DISTINCT FROM $1::timestamptz AND l.id < $2::bigint))');
        expect(result.params).toEqual(['2026-07-18T14:15:16.000001Z', '19']);
    });

    test('expands null-rank, nullable value, and tie ID without interpolating values', () => {
        const result = buildKeysetPredicate([
            { expression: '(j.start_date IS NULL)', direction: 'asc', type: 'boolean' },
            { expression: 'j.start_date', direction: 'desc', type: 'timestamp', nullable: true },
            { expression: 'j.id', direction: 'desc', type: 'bigint' },
        ], [true, null, '87'], 7);

        expect(result.sql).toBe('(((j.start_date IS NULL) > $7::boolean) OR ((j.start_date IS NULL) IS NOT DISTINCT FROM $7::boolean AND j.start_date < $8::timestamptz) OR ((j.start_date IS NULL) IS NOT DISTINCT FROM $7::boolean AND j.start_date IS NOT DISTINCT FROM $8::timestamptz AND j.id < $9::bigint))');
        expect(result.params).toEqual([true, null, '87']);
    });

    test('emits precision-preserving cursor projection expressions', () => {
        expect(timestampCursorExpression('t.due_at')).toBe(
            'to_char(t.due_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\')',
        );
        expect(bigintCursorExpression('t.id')).toBe('t.id::text');
    });

    test('cursor and offset together fail with typed INVALID_CURSOR_REQUEST', () => {
        expect(() => assertCursorOffsetExclusive('opaque', 0)).toThrow(expect.objectContaining({
            name: 'InvalidCursorRequestError',
            code: 'INVALID_CURSOR_REQUEST',
            statusCode: 400,
        }));
        expect(() => assertCursorOffsetExclusive('', 0)).not.toThrow();
        expect(() => assertCursorOffsetExclusive('opaque', undefined)).not.toThrow();
        expect(new InvalidCursorError()).toBeInstanceOf(Error);
        expect(new InvalidCursorRequestError()).toBeInstanceOf(Error);
    });
});
