'use strict';

const KIND_RANK = Object.freeze({
    call: 0,
    sms: 1,
    email: 2,
    estimate: 3,
    invoice: 4,
});

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID_RE = /^[0-9a-fA-F-]{1,40}$/;
const DIGIT_ID_RE = /^\d+$/;

class InvalidCursorError extends Error {
    constructor() {
        super('Invalid cursor');
        this.name = 'InvalidCursorError';
        this.code = 'INVALID_CURSOR';
    }
}

function encodeCursor({ ts, k, id }) {
    return Buffer.from(JSON.stringify({ v: 1, ts, k, id }), 'utf8').toString('base64url');
}

function parseCursor(str) {
    if (typeof str !== 'string' || str.length === 0 || !BASE64URL_RE.test(str)) {
        throw new InvalidCursorError();
    }

    let parsed;
    try {
        const decoded = Buffer.from(str, 'base64url');
        if (decoded.toString('base64url') !== str) {
            throw new InvalidCursorError();
        }
        parsed = JSON.parse(decoded.toString('utf8'));
    } catch (error) {
        if (error?.code === 'INVALID_CURSOR') throw error;
        throw new InvalidCursorError();
    }

    if (
        parsed === null
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || parsed.v !== 1
        || !Number.isInteger(parsed.k)
        || parsed.k < 0
        || parsed.k > 4
        || typeof parsed.ts !== 'string'
        || !TIMESTAMP_RE.test(parsed.ts)
        || typeof parsed.id !== 'string'
        || !CURSOR_ID_RE.test(parsed.id)
    ) {
        throw new InvalidCursorError();
    }

    return { ts: parsed.ts, k: parsed.k, id: parsed.id };
}

function compareIdsDesc(left, right) {
    const leftId = String(left);
    const rightId = String(right);

    if (DIGIT_ID_RE.test(leftId) && DIGIT_ID_RE.test(rightId)) {
        if (leftId.length !== rightId.length) return leftId.length > rightId.length ? -1 : 1;
        if (leftId === rightId) return 0;
        return leftId > rightId ? -1 : 1;
    }

    const normalizedLeft = leftId.toLowerCase();
    const normalizedRight = rightId.toLowerCase();
    if (normalizedLeft === normalizedRight) return 0;
    return normalizedLeft > normalizedRight ? -1 : 1;
}

// Comparator inputs use the internal five-kind string representation.
function compareDesc(a, b) {
    if (a.ts !== b.ts) return a.ts > b.ts ? -1 : 1;

    const rankDifference = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (rankDifference !== 0) return rankDifference < 0 ? -1 : 1;

    return compareIdsDesc(a.id, b.id);
}

function predicateModeFor(kind, cursor) {
    if (cursor === null) return null;

    const rank = KIND_RANK[kind];
    if (rank > cursor.k) return 'lte';
    if (rank === cursor.k) return 'tuple';
    return 'lt';
}

function mergePage(legs, limit, cursor) {
    // Cursor predicates are applied by each source leg before rows reach this module.
    void cursor;

    const merged = legs.flatMap(leg => leg.rows.map(row => ({
        ts: row.ts,
        kind: leg.kind,
        id: String(row.id),
        data: row.data,
    })));
    merged.sort(compareDesc);

    const emitted = merged.slice(0, limit);
    const hasMore = merged.length > emitted.length
        || legs.some(leg => leg.rows.length >= limit);
    const lastEmitted = emitted[emitted.length - 1];

    const items = emitted.map(item => {
        const financial = item.kind === 'estimate' || item.kind === 'invoice';
        return {
            ts: item.ts,
            src: financial ? 'financial' : item.kind,
            id: financial ? `${item.kind}-${item.id}` : item.id,
            data: item.data,
        };
    });

    const nextCursor = hasMore && lastEmitted
        ? encodeCursor({
            ts: lastEmitted.ts,
            k: KIND_RANK[lastEmitted.kind],
            id: lastEmitted.id,
        })
        : null;

    return { items, nextCursor, hasMore };
}

module.exports = {
    KIND_RANK,
    encodeCursor,
    parseCursor,
    compareDesc,
    predicateModeFor,
    mergePage,
};
