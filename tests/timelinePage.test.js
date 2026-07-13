'use strict';

/**
 * TIMELINE-REVPAGE-001 T1 — pure cursor, ordering, and merged-page behavior.
 *
 * Covers TC-TRP-001…013 from docs/test-cases/TIMELINE-REVPAGE-001.md.
 */

const {
    KIND_RANK,
    encodeCursor,
    parseCursor,
    compareDesc,
    predicateModeFor,
    mergePage,
} = require('../backend/src/services/timelinePage');

const KINDS = ['call', 'sms', 'email', 'estimate', 'invoice'];
const BASE_TS = '2026-07-12T12:00:00.000001Z';

function uuidFor(index, prefix = '0') {
    return `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function microsecondTs(value) {
    return `2026-07-12T12:00:00.${String(value).padStart(6, '0')}Z`;
}

function makeRow(kind, ts, id, data = { kind, id: String(id) }) {
    return { kind, ts, id: String(id), data };
}

function rowsToLegs(rows, includeEmpty = false) {
    return KINDS
        .map(kind => ({
            kind,
            rows: rows
                .filter(row => row.kind === kind)
                .map(({ ts, id, data }) => ({ ts, id, data })),
        }))
        .filter(leg => includeEmpty || leg.rows.length > 0);
}

function envelopeTriple(item) {
    if (item.src !== 'financial') {
        return { ts: item.ts, kind: item.src, id: item.id };
    }

    const separator = item.id.indexOf('-');
    return {
        ts: item.ts,
        kind: item.id.slice(0, separator),
        id: item.id.slice(separator + 1),
    };
}

function itemKey(item) {
    return `${item.src}:${item.id}`;
}

function expectStrictDesc(items) {
    for (let index = 1; index < items.length; index += 1) {
        expect(compareDesc(envelopeTriple(items[index - 1]), envelopeTriple(items[index]))).toBeLessThan(0);
    }
}

function buildMergeFixture() {
    const rows = [];
    for (let index = 0; index < 35; index += 1) {
        let kind = KINDS[index % KINDS.length];
        let ts;
        let id = kind === 'sms' ? uuidFor(index) : String(100 + index);

        if (index < 19) ts = microsecondTs(999000 - (index * 1000));
        else if (index === 19 || index === 20) ts = microsecondTs(980000);
        else ts = microsecondTs(980000 - ((index - 20) * 1000));

        if (index === 19) {
            kind = 'estimate';
            id = '33';
        } else if (index === 20) {
            kind = 'invoice';
            id = '44';
        }

        rows.push(makeRow(kind, ts, id, { fixtureIndex: index }));
    }
    return rows;
}

function makeSequentialRows(kind, count, start = 900000) {
    return Array.from({ length: count }, (_unused, index) => makeRow(
        kind,
        microsecondTs(start - index),
        kind === 'sms' ? uuidFor(index) : String(1000 + index),
        { index },
    ));
}

function syntheticRows() {
    const tieRanges = [
        [18, 23, 898150],
        [38, 43, 896150],
        [68, 73, 893150],
    ];

    return Array.from({ length: 100 }, (_unused, index) => {
        const kind = KINDS[index % KINDS.length];
        const tie = tieRanges.find(([start, end]) => index >= start && index <= end);
        const microseconds = tie ? tie[2] : 900000 - (index * 100);
        const id = kind === 'sms' ? uuidFor(index) : String(10000 + index);
        return makeRow(kind, microsecondTs(microseconds), id, { token: `${kind}-${index}` });
    });
}

function isAfterCursor(row, cursor) {
    if (cursor === null) return true;

    const mode = predicateModeFor(row.kind, cursor);
    if (mode === 'lt') return row.ts < cursor.ts;
    if (mode === 'lte') return row.ts <= cursor.ts;
    return compareDesc(
        row,
        { ts: cursor.ts, kind: row.kind, id: cursor.id },
    ) > 0;
}

function legsForCursor(rows, limit, cursor) {
    return KINDS.map(kind => ({
        kind,
        rows: rows
            .filter(row => row.kind === kind && isAfterCursor(row, cursor))
            .sort(compareDesc)
            .slice(0, limit)
            .map(({ ts, id, data }) => ({ ts, id, data })),
    }));
}

function walkPages(rows, { limit = 20, sabotageSecondCursor = false } = {}) {
    const pages = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore && pages.length < 20) {
        const effectiveCursor = sabotageSecondCursor && pages.length === 1 ? null : cursor;
        const page = mergePage(
            legsForCursor(rows, limit, effectiveCursor),
            limit,
            effectiveCursor,
        );
        pages.push(page);
        hasMore = page.hasMore;
        cursor = page.nextCursor === null ? null : parseCursor(page.nextCursor);
    }

    return pages;
}

function walkViolations(pages) {
    const violations = [];
    const seen = new Set();

    pages.forEach((page, pageIndex) => {
        page.items.forEach(item => {
            const key = itemKey(item);
            if (seen.has(key)) violations.push(`duplicate:${key}`);
            seen.add(key);
        });

        if (pageIndex === 0 || page.items.length === 0 || pages[pageIndex - 1].items.length === 0) return;
        const previousLast = pages[pageIndex - 1].items.at(-1);
        if (compareDesc(envelopeTriple(previousLast), envelopeTriple(page.items[0])) >= 0) {
            violations.push(`boundary:${pageIndex}`);
        }
    });

    return violations;
}

describe('timelinePage pure cursor and merge contract', () => {
    test('TC-TRP-001: cursor roundtrip preserves digit, uuid, financial, and microsecond values', () => {
        const cursors = [
            { ts: '2026-07-12T18:22:01.123456Z', k: 0, id: '8412' },
            { ts: '2026-07-12T18:22:01.123456Z', k: 1, id: 'b3f0c9a2-1234-4abc-8def-1234567890ab' },
            { ts: '2026-07-12T18:22:01.123456Z', k: 3, id: '33' },
            { ts: '2026-07-12T18:22:01.123456Z', k: 4, id: '44' },
            { ts: '2026-07-12T18:22:01.000210Z', k: 1, id: 'b3f0c9a2-1234-4abc-8def-1234567890ab' },
            { ts: '2026-07-12T18:22:01.999999Z', k: 2, id: '912' },
        ];

        for (const cursor of cursors) {
            const encoded = encodeCursor(cursor);
            expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(encoded).not.toMatch(/[=+/]/);
            expect(parseCursor(encoded)).toEqual(cursor);
        }
    });

    test('TC-TRP-002: malformed cursors always throw the typed invalid-cursor error', () => {
        const valid = { v: 1, ts: BASE_TS, k: 1, id: uuidFor(1) };
        const encodedJson = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
        const withoutVersion = { ts: BASE_TS, k: 1, id: uuidFor(1) };
        const malformed = [
            'not+base64url/',
            Buffer.from('not json', 'utf8').toString('base64url'),
            encodedJson([]),
            encodedJson({ ...valid, v: 2 }),
            encodedJson(withoutVersion),
            encodedJson({ ...valid, k: -1 }),
            encodedJson({ ...valid, k: 5 }),
            encodedJson({ ...valid, k: '1' }),
            encodedJson({ ...valid, ts: '2026-07-12T12:00:00.001Z' }),
            encodedJson({ ...valid, ts: '2026-07-12T12:00:00.000001' }),
            encodedJson({ ...valid, ts: '2026-07-12T12:00:00.000001+00:00' }),
            encodedJson({ ...valid, id: '' }),
            encodedJson({ ...valid, id: 'a'.repeat(41) }),
            encodedJson({ ...valid, id: '../' }),
            encodedJson({ ...valid, id: ';' }),
            null,
            42,
            '',
        ];

        for (const input of malformed) {
            let thrown;
            try {
                parseCursor(input);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(Error);
            expect(thrown).toMatchObject({
                name: 'InvalidCursorError',
                code: 'INVALID_CURSOR',
            });
        }

        const uppercaseUuid = 'ABCDEF12-3456-7890-ABCD-EF1234567890';
        expect(parseCursor(encodedJson({ ...valid, id: uppercaseUuid })).id).toBe(uppercaseUuid);
    });

    test('TC-TRP-003: compareDesc orders microseconds first and all five kind ranks at a tie', () => {
        const tied = KINDS
            .slice()
            .reverse()
            .map((kind, index) => makeRow(kind, BASE_TS, kind === 'sms' ? uuidFor(index) : String(index + 1)));
        const newer = makeRow('invoice', '2026-07-12T12:00:00.000002Z', '1');

        const sorted = [...tied, newer].sort(compareDesc);

        expect(sorted[0]).toBe(newer);
        expect(sorted.slice(1).map(item => item.kind)).toEqual(KINDS);
    });

    test('TC-TRP-004: compareDesc orders digit ids numerically without Number and uuid ids lexically', () => {
        const digitPair = [
            makeRow('call', BASE_TS, '9'),
            makeRow('call', BASE_TS, '10'),
        ].sort(compareDesc);
        const largeDigitPair = [
            makeRow('email', BASE_TS, '99999999999999999'),
            makeRow('email', BASE_TS, '100000000000000000'),
        ].sort(compareDesc);
        const uuidPair = [
            makeRow('sms', BASE_TS, 'a1000000-0000-4000-8000-000000000001'),
            makeRow('sms', BASE_TS, 'f0000000-0000-4000-8000-000000000001'),
        ].sort(compareDesc);

        expect(digitPair.map(item => item.id)).toEqual(['10', '9']);
        expect(largeDigitPair.map(item => item.id)).toEqual([
            '100000000000000000',
            '99999999999999999',
        ]);
        expect(uuidPair.map(item => item.id)).toEqual([
            'f0000000-0000-4000-8000-000000000001',
            'a1000000-0000-4000-8000-000000000001',
        ]);
    });

    test('TC-TRP-005: predicateModeFor implements the complete five-by-five rank matrix', () => {
        for (const kind of KINDS) {
            for (let cursorRank = 0; cursorRank <= 4; cursorRank += 1) {
                const expected = KIND_RANK[kind] > cursorRank
                    ? 'lte'
                    : KIND_RANK[kind] === cursorRank ? 'tuple' : 'lt';
                expect(predicateModeFor(kind, { ts: BASE_TS, k: cursorRank, id: '1' })).toBe(expected);
            }
            expect(predicateModeFor(kind, null)).toBeNull();
        }
    });

    test('TC-TRP-006: mergePage cuts at limit and encodes the equal-ts boundary raw id', () => {
        const page = mergePage(rowsToLegs(buildMergeFixture()), 20, null);

        expect(page.items).toHaveLength(20);
        expectStrictDesc(page.items);
        expect(page.hasMore).toBe(true);
        expect(page.items[19]).toEqual(expect.objectContaining({
            ts: microsecondTs(980000),
            src: 'financial',
            id: 'estimate-33',
        }));
        expect(page.nextCursor).toBe(encodeCursor({
            ts: microsecondTs(980000),
            k: 3,
            id: '33',
        }));
        expect(page.items.find(item => item.src === 'call').id).toEqual(expect.any(String));
        expect(page.items.find(item => item.src === 'sms').id).toMatch(/^[0-9a-f-]+$/);
    });

    test('TC-TRP-007: mergePage hasMore covers exact leg windows, exhaustion, and leftovers', () => {
        const exactLeg = mergePage(rowsToLegs(makeSequentialRows('call', 20)), 20, null);
        expect(exactLeg.hasMore).toBe(true);
        expect(exactLeg.nextCursor).not.toBeNull();

        const exhausted = mergePage(rowsToLegs([
            ...makeSequentialRows('call', 5),
            ...makeSequentialRows('sms', 4, 800000),
        ]), 20, null);
        expect(exhausted.hasMore).toBe(false);
        expect(exhausted.nextCursor).toBeNull();

        const leftover = mergePage(rowsToLegs([
            ...makeSequentialRows('call', 15),
            ...makeSequentialRows('sms', 10, 800000),
        ]), 20, null);
        expect(leftover.hasMore).toBe(true);

        const twoConversationSms = makeSequentialRows('sms', 20).map((row, index) => ({
            ...row,
            data: { conversation: index < 10 ? 'a' : 'b' },
        }));
        expect(mergePage(rowsToLegs(twoConversationSms), 20, null).hasMore).toBe(true);
    });

    test('TC-TRP-008: mergePage stays full when financial legs are omitted before the cut', () => {
        const fixture = buildMergeFixture();
        const visibleRows = fixture.filter(row => row.kind !== 'estimate' && row.kind !== 'invoice');
        const page = mergePage(rowsToLegs(visibleRows), 20, null);
        const expected = mergePage(rowsToLegs(visibleRows), visibleRows.length + 1, null);

        expect(page.items).toHaveLength(20);
        expect(page.items.every(item => item.src !== 'financial')).toBe(true);
        expect(page.items.map(itemKey)).toEqual(expected.items.slice(0, 20).map(itemKey));
        expectStrictDesc(page.items);
    });

    test('TC-TRP-009: mergePage returns the exact empty-page result for empty legs', () => {
        expect(mergePage(rowsToLegs([], true), 20, null)).toEqual({
            items: [],
            nextCursor: null,
            hasMore: false,
        });
    });

    test('TC-TRP-010: mergePage globally sorts a concatenated unsorted sms leg', () => {
        const smsRows = makeSequentialRows('sms', 6);
        const concatenated = [smsRows[0], smsRows[2], smsRows[4], smsRows[1], smsRows[3], smsRows[5]];
        const page = mergePage(rowsToLegs(concatenated), 10, null);

        expect(page.items.map(item => item.id)).toEqual(smsRows.map(row => row.id));
        expectStrictDesc(page.items);
    });

    test('TC-TRP-011: synthetic 100-item page walk has no duplicates, skips, or order drift', () => {
        const rows = syntheticRows();
        const pages = walkPages(rows);
        const walkedItems = pages.flatMap(page => page.items);
        const expectedItems = mergePage(rowsToLegs(rows), 101, null).items;

        expect(pages).toHaveLength(5);
        expect(pages.map(page => page.items.length)).toEqual([20, 20, 20, 20, 20]);
        expect(pages.slice(0, -1).every(page => page.hasMore)).toBe(true);
        expect(pages.at(-1).hasMore).toBe(false);
        expect(walkedItems).toEqual(expectedItems);
        expect(new Set(walkedItems.map(itemKey)).size).toBe(100);
        expectStrictDesc(walkedItems);
        expect(walkViolations(pages)).toEqual([]);
    });

    test('TC-TRP-012: deleted-item and arbitrary valid cursors continue by cursor values', () => {
        const rows = syntheticRows();
        const firstPage = mergePage(legsForCursor(rows, 20, null), 20, null);
        const cursor = parseCursor(firstPage.nextCursor);
        const cursorKind = KINDS[cursor.k];
        const withoutCursorRow = rows.filter(row => !(
            row.ts === cursor.ts && row.kind === cursorKind && row.id === cursor.id
        ));
        const nextPage = mergePage(
            legsForCursor(withoutCursorRow, 20, cursor),
            20,
            cursor,
        );
        const expectedAfterDeleted = mergePage(
            rowsToLegs(withoutCursorRow.filter(row => isAfterCursor(row, cursor))),
            20,
            cursor,
        );

        expect(nextPage.items).toEqual(expectedAfterDeleted.items);
        expect(nextPage.items.some(item => firstPage.items.map(itemKey).includes(itemKey(item)))).toBe(false);

        const futureCursor = parseCursor(encodeCursor({
            ts: '2099-01-01T00:00:00.000000Z',
            k: 0,
            id: '1',
        }));
        const futurePage = mergePage(legsForCursor(rows, 20, futureCursor), 20, futureCursor);
        expect(futurePage.items).toEqual(mergePage(rowsToLegs(rows), 20, null).items);

        const sameTimestampSms = rows.find(row => row.kind === 'sms');
        const uppercaseUuid = 'F0000000-0000-4000-8000-000000000099';
        const uppercaseCursor = parseCursor(encodeCursor({
            ts: sameTimestampSms.ts,
            k: 1,
            id: uppercaseUuid,
        }));
        expect(uppercaseCursor.id).toBe(uppercaseUuid);
        const uppercaseCursorLegs = legsForCursor(rows, 20, uppercaseCursor);
        expect(uppercaseCursorLegs.find(leg => leg.kind === 'sms').rows).toContainEqual(
            expect.objectContaining({ ts: sameTimestampSms.ts, id: sameTimestampSms.id }),
        );
    });

    test('TC-TRP-013: sabotage control detects a walk that ignores the second-page cursor', () => {
        const sabotagedPages = walkPages(syntheticRows(), { sabotageSecondCursor: true });
        const violations = walkViolations(sabotagedPages);

        expect(violations.length).toBeGreaterThan(0);
        expect(violations.some(violation => violation.startsWith('duplicate:'))).toBe(true);
    });
});
