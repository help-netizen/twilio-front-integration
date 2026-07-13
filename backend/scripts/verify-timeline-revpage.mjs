#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const BASE_COMMIT = 'd5f46b6';
const PAGE_LIMIT = 20;
const UTC_EPOCH = '1970-01-01T00:00:00.000000Z';
const NEVER_ASSIGNED_USER_ID = 'timeline-revpage-harness-never-assigned';
const WRONG_COMPANY_ID = '00000000-0000-0000-0000-ffffffffffff';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const FUTURE_TS = '9999-12-31T23:59:59.999999Z';

function findEnvFile(startDir) {
    let current = startDir;
    while (true) {
        const candidate = path.join(current, '.env');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

const envFile = findEnvFile(repoRoot);
if (envFile) {
    require('dotenv').config({ path: envFile, override: false, quiet: true });
}

const db = require('../src/db/connection');
const timelinePage = require('../src/services/timelinePage');

class HarnessAssertionError extends Error {}
class HarnessSkipError extends Error {}

const report = {
    pass: 0,
    warn: 0,
    expected: 0,
    skip: 0,
    fail: 0,
    details: [],
};

function assertHarness(condition, message) {
    if (!condition) throw new HarnessAssertionError(message);
}

function skip(message) {
    throw new HarnessSkipError(message);
}

function logResult(caseId, status, message) {
    const line = `[${caseId}] ${status} ${message}`;
    console.log(line);
    if (status === 'PASS') report.pass += 1;
    if (status === 'WARN') report.warn += 1;
    if (status === 'EXPECTED DIFF') report.expected += 1;
    if (status === 'SKIP') report.skip += 1;
    if (status === 'FAIL') report.fail += 1;
    if (status === 'WARN' || status === 'FAIL') report.details.push(line);
}

async function runCase(caseId, fn) {
    try {
        const message = await fn();
        logResult(caseId, 'PASS', message || 'ok');
    } catch (error) {
        if (error instanceof HarnessSkipError) {
            logResult(caseId, 'SKIP', error.message);
            return;
        }
        logResult(caseId, 'FAIL', error.message || String(error));
    }
}

function parseArgs(argv) {
    const options = { timelineId: null, companyId: null, sabotage: null };
    for (const arg of argv) {
        if (arg === '--help') {
            console.log('Usage: node backend/scripts/verify-timeline-revpage.mjs [--timeline=<id>] [--company=<id>] [--sabotage=ignore-cursor]');
            process.exit(0);
        }
        if (arg.startsWith('--timeline=')) {
            const value = arg.slice('--timeline='.length);
            if (!/^\d+$/.test(value)) throw new Error(`Invalid --timeline value: ${value}`);
            options.timelineId = value;
            continue;
        }
        if (arg.startsWith('--company=')) {
            const value = arg.slice('--company='.length);
            if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error(`Invalid --company value: ${value}`);
            options.companyId = value;
            continue;
        }
        if (arg.startsWith('--sabotage=')) {
            const value = arg.slice('--sabotage='.length);
            if (value !== 'ignore-cursor') throw new Error(`Unknown sabotage mode: ${value}`);
            options.sabotage = value;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

function cursorPredicateFor(kind, cursor) {
    const mode = timelinePage.predicateModeFor(kind, cursor);
    return mode ? { mode, ts: cursor.ts, id: cursor.id } : null;
}

function buildCallsQuery(timelineId, companyId, { window = null } = {}) {
    const params = [timelineId, companyId];
    let cursorClause = '';
    let windowClause = '';
    let outerOrder = 'ORDER BY c.started_at DESC NULLS LAST';

    if (window) {
        if (window.predicate?.mode === 'tuple') {
            params.push(window.predicate.ts, window.predicate.id);
            cursorClause = 'AND (COALESCE(started_at, created_at), id) < ($3::timestamptz, $4::bigint)';
        } else if (window.predicate) {
            params.push(window.predicate.ts);
            const operator = window.predicate.mode === 'lte' ? '<=' : '<';
            cursorClause = `AND COALESCE(started_at, created_at) ${operator} $3::timestamptz`;
        }
        params.push(window.limit);
        windowClause = `ORDER BY COALESCE(started_at, created_at) DESC, id DESC
                        LIMIT $${params.length}`;
        outerOrder = 'ORDER BY COALESCE(c.started_at, c.created_at) DESC, c.id DESC';
    }

    return {
        params,
        text: `SELECT c.*, to_json(co) as contact,
            COALESCE(r.recording_sid, cr.recording_sid) as recording_sid,
            COALESCE(r.status, cr.status) as recording_status,
            COALESCE(r.duration_sec, cr.duration_sec) as recording_duration_sec,
            COALESCE(t.status, ct.status) as transcript_status,
            COALESCE(t.text, ct.text) as transcript_text,
            COALESCE(t.raw_payload, ct.raw_payload) as transcript_raw_payload
         FROM (
             SELECT *,
                    to_char(COALESCE(started_at, created_at) AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
             FROM calls
             WHERE timeline_id = $1
               AND company_id = $2
               AND parent_call_sid IS NULL
               ${cursorClause}
             ${windowClause}
         ) c
         LEFT JOIN contacts co ON c.contact_id = co.id
         LEFT JOIN LATERAL (
             SELECT recording_sid, status, duration_sec
             FROM recordings
             WHERE recordings.call_sid = c.call_sid
             ORDER BY completed_at DESC NULLS LAST, updated_at DESC
             LIMIT 1
         ) r ON true
         LEFT JOIN LATERAL (
             SELECT rec.recording_sid, rec.status, rec.duration_sec
             FROM calls child
             JOIN recordings rec ON rec.call_sid = child.call_sid
             WHERE child.parent_call_sid = c.call_sid
             ORDER BY rec.completed_at DESC NULLS LAST, rec.updated_at DESC
             LIMIT 1
         ) cr ON r.recording_sid IS NULL
         LEFT JOIN LATERAL (
             SELECT status, text, raw_payload
             FROM transcripts
             WHERE transcripts.call_sid = c.call_sid
             ORDER BY updated_at DESC
             LIMIT 1
         ) t ON true
         LEFT JOIN LATERAL (
             SELECT tr.status, tr.text, tr.raw_payload
             FROM calls child
             JOIN transcripts tr ON tr.call_sid = child.call_sid
             WHERE child.parent_call_sid = c.call_sid
             ORDER BY tr.updated_at DESC
             LIMIT 1
         ) ct ON t.status IS NULL
         ${outerOrder}`,
    };
}

async function fetchCallRows(client, timelineId, companyId, options = {}) {
    const query = buildCallsQuery(timelineId, companyId, options);
    const result = await client.query(query.text, query.params);
    return result.rows;
}

async function fetchCallPhones(client, timelineId, companyId) {
    if (!timelineId) return [];
    const { rows } = await client.query(
        `SELECT DISTINCT from_number AS n FROM calls
         WHERE timeline_id = $1 AND company_id = $2
           AND parent_call_sid IS NULL AND from_number IS NOT NULL
         UNION
         SELECT DISTINCT to_number FROM calls
         WHERE timeline_id = $1 AND company_id = $2
           AND parent_call_sid IS NULL AND to_number IS NOT NULL`,
        [timelineId, companyId]
    );
    return rows.map(row => row.n).filter(Boolean);
}

async function discoverTimelineConversations(client, context, companyId = context.companyId) {
    const callPhones = await fetchCallPhones(client, context.timeline.id, companyId);
    const rawPhone = context.contact?.phone_e164 || context.timeline?.phone_e164;
    const normalizedPhone = rawPhone ? `+${rawPhone.replace(/\D/g, '')}` : null;
    const phonesToSearch = new Set();
    if (normalizedPhone) phonesToSearch.add(normalizedPhone);
    if (context.contact?.secondary_phone) {
        phonesToSearch.add(`+${context.contact.secondary_phone.replace(/\D/g, '')}`);
    }
    for (const phone of callPhones) phonesToSearch.add(phone);
    if (phonesToSearch.size === 0) return [];

    const phoneDigits = [...phonesToSearch].map(phone => phone.replace(/\D/g, ''));
    const { rows } = await client.query(
        `SELECT * FROM sms_conversations
         WHERE regexp_replace(customer_e164, '\\D', '', 'g') = ANY($1)
           AND company_id = $2
         ORDER BY last_message_at DESC NULLS LAST`,
        [phoneDigits, companyId]
    );
    return rows;
}

async function fetchSmsPageRows(client, conversationIds, companyId, { limit, predicate }) {
    if (conversationIds.length === 0) return [];
    const params = [conversationIds, companyId, limit];
    let cursorClause = '';
    if (predicate?.mode === 'tuple') {
        params.push(predicate.ts, predicate.id);
        cursorClause = 'AND (m.created_at, m.id) < ($4::timestamptz, $5::uuid)';
    } else if (predicate) {
        params.push(predicate.ts);
        const operator = predicate.mode === 'lte' ? '<=' : '<';
        cursorClause = `AND m.created_at ${operator} $4::timestamptz`;
    }

    const { rows } = await client.query(
        `SELECT sub.*
         FROM unnest($1::uuid[]) AS conv(cid)
         JOIN LATERAL (
             SELECT m.*,
                    to_char(m.created_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
                    to_char(COALESCE(m.date_created_remote, m.created_at) AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS legacy_ts,
                    COALESCE(
                        (SELECT json_agg(json_build_object(
                            'id', md.id, 'twilio_media_sid', md.twilio_media_sid,
                            'filename', md.filename, 'content_type', md.content_type,
                            'size_bytes', md.size_bytes, 'preview_kind', md.preview_kind
                        )) FROM sms_media md WHERE md.message_id = m.id), '[]'
                    ) AS media
             FROM sms_messages m
             WHERE m.conversation_id = conv.cid
               AND m.company_id = $2
               ${cursorClause}
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT $3
         ) sub ON true`,
        params
    );
    return rows;
}

async function fetchLegacySmsRows(client, conversationId) {
    const { rows } = await client.query(
        `SELECT m.*,
                to_char(m.created_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
                to_char(COALESCE(m.date_created_remote, m.created_at) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS legacy_ts,
                COALESCE(
                    (SELECT json_agg(json_build_object(
                        'id', md.id, 'twilio_media_sid', md.twilio_media_sid,
                        'filename', md.filename, 'content_type', md.content_type,
                        'size_bytes', md.size_bytes, 'preview_kind', md.preview_kind
                    )) FROM sms_media md WHERE md.message_id = m.id), '[]'
                ) AS media
         FROM sms_messages m
         WHERE m.conversation_id = $1
         ORDER BY m.created_at ASC
         LIMIT 200`,
        [conversationId]
    );
    return rows;
}

async function fetchAllSmsRows(client, conversationId, companyId) {
    const { rows } = await client.query(
        `SELECT m.id, m.conversation_id,
                to_char(m.created_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
                to_char(COALESCE(m.date_created_remote, m.created_at) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS legacy_ts
         FROM sms_messages m
         WHERE m.conversation_id = $1 AND m.company_id = $2
         ORDER BY m.created_at ASC, m.id ASC`,
        [conversationId, companyId]
    );
    return rows;
}

function buildEmailPageQuery(scope, companyId, entityId, { limit, predicate }) {
    const params = [companyId, entityId];
    let cursorClause = '';
    if (predicate?.mode === 'tuple') {
        params.push(predicate.ts, predicate.id);
        cursorClause = 'AND (COALESCE(gmail_internal_at, created_at), id) < ($3::timestamptz, $4::bigint)';
    } else if (predicate) {
        params.push(predicate.ts);
        const operator = predicate.mode === 'lte' ? '<=' : '<';
        cursorClause = `AND COALESCE(gmail_internal_at, created_at) ${operator} $3::timestamptz`;
    }
    params.push(limit);
    const keyColumn = scope === 'contact' ? 'contact_id' : 'timeline_id';
    return {
        params,
        text: `SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
                      to_recipients_json, subject, body_text, body_html, snippet, gmail_internal_at,
                      sent_by_user_email,
                      (direction = 'outbound') AS is_outbound,
                      to_char(COALESCE(gmail_internal_at, created_at) AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
                      to_char(gmail_internal_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS legacy_ts
               FROM email_messages
               WHERE company_id = $1 AND ${keyColumn} = $2 AND on_timeline = true
                 ${cursorClause}
               ORDER BY COALESCE(gmail_internal_at, created_at) DESC, id DESC
               LIMIT $${params.length}`,
    };
}

async function fetchEmailPageRows(client, scope, companyId, entityId, options) {
    const query = buildEmailPageQuery(scope, companyId, entityId, options);
    const { rows } = await client.query(query.text, query.params);
    return rows;
}

async function fetchLegacyEmailRows(client, scope, companyId, entityId) {
    const keyColumn = scope === 'contact' ? 'contact_id' : 'timeline_id';
    const { rows } = await client.query(
        `SELECT id, thread_id, provider_thread_id, direction, from_name, from_email,
                to_recipients_json, subject, body_text, body_html, snippet, gmail_internal_at,
                sent_by_user_email,
                (direction = 'outbound') AS is_outbound,
                to_char(COALESCE(gmail_internal_at, created_at) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
                to_char(gmail_internal_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS legacy_ts
         FROM email_messages
         WHERE company_id = $1 AND ${keyColumn} = $2 AND on_timeline = true
         ORDER BY gmail_internal_at ASC, id ASC`,
        [companyId, entityId]
    );
    return rows;
}

function buildFinancialPageQuery(kind, contactId, companyId, { limit, predicate }) {
    const table = kind === 'estimate' ? 'estimates' : 'invoices';
    const numberColumn = kind === 'estimate' ? 'estimate_number' : 'invoice_number';
    const amountPaid = kind === 'invoice' ? ', amount_paid' : '';
    const params = [contactId, companyId];
    let cursorClause = '';
    if (predicate?.mode === 'tuple') {
        params.push(predicate.ts, predicate.id);
        cursorClause = 'AND (created_at, id) < ($3::timestamptz, $4::bigint)';
    } else if (predicate) {
        params.push(predicate.ts);
        const operator = predicate.mode === 'lte' ? '<=' : '<';
        cursorClause = `AND created_at ${operator} $3::timestamptz`;
    }
    params.push(limit);
    return {
        params,
        text: `SELECT id, ${numberColumn} AS reference, status, total${amountPaid},
                      created_at AS occurred_at,
                      to_char(created_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
               FROM ${table}
               WHERE contact_id = $1 AND company_id = $2
                 ${cursorClause}
               ORDER BY created_at DESC, id DESC
               LIMIT $${params.length}`,
    };
}

async function fetchFinancialPageRows(client, kind, contactId, companyId, options) {
    const query = buildFinancialPageQuery(kind, contactId, companyId, options);
    const { rows } = await client.query(query.text, query.params);
    return rows;
}

async function fetchLegacyFinancialRows(client, kind, contactId, companyId) {
    const table = kind === 'estimate' ? 'estimates' : 'invoices';
    const numberColumn = kind === 'estimate' ? 'estimate_number' : 'invoice_number';
    const amountPaid = kind === 'invoice' ? ', amount_paid' : '';
    const { rows } = await client.query(
        `SELECT id, ${numberColumn} AS reference, status, total${amountPaid},
                created_at AS occurred_at,
                to_char(created_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
         FROM ${table}
         WHERE contact_id = $1 AND company_id = $2
         ORDER BY created_at DESC`,
        [contactId, companyId]
    );
    return rows;
}

function diagnosticData(row, extras = {}) {
    return {
        legacyTs: row.legacy_ts || row.ts,
        ...extras,
    };
}

async function fetchTimelinePage(client, context, { before = null, includeFinancials = true } = {}) {
    const cursor = before == null ? null : timelinePage.parseCursor(before);
    const conversations = await discoverTimelineConversations(client, context);
    const conversationIds = conversations.map(conversation => conversation.id);
    const conversationIdSet = new Set(conversationIds.map(String));
    const legs = [];

    const callRows = await fetchCallRows(client, context.timeline.id, context.companyId, {
        window: { limit: PAGE_LIMIT, predicate: cursorPredicateFor('call', cursor) },
    });
    legs.push({
        kind: 'call',
        rows: callRows.map(row => ({
            ts: row.ts,
            id: String(row.id),
            data: diagnosticData(row),
        })),
    });

    if (conversationIds.length > 0) {
        const smsRows = await fetchSmsPageRows(client, conversationIds, context.companyId, {
            limit: PAGE_LIMIT,
            predicate: cursorPredicateFor('sms', cursor),
        });
        for (const row of smsRows) {
            assertHarness(
                conversationIdSet.has(String(row.conversation_id)),
                `SMS ${row.id} returned for an undiscovered conversation`
            );
        }
        legs.push({
            kind: 'sms',
            rows: smsRows.map(row => ({
                ts: row.ts,
                id: String(row.id),
                data: diagnosticData(row, { conversationId: String(row.conversation_id) }),
            })),
        });
    }

    if (context.contact?.id || context.timeline?.id) {
        const scope = context.contact?.id ? 'contact' : 'timeline';
        const entityId = context.contact?.id || context.timeline.id;
        const emailRows = await fetchEmailPageRows(client, scope, context.companyId, entityId, {
            limit: PAGE_LIMIT,
            predicate: cursorPredicateFor('email', cursor),
        });
        legs.push({
            kind: 'email',
            rows: emailRows.map(row => ({
                ts: row.ts,
                id: String(row.id),
                data: diagnosticData(row),
            })),
        });
    }

    if (context.contact?.id && includeFinancials) {
        for (const kind of ['estimate', 'invoice']) {
            const rows = await fetchFinancialPageRows(client, kind, context.contact.id, context.companyId, {
                limit: PAGE_LIMIT,
                predicate: cursorPredicateFor(kind, cursor),
            });
            legs.push({
                kind,
                rows: rows.map(row => ({
                    ts: row.ts,
                    id: String(row.id),
                    data: diagnosticData(row),
                })),
            });
        }
    }

    const merged = timelinePage.mergePage(legs, PAGE_LIMIT, cursor);
    const response = {
        page: {
            items: merged.items,
            next_cursor: merged.nextCursor,
            has_more: merged.hasMore,
        },
    };
    if (before == null) {
        response.meta = {
            timeline_id: context.timeline.id,
            display_name: context.timeline.display_name || null,
            external_source: context.timeline.external_source || null,
            contact: context.contact || null,
            conversations,
        };
    }
    return response;
}

function rawIdFromEnvelope(item) {
    if (item.src !== 'financial') return String(item.id);
    return String(item.id).replace(/^(estimate|invoice)-/, '');
}

function kindFromEnvelope(item) {
    if (item.src !== 'financial') return item.src;
    if (String(item.id).startsWith('estimate-')) return 'estimate';
    if (String(item.id).startsWith('invoice-')) return 'invoice';
    throw new HarnessAssertionError(`Unknown financial envelope id ${item.id}`);
}

function entryKey(kind, id) {
    if (kind === 'estimate' || kind === 'invoice') return `financial:${kind}-${id}`;
    return `${kind}:${id}`;
}

function normalizeEnvelope(item) {
    const kind = kindFromEnvelope(item);
    const id = rawIdFromEnvelope(item);
    return {
        ts: item.ts,
        kind,
        id,
        key: entryKey(kind, id),
        legacyTs: item.data?.legacyTs || item.ts,
        conversationId: item.data?.conversationId || null,
    };
}

function entryFromRow(kind, row, extras = {}) {
    const id = String(row.id);
    return {
        ts: row.ts,
        kind,
        id,
        key: entryKey(kind, id),
        legacyTs: row.legacy_ts || row.ts,
        conversationId: extras.conversationId || null,
    };
}

function setDifference(left, right) {
    return [...left].filter(value => !right.has(value));
}

function assertSetEquality(actualEntries, expectedEntries, label) {
    const actual = new Set(actualEntries.map(entry => entry.key));
    const expected = new Set(expectedEntries.map(entry => entry.key));
    assertHarness(actual.size === actualEntries.length, `${label}: duplicate identities in actual stream`);
    assertHarness(expected.size === expectedEntries.length, `${label}: duplicate identities in reference stream`);
    const extra = setDifference(actual, expected);
    const missing = setDifference(expected, actual);
    assertHarness(
        extra.length === 0 && missing.length === 0,
        `${label}: extra=${extra.slice(0, 5).join(',') || 'none'} missing=${missing.slice(0, 5).join(',') || 'none'}`
    );
}

function validatePage(page, pageNumber) {
    assertHarness(page && Array.isArray(page.items), `page ${pageNumber}: missing items array`);
    assertHarness(page.items.length <= PAGE_LIMIT, `page ${pageNumber}: ${page.items.length} items exceeds ${PAGE_LIMIT}`);
    const normalized = page.items.map(normalizeEnvelope);
    for (let index = 1; index < normalized.length; index += 1) {
        assertHarness(
            timelinePage.compareDesc(normalized[index - 1], normalized[index]) < 0,
            `page ${pageNumber}: invalid DESC order at ${normalized[index - 1].key} -> ${normalized[index].key}`
        );
    }

    if (page.has_more) {
        assertHarness(page.items.length === PAGE_LIMIT, `page ${pageNumber}: has_more page has ${page.items.length}, expected ${PAGE_LIMIT}`);
        assertHarness(typeof page.next_cursor === 'string', `page ${pageNumber}: has_more without next_cursor`);
        assertHarness(normalized.length > 0, `page ${pageNumber}: has_more on an empty page`);
        const parsed = timelinePage.parseCursor(page.next_cursor);
        const last = normalized[normalized.length - 1];
        assertHarness(parsed.ts === last.ts, `page ${pageNumber}: cursor ts does not match last item`);
        assertHarness(parsed.k === timelinePage.KIND_RANK[last.kind], `page ${pageNumber}: cursor kind does not match last item`);
        assertHarness(parsed.id === last.id, `page ${pageNumber}: cursor id does not match last item`);
    } else {
        assertHarness(page.next_cursor === null, `page ${pageNumber}: terminal page has a cursor`);
    }
    return normalized;
}

async function walkTimeline(client, context, { includeFinancials = true, sabotage = false } = {}) {
    const items = [];
    const pages = [];
    const seenKeys = new Set();
    const seenCursors = new Set();
    let before = null;

    for (let pageNumber = 1; pageNumber <= 10000; pageNumber += 1) {
        const effectiveBefore = sabotage ? null : before;
        const response = await fetchTimelinePage(client, context, {
            before: effectiveBefore,
            includeFinancials,
        });
        const normalized = validatePage(response.page, pageNumber);
        for (const entry of normalized) {
            if (seenKeys.has(entry.key)) {
                if (sabotage && pageNumber > 1) {
                    throw new HarnessAssertionError(
                        `duplicate page-1 detected: timeline=${context.timeline.id} page=${pageNumber} key=${entry.key}`
                    );
                }
                throw new HarnessAssertionError(
                    `duplicate item detected: timeline=${context.timeline.id} page=${pageNumber} key=${entry.key}`
                );
            }
            seenKeys.add(entry.key);
            items.push(entry);
        }
        pages.push({
            items: normalized,
            hasMore: response.page.has_more,
            nextCursor: response.page.next_cursor,
            meta: response.meta,
        });

        if (!response.page.has_more) break;
        assertHarness(!seenCursors.has(response.page.next_cursor), `cursor loop detected on timeline ${context.timeline.id}`);
        seenCursors.add(response.page.next_cursor);
        before = response.page.next_cursor;

        if (pageNumber === 10000) {
            throw new HarnessAssertionError(`page guard exhausted on timeline ${context.timeline.id}`);
        }
    }

    for (let index = 1; index < items.length; index += 1) {
        assertHarness(
            timelinePage.compareDesc(items[index - 1], items[index]) < 0,
            `timeline ${context.timeline.id}: invalid cross-page order at ${items[index - 1].key} -> ${items[index].key}`
        );
    }
    return { context, items, pages };
}

async function loadReference(client, context) {
    const calls = await fetchCallRows(client, context.timeline.id, context.companyId, { window: null });
    const conversations = await discoverTimelineConversations(client, context);
    const emailScope = context.contact?.id ? 'contact' : 'timeline';
    const emailEntityId = context.contact?.id || context.timeline.id;
    const emails = await fetchLegacyEmailRows(client, emailScope, context.companyId, emailEntityId);
    const estimates = context.contact?.id
        ? await fetchLegacyFinancialRows(client, 'estimate', context.contact.id, context.companyId)
        : [];
    const invoices = context.contact?.id
        ? await fetchLegacyFinancialRows(client, 'invoice', context.contact.id, context.companyId)
        : [];

    const nonSmsEntries = [
        ...calls.map(row => entryFromRow('call', row)),
        ...emails.map(row => entryFromRow('email', row)),
        ...estimates.map(row => entryFromRow('estimate', row)),
        ...invoices.map(row => entryFromRow('invoice', row)),
    ];
    const legacySmsEntries = [];
    const allSmsEntries = [];
    const smsByConversation = [];

    for (const conversation of conversations) {
        const conversationId = String(conversation.id);
        const legacyRows = await fetchLegacySmsRows(client, conversation.id);
        const allRows = await fetchAllSmsRows(client, conversation.id, context.companyId);
        const legacyEntries = legacyRows.map(row => entryFromRow('sms', row, { conversationId }));
        const allEntries = allRows.map(row => entryFromRow('sms', row, { conversationId }));
        legacySmsEntries.push(...legacyEntries);
        allSmsEntries.push(...allEntries);
        smsByConversation.push({ conversationId, legacyEntries, allEntries });
    }

    return {
        conversations,
        legacyEntries: [...nonSmsEntries, ...legacySmsEntries],
        allEntries: [...nonSmsEntries, ...allSmsEntries],
        smsByConversation,
    };
}

function compareLegacyDesc(left, right) {
    const leftTs = left.legacyTs || (left.kind === 'email' ? UTC_EPOCH : left.ts);
    const rightTs = right.legacyTs || (right.kind === 'email' ? UTC_EPOCH : right.ts);
    return timelinePage.compareDesc(
        { ...left, ts: leftTs },
        { ...right, ts: rightTs }
    );
}

function analyzeSmsOrdering(walk, reference) {
    const legacyKeys = new Set(reference.legacyEntries.map(entry => entry.key));
    const common = walk.items.filter(entry => legacyKeys.has(entry.key));
    const newOrder = [...common].sort(timelinePage.compareDesc);
    const legacyOrder = [...common].sort(compareLegacyDesc);
    assertHarness(
        common.map(entry => entry.key).join('\n') === newOrder.map(entry => entry.key).join('\n'),
        `timeline ${walk.context.timeline.id}: walked order differs from canonical DESC order`
    );

    const newNonSms = newOrder.filter(entry => entry.kind !== 'sms').map(entry => entry.key);
    const legacyNonSms = legacyOrder.filter(entry => entry.kind !== 'sms').map(entry => entry.key);
    assertHarness(
        newNonSms.join('\n') === legacyNonSms.join('\n'),
        `timeline ${walk.context.timeline.id}: non-SMS ordering changed`
    );

    const newPositions = new Map(newOrder.map((entry, index) => [entry.key, index]));
    const legacyPositions = new Map(legacyOrder.map((entry, index) => [entry.key, index]));
    const movedSms = newOrder.filter(entry => (
        entry.kind === 'sms' && newPositions.get(entry.key) !== legacyPositions.get(entry.key)
    ));
    const crossDay = movedSms.filter(entry => (
        entry.legacyTs && entry.ts.slice(0, 10) !== entry.legacyTs.slice(0, 10)
    ));
    assertHarness(
        crossDay.length === 0,
        `timeline ${walk.context.timeline.id}: SMS reorder crossed UTC day for ${crossDay.slice(0, 5).map(entry => entry.key).join(',')}`
    );

    if (movedSms.length > 0) {
        const samples = movedSms.slice(0, 5).map(entry => {
            const deltaMs = Date.parse(entry.ts) - Date.parse(entry.legacyTs);
            return `${entry.key}(legacy=${legacyPositions.get(entry.key)},new=${newPositions.get(entry.key)},delta_ms=${deltaMs})`;
        });
        logResult(
            'H01',
            'WARN',
            `timeline=${walk.context.timeline.id} SMS ordering-key differences=${movedSms.length}; ${samples.join(' ')}`
        );
    }
    return movedSms.length;
}

async function loadCandidates(client, options) {
    const params = [];
    const clauses = [];
    if (options.timelineId) {
        params.push(options.timelineId);
        clauses.push(`t.id = $${params.length}`);
    }
    if (options.companyId) {
        params.push(options.companyId);
        clauses.push(`t.company_id = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await client.query(
        `SELECT t.*, to_json(c) AS linked_contact
         FROM timelines t
         LEFT JOIN contacts c ON c.id = t.contact_id AND c.company_id = t.company_id
         ${where}
         ORDER BY t.id`,
        params
    );
    return rows.map(row => {
        const timeline = { ...row };
        delete timeline.linked_contact;
        return {
            timeline,
            contact: row.linked_contact || null,
            companyId: row.company_id,
        };
    });
}

async function runH01(client, candidates, state) {
    if (candidates.length === 0) {
        throw new HarnessAssertionError('ZERO walkable timelines for H01: no timelines matched; verification is vacuous');
    }
    const failures = [];
    let walkable = 0;
    let pageCount = 0;
    let itemCount = 0;
    let smsWarnings = 0;

    for (const context of candidates) {
        try {
            const [walk, reference] = await Promise.all([
                walkTimeline(client, context),
                loadReference(client, context),
            ]);
            assertSetEquality(walk.items, reference.allEntries, `timeline ${context.timeline.id} page-vs-full`);

            const expectedFromLegacy = [...reference.legacyEntries];
            for (const conversation of reference.smsByConversation) {
                if (conversation.allEntries.length <= 200) continue;
                const legacyKeys = new Set(conversation.legacyEntries.map(entry => entry.key));
                expectedFromLegacy.push(...conversation.allEntries.filter(entry => !legacyKeys.has(entry.key)));
            }
            assertSetEquality(walk.items, expectedFromLegacy, `timeline ${context.timeline.id} page-vs-legacy-direction`);
            smsWarnings += analyzeSmsOrdering(walk, reference);

            state.walks.push(walk);
            state.references.set(String(context.timeline.id), reference);
            pageCount += walk.pages.length;
            itemCount += walk.items.length;
            if (walk.items.length > 0) walkable += 1;
        } catch (error) {
            failures.push(`timeline=${context.timeline.id}: ${error.message}`);
        }
    }

    if (walkable === 0) {
        const detail = failures.length > 0 ? `; ${failures.slice(0, 3).join(' | ')}` : '';
        throw new HarnessAssertionError(
            `ZERO walkable timelines for H01 (selected=${candidates.length}); verification is vacuous${detail}`
        );
    }
    assertHarness(failures.length === 0, `${failures.length} timeline walk(s) failed: ${failures.slice(0, 5).join(' | ')}`);
    return `timelines=${candidates.length} walkable=${walkable} pages=${pageCount} items=${itemCount} sms_warn_items=${smsWarnings}`;
}

async function runH02(state) {
    const lossy = [];
    for (const walk of state.walks) {
        const reference = state.references.get(String(walk.context.timeline.id));
        for (const conversation of reference.smsByConversation) {
            if (conversation.allEntries.length > 200) {
                lossy.push({ walk, conversation });
            }
        }
    }
    if (lossy.length === 0) skip('no >200-SMS conversation fixture');

    for (const { walk, conversation } of lossy) {
        const actual = walk.items.filter(entry => (
            entry.kind === 'sms' && entry.conversationId === conversation.conversationId
        ));
        assertSetEquality(actual, conversation.allEntries, `conversation ${conversation.conversationId} full SMS walk`);
        const actualKeys = new Set(actual.map(entry => entry.key));
        const legacyKeys = new Set(conversation.legacyEntries.map(entry => entry.key));
        const legacyMissingFromNew = setDifference(legacyKeys, actualKeys);
        const extras = actual.filter(entry => !legacyKeys.has(entry.key));
        assertHarness(legacyMissingFromNew.length === 0, `conversation ${conversation.conversationId}: legacy-new is not empty`);
        assertHarness(
            extras.length === conversation.allEntries.length - 200,
            `conversation ${conversation.conversationId}: extras=${extras.length}, expected=${conversation.allEntries.length - 200}`
        );
        const maxLegacyTs = conversation.legacyEntries.reduce(
            (maximum, entry) => maximum === null || entry.ts > maximum ? entry.ts : maximum,
            null
        );
        assertHarness(
            extras.every(entry => entry.ts >= maxLegacyTs),
            `conversation ${conversation.conversationId}: new-legacy contains an item older than the legacy boundary`
        );
        logResult(
            'H02',
            'EXPECTED DIFF',
            `NEW correct / LEGACY lossy (oldest-200): timeline=${walk.context.timeline.id} conversation=${conversation.conversationId} total=${conversation.allEntries.length} new_only=${extras.length}`
        );
    }
    return `verified ${lossy.length} lossy conversation(s)`;
}

function cursorForEntry(entry) {
    return timelinePage.encodeCursor({
        ts: entry.ts,
        k: timelinePage.KIND_RANK[entry.kind],
        id: entry.id,
    });
}

async function runH03(client, state) {
    for (const walk of state.walks) {
        for (let boundary = 19; boundary < walk.items.length - 1; boundary += 1) {
            const left = walk.items[boundary];
            const right = walk.items[boundary + 1];
            if (left.ts !== right.ts || left.kind === right.kind) continue;

            const start = boundary - 19;
            const before = start === 0 ? null : cursorForEntry(walk.items[start - 1]);
            const pageAResponse = await fetchTimelinePage(client, walk.context, { before });
            const pageA = validatePage(pageAResponse.page, 1);
            assertHarness(pageA.length === PAGE_LIMIT, `equal-µs page A has ${pageA.length} items`);
            assertHarness(pageA[19].key === left.key, `equal-µs boundary did not land on ${left.key}`);
            assertHarness(pageAResponse.page.has_more, 'equal-µs page A unexpectedly terminal');
            const pageBResponse = await fetchTimelinePage(client, walk.context, {
                before: pageAResponse.page.next_cursor,
            });
            const pageB = validatePage(pageBResponse.page, 2);
            assertHarness(pageB.length > 0, 'equal-µs page B is empty');
            assertHarness(pageB[0].key === right.key, `equal-µs page B starts at ${pageB[0].key}, expected ${right.key}`);
            assertHarness(pageA[19].ts === pageB[0].ts, 'equal-µs timestamp was not preserved across the cursor');

            const combined = [...pageA, ...pageB];
            const expected = walk.items.slice(start, start + combined.length);
            assertHarness(
                combined.map(entry => entry.key).join('\n') === expected.map(entry => entry.key).join('\n'),
                'equal-µs targeted walk has a duplicate or skip'
            );
            return `timeline=${walk.context.timeline.id} ts=${left.ts} boundary=${left.kind}->${right.kind}`;
        }
    }
    skip('no natural cross-kind equal-µs run deep enough for a 20-item cut (read-only harness did not seed)');
}

async function runH04(client, state) {
    const candidate = state.walks.find(walk => {
        const reference = state.references.get(String(walk.context.timeline.id));
        const financialCount = reference.allEntries.filter(entry => entry.kind === 'estimate' || entry.kind === 'invoice').length;
        const nonFinancialCount = reference.allEntries.length - financialCount;
        return financialCount > 0 && nonFinancialCount >= PAGE_LIMIT;
    });
    if (!candidate) skip('no timeline with financial events and at least 20 non-financial items');

    const walk = await walkTimeline(client, candidate.context, { includeFinancials: false });
    assertHarness(walk.items.every(entry => entry.kind !== 'estimate' && entry.kind !== 'invoice'), 'financial item leaked into restricted walk');
    const reference = state.references.get(String(candidate.context.timeline.id));
    const expected = reference.allEntries.filter(entry => entry.kind !== 'estimate' && entry.kind !== 'invoice');
    assertSetEquality(walk.items, expected, `timeline ${candidate.context.timeline.id} permission-filtered walk`);
    return `timeline=${candidate.context.timeline.id} pages=${walk.pages.length} items=${walk.items.length}`;
}

async function isContactVisibleToProvider(client, context, userId) {
    if (!userId || !context.contact?.id) return false;
    const { rows } = await client.query(
        `SELECT 1 FROM jobs pj
         WHERE pj.contact_id = $1 AND pj.company_id = $2
           AND pj.assigned_provider_user_ids @> $3::jsonb
         LIMIT 1`,
        [context.contact.id, context.companyId, JSON.stringify([userId])]
    );
    return rows.length > 0;
}

async function runH05(client, candidates) {
    if (candidates.length === 0) skip('no timeline fixture');
    const context = candidates.find(candidate => !candidate.contact?.id) || candidates[0];
    let legCalls = 0;
    const visible = await isContactVisibleToProvider(client, context, NEVER_ASSIGNED_USER_ID);
    let status;
    if (!visible) {
        status = 404;
    } else {
        legCalls += 1;
        await fetchTimelinePage(client, context);
        status = 200;
    }
    assertHarness(status === 404, `assigned_only decision returned ${status}`);
    assertHarness(legCalls === 0, `assigned_only denial reached ${legCalls} leg invocation(s)`);
    return `timeline=${context.timeline.id} contact=${context.contact?.id || 'orphan'} status=404 leg_calls=0`;
}

async function chooseWrongCompanyId(client, companyId) {
    const { rows } = await client.query(
        'SELECT DISTINCT company_id FROM timelines WHERE company_id <> $1 LIMIT 1',
        [companyId]
    );
    if (rows[0]?.company_id) return rows[0].company_id;
    return String(companyId) === WRONG_COMPANY_ID ? ZERO_UUID : WRONG_COMPANY_ID;
}

async function runH06(client, candidates, state) {
    if (candidates.length === 0) skip('no timeline fixture');
    const context = candidates.find(candidate => candidate.contact?.id) || candidates[0];
    const wrongCompanyId = await chooseWrongCompanyId(client, context.companyId);
    const owned = await client.query(
        'SELECT * FROM timelines WHERE id = $1 AND company_id = $2',
        [context.timeline.id, wrongCompanyId]
    );
    assertHarness(owned.rows.length === 0, 'foreign-company timeline resolved instead of the 404 path');

    const conversations = await discoverTimelineConversations(client, context);
    const conversationIds = conversations.length > 0 ? conversations.map(row => row.id) : [ZERO_UUID];
    const contactId = context.contact?.id || '0';
    const cursorFor = kind => ({ ts: FUTURE_TS, k: timelinePage.KIND_RANK[kind], id: kind === 'sms' ? ZERO_UUID : '0' });
    const checks = [
        {
            name: 'calls',
            noCursor: () => fetchCallRows(client, context.timeline.id, wrongCompanyId, { window: { limit: PAGE_LIMIT, predicate: null } }),
            cursor: () => fetchCallRows(client, context.timeline.id, wrongCompanyId, {
                window: { limit: PAGE_LIMIT, predicate: cursorPredicateFor('call', cursorFor('call')) },
            }),
        },
        {
            name: 'sms',
            noCursor: () => fetchSmsPageRows(client, conversationIds, wrongCompanyId, { limit: PAGE_LIMIT, predicate: null }),
            cursor: () => fetchSmsPageRows(client, conversationIds, wrongCompanyId, {
                limit: PAGE_LIMIT,
                predicate: cursorPredicateFor('sms', cursorFor('sms')),
            }),
        },
        {
            name: 'email-contact',
            noCursor: () => fetchEmailPageRows(client, 'contact', wrongCompanyId, contactId, { limit: PAGE_LIMIT, predicate: null }),
            cursor: () => fetchEmailPageRows(client, 'contact', wrongCompanyId, contactId, {
                limit: PAGE_LIMIT,
                predicate: cursorPredicateFor('email', cursorFor('email')),
            }),
        },
        {
            name: 'email-timeline',
            noCursor: () => fetchEmailPageRows(client, 'timeline', wrongCompanyId, context.timeline.id, { limit: PAGE_LIMIT, predicate: null }),
            cursor: () => fetchEmailPageRows(client, 'timeline', wrongCompanyId, context.timeline.id, {
                limit: PAGE_LIMIT,
                predicate: cursorPredicateFor('email', cursorFor('email')),
            }),
        },
        ...['estimate', 'invoice'].map(kind => ({
            name: kind,
            noCursor: () => fetchFinancialPageRows(client, kind, contactId, wrongCompanyId, { limit: PAGE_LIMIT, predicate: null }),
            cursor: () => fetchFinancialPageRows(client, kind, contactId, wrongCompanyId, {
                limit: PAGE_LIMIT,
                predicate: cursorPredicateFor(kind, cursorFor(kind)),
            }),
        })),
    ];

    const wrongCallPhones = await fetchCallPhones(client, context.timeline.id, wrongCompanyId);
    assertHarness(wrongCallPhones.length === 0, 'call-phone discovery returned foreign rows');
    const wrongConversations = await discoverTimelineConversations(client, context, wrongCompanyId);
    assertHarness(wrongConversations.length === 0, 'conversation discovery returned foreign rows');
    for (const check of checks) {
        const [withoutCursor, withCursor] = await Promise.all([check.noCursor(), check.cursor()]);
        assertHarness(withoutCursor.length === 0, `${check.name} leaked rows without cursor`);
        assertHarness(withCursor.length === 0, `${check.name} leaked rows with cursor`);
    }

    const walked = state.walks.find(item => String(item.context.timeline.id) === String(context.timeline.id));
    return `timeline=${context.timeline.id} wrong_company=${wrongCompanyId} legs=7 cursor_modes=checked${walked ? '' : ' selected-context-not-walked'}`;
}

async function runH07(state) {
    const candidate = state.walks.find(walk => {
        const timeline = walk.context.timeline;
        const yelp = timeline.yelp_conversation_id
            || String(timeline.external_source || '').toLowerCase().includes('yelp');
        return !walk.context.contact?.id && yelp && walk.items.length > 0;
    });
    if (!candidate) skip('no non-empty contactless Yelp timeline fixture');
    assertHarness(candidate.items.every(entry => entry.kind === 'email'), 'contactless Yelp walk contains a non-email item');
    const meta = candidate.pages[0]?.meta;
    assertHarness(meta?.contact === null, 'contactless Yelp meta.contact is not null');
    assertHarness(String(meta.timeline_id) === String(candidate.context.timeline.id), 'contactless Yelp meta.timeline_id mismatch');
    assertHarness(meta.display_name === (candidate.context.timeline.display_name || null), 'contactless Yelp display_name mismatch');
    assertHarness(meta.external_source === (candidate.context.timeline.external_source || null), 'contactless Yelp external_source mismatch');
    return `timeline=${candidate.context.timeline.id} pages=${candidate.pages.length} emails=${candidate.items.length}`;
}

async function runH08(state) {
    const zero = state.walks.find(walk => walk.items.length === 0);
    const short = state.walks.find(walk => walk.items.length > 0 && walk.items.length < PAGE_LIMIT);
    const exact = state.walks.find(walk => walk.items.length === PAGE_LIMIT);
    const missing = [];

    if (zero) {
        assertHarness(zero.pages.length === 1, `zero timeline ${zero.context.timeline.id} used ${zero.pages.length} pages`);
        assertHarness(zero.pages[0].items.length === 0 && !zero.pages[0].hasMore, 'zero timeline sequence mismatch');
    } else {
        missing.push('zero');
    }
    if (short) {
        assertHarness(short.pages.length === 1 && !short.pages[0].hasMore, `short timeline ${short.context.timeline.id} sequence mismatch`);
    } else {
        missing.push('<20');
    }
    if (exact) {
        assertHarness(exact.pages.length === 2, `exact-20 timeline ${exact.context.timeline.id} did not issue the accepted empty fetch`);
        assertHarness(exact.pages[0].items.length === PAGE_LIMIT && exact.pages[0].hasMore, 'exact-20 first page sequence mismatch');
        assertHarness(exact.pages[1].items.length === 0 && !exact.pages[1].hasMore, 'exact-20 terminal page sequence mismatch');
    } else {
        missing.push('exactly-20');
    }
    if (missing.length === 3) skip(`no cardinality fixtures (${missing.join(', ')})`);
    return `verified=${['zero', '<20', 'exactly-20'].filter(label => !missing.includes(label)).join(',')} skipped=${missing.join(',') || 'none'}`;
}

async function runH09(client, state) {
    const candidate = state.walks
        .filter(walk => walk.items.some(entry => entry.kind === 'call'))
        .sort((left, right) => (
            right.items.filter(entry => entry.kind === 'call').length
            - left.items.filter(entry => entry.kind === 'call').length
        ))[0];
    if (!candidate) skip('no timeline with calls for the N1 EXPLAIN gate');

    const indexResult = await client.query(
        `SELECT pg_get_indexdef(indexrelid) AS definition
         FROM pg_index
         JOIN pg_class ON pg_class.oid = indexrelid
         WHERE pg_class.relname = 'idx_calls_timeline_page'`
    );
    assertHarness(indexResult.rows.length === 1, 'idx_calls_timeline_page is not installed');
    const indexDefinition = indexResult.rows[0].definition;
    assertHarness(indexDefinition.includes('COALESCE(started_at, created_at)'), 'calls page index has the wrong timestamp expression');
    assertHarness(indexDefinition.includes('parent_call_sid IS NULL'), 'calls page index is missing its parent-call predicate');

    const originalSeqscan = (await client.query('SHOW enable_seqscan')).rows[0].enable_seqscan;
    let planLines;
    try {
        await client.query('SET LOCAL enable_seqscan = off');
        const query = buildCallsQuery(candidate.context.timeline.id, candidate.context.companyId, {
            window: { limit: PAGE_LIMIT, predicate: null },
        });
        const explained = await client.query(
            `EXPLAIN (ANALYZE FALSE, FORMAT TEXT) ${query.text}`,
            query.params
        );
        planLines = explained.rows.map(row => row['QUERY PLAN']);
    } finally {
        await client.query(`SET LOCAL enable_seqscan = ${originalSeqscan === 'off' ? 'off' : 'on'}`);
    }

    const indexLine = planLines.find(line => line.includes('idx_calls_timeline_page'));
    const limitLine = planLines.find(line => /\bLimit\b/.test(line));
    assertHarness(indexLine, 'EXPLAIN did not use idx_calls_timeline_page with seqscan disabled');
    assertHarness(limitLine, 'EXPLAIN did not retain the calls inner Limit');
    console.log(`[H09] PLAN ${limitLine.trim()}`);
    console.log(`[H09] PLAN ${indexLine.trim()}`);

    const migration = fs.readFileSync(path.join(repoRoot, 'backend/db/migrations/168_timeline_revpage_call_page_index.sql'), 'utf8');
    const rollback = fs.readFileSync(path.join(repoRoot, 'backend/db/migrations/rollback_168_timeline_revpage_call_page_index.sql'), 'utf8');
    assertHarness(migration.includes('CREATE INDEX IF NOT EXISTS idx_calls_timeline_page'), 'migration 168 is not idempotent');
    assertHarness(rollback.includes('DROP INDEX IF EXISTS idx_calls_timeline_page'), 'migration 168 rollback is missing');
    return `timeline=${candidate.context.timeline.id} ANALYZE=false index=idx_calls_timeline_page`;
}

function gitOutput(args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function baseFile(file) {
    return gitOutput(['show', `${BASE_COMMIT}:${file}`]);
}

function currentFile(file) {
    return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

function extractTopLevelFunction(source, name) {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith(`async function ${name}(`) || line.startsWith(`function ${name}(`));
    assertHarness(start >= 0, `could not find function ${name}`);
    for (let index = start + 1; index < lines.length; index += 1) {
        if (lines[index] === '}') return lines.slice(start, index + 1).join('\n');
    }
    throw new HarnessAssertionError(`could not find end of function ${name}`);
}

function extractRouteSection(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assertHarness(start >= 0 && end > start, `could not extract protected route section ${startMarker}`);
    return source.slice(start, end).trim();
}

async function runH11() {
    const changed = gitOutput(['diff', BASE_COMMIT, '--name-only'])
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const protectedFiles = new Set([
        'src/server.js',
        'frontend/src/components/layout/AppLayout.tsx',
        'frontend/src/components/softphone/OpenTimelineButton.tsx',
        'frontend/src/components/softphone/useSoftPhoneWidget.ts',
        'frontend/src/pages/ConversationPage.tsx',
        'frontend/src/components/pulse/SmsForm.tsx',
        'frontend/src/lib/authedFetch.ts',
        'frontend/src/hooks/useRealtimeEvents.ts',
        'frontend/src/hooks/sseManager.ts',
        'frontend/src/components/pulse/DateSeparator.tsx',
        'frontend/src/components/pulse/PulseCallListItem.tsx',
        'frontend/src/components/pulse/SmsListItem.tsx',
        'frontend/src/components/pulse/EmailListItem.tsx',
        'frontend/src/components/pulse/FinancialEventListItem.tsx',
        'backend/src/services/permissionCatalog.js',
    ]);
    const protectedChanges = changed.filter(file => (
        protectedFiles.has(file) || file.startsWith('frontend/src/components/conversations/')
    ));
    assertHarness(protectedChanges.length === 0, `protected files changed: ${protectedChanges.join(', ')}`);

    const pulseBase = baseFile('backend/src/routes/pulse.js');
    const pulseCurrent = currentFile('backend/src/routes/pulse.js');
    const timelineByPhoneStart = '// GET /api/pulse/timeline-by-phone';
    const defaultProxyStart = '// GET /api/pulse/default-proxy';
    assertHarness(
        extractRouteSection(pulseBase, timelineByPhoneStart, defaultProxyStart)
            === extractRouteSection(pulseCurrent, timelineByPhoneStart, defaultProxyStart),
        'timeline-by-phone route/response changed'
    );

    const functionChecks = [
        ['backend/src/db/timelinesQueries.js', 'getUnifiedTimelinePage'],
        ['backend/src/db/conversationsQueries.js', 'getMessages'],
        ['backend/src/db/emailQueries.js', 'getTimelineEmailByContact'],
        ['backend/src/db/emailQueries.js', 'getTimelineEmailByTimeline'],
    ];
    for (const [file, name] of functionChecks) {
        assertHarness(
            extractTopLevelFunction(baseFile(file), name) === extractTopLevelFunction(currentFile(file), name),
            `protected function ${name} changed in ${file}`
        );
    }
    return `base=${BASE_COMMIT} changed_files=${changed.length} protected_diff=0 protected_functions=4`;
}

async function runSabotage(client, candidates) {
    if (candidates.length === 0) {
        throw new HarnessAssertionError('sabotage cannot run: no timeline candidates');
    }
    for (const context of candidates) {
        const pageOne = await fetchTimelinePage(client, context);
        if (!pageOne.page.has_more) continue;
        await walkTimeline(client, context, { sabotage: true });
        throw new HarnessAssertionError(`sabotage did not detect duplicate page 1 on timeline ${context.timeline.id}`);
    }
    throw new HarnessAssertionError('sabotage cannot exercise duplicate detection: no candidate has_more after page 1');
}

function printSummary() {
    console.log(
        `SUMMARY PASS=${report.pass} WARN=${report.warn} EXPECTED=${report.expected} SKIP=${report.skip} FAIL=${report.fail}`
    );
    console.log(`RESULT ${report.fail === 0 ? 'PASS' : 'FAIL'}`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set and no repository .env was found');
    }

    const client = await db.getClient();
    let transactionOpen = false;
    try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        transactionOpen = true;
        const candidates = await loadCandidates(client, options);

        if (options.sabotage === 'ignore-cursor') {
            try {
                await runSabotage(client, candidates);
                logResult('H10', 'FAIL', 'sabotage unexpectedly completed without duplicate detection');
            } catch (error) {
                logResult('H10', 'FAIL', error.message || String(error));
            }
            return;
        }

        const state = { walks: [], references: new Map() };
        await runCase('H01', () => runH01(client, candidates, state));
        await runCase('H02', () => runH02(state));
        await runCase('H03', () => runH03(client, state));
        await runCase('H04', () => runH04(client, state));
        await runCase('H05', () => runH05(client, candidates));
        await runCase('H06', () => runH06(client, candidates, state));
        await runCase('H07', () => runH07(state));
        await runCase('H08', () => runH08(state));
        await runCase('H09', () => runH09(client, state));
        await runCase('H11', runH11);
    } finally {
        if (transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (error) {
                console.error(`[cleanup] ROLLBACK failed: ${error.message}`);
            }
        }
        client.release();
    }
}

try {
    await main();
} catch (error) {
    logResult('HARNESS', 'FAIL', error.message || String(error));
} finally {
    await db.pool.end();
    printSummary();
    if (report.fail > 0) process.exitCode = 1;
}
