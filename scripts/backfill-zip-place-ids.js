#!/usr/bin/env node
'use strict';

/**
 * ZIP-POLYGONS-001 cache warmer.
 *
 * The safe default scope is one company's configured service territories.
 * The prior global-cache scan is available only through the explicit
 * --all-us flag. Google calls remain bounded and cache-first inside
 * territoryGeoService.
 */

const db = require('../backend/src/db/connection');
const territoryGeoService = require('../backend/src/services/territoryGeoService');

const DEFAULT_LIMIT = 500;
const DEFAULT_CONCURRENCY = 5;
const COMPANY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELIGIBLE_PLACE_ID_SQL = `(z.google_place_id IS NULL
            OR z.place_id_resolved_at IS NULL
            OR z.place_id_resolved_at < NOW() - INTERVAL '12 months')`;

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionValue(args, name) {
    const prefix = `${name}=`;
    const option = args.find(arg => arg.startsWith(prefix));
    return option ? option.slice(prefix.length) : null;
}

function parseOptions(args = process.argv.slice(2)) {
    const supported = args.every(arg => (
        arg === '--all-us'
        || arg.startsWith('--company-id=')
        || arg.startsWith('--limit=')
        || arg.startsWith('--concurrency=')
    ));
    if (!supported) {
        throw new Error(
            'Usage: backfill-zip-place-ids.js --company-id=<uuid> [--limit=N] [--concurrency=N] or --all-us [--limit=N] [--concurrency=N]'
        );
    }

    const allUs = args.includes('--all-us');
    const companyId = optionValue(args, '--company-id');
    if (allUs && companyId) {
        throw new Error('--all-us and --company-id cannot be combined');
    }
    if (!allUs && !COMPANY_ID_PATTERN.test(companyId || '')) {
        throw new Error('--company-id=<uuid> is required unless --all-us is explicit');
    }

    return {
        scope: allUs ? 'all-us' : 'served',
        companyId: companyId || null,
        limit: positiveInteger(
            optionValue(args, '--limit') || process.env.ZIP_PLACE_ID_BACKFILL_LIMIT,
            DEFAULT_LIMIT
        ),
        concurrency: positiveInteger(
            optionValue(args, '--concurrency') || process.env.ZIP_PLACE_ID_BACKFILL_CONCURRENCY,
            DEFAULT_CONCURRENCY
        ),
    };
}

function eligibleCountQuery(options) {
    if (options.scope === 'all-us') {
        return {
            sql: `SELECT COUNT(*)::int AS count
                  FROM zip_geocache z
                  WHERE ${ELIGIBLE_PLACE_ID_SQL}`,
            params: [],
        };
    }
    return {
        sql: `SELECT COUNT(*)::int AS count
              FROM service_territories st
              LEFT JOIN zip_geocache z ON z.zip = st.zip
              WHERE st.company_id = $1
                AND ${ELIGIBLE_PLACE_ID_SQL}`,
        params: [options.companyId],
    };
}

function candidateQuery(options) {
    if (options.scope === 'all-us') {
        return {
            sql: `SELECT z.zip
                  FROM zip_geocache z
                  WHERE ${ELIGIBLE_PLACE_ID_SQL}
                  ORDER BY z.zip ASC
                  LIMIT $1`,
            params: [options.limit],
        };
    }
    return {
        sql: `SELECT st.zip
              FROM service_territories st
              LEFT JOIN zip_geocache z ON z.zip = st.zip
              WHERE st.company_id = $1
                AND ${ELIGIBLE_PLACE_ID_SQL}
              ORDER BY st.zip ASC
              LIMIT $2`,
        params: [options.companyId, options.limit],
    };
}

async function eligibleCount(options) {
    const query = eligibleCountQuery(options);
    const { rows } = await db.query(query.sql, query.params);
    return Number(rows[0]?.count || 0);
}

async function run(options = parseOptions()) {
    const eligibleBefore = await eligibleCount(options);
    const candidates = candidateQuery(options);
    const { rows } = await db.query(candidates.sql, candidates.params);

    let nextIndex = 0;
    async function worker() {
        while (nextIndex < rows.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
                await territoryGeoService.resolveZipPlaceId(rows[index].zip);
            } catch (error) {
                console.warn(
                    '[ZIP place ID backfill] ZIP failed (continuing):',
                    rows[index].zip,
                    error?.message || String(error)
                );
            }
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(options.concurrency, rows.length) }, () => worker())
    );

    const remaining = await eligibleCount(options);
    const resolved = Math.min(rows.length, Math.max(0, eligibleBefore - remaining));
    const result = {
        scope: options.scope,
        company_id: options.companyId,
        eligible_before: eligibleBefore,
        attempted: rows.length,
        resolved,
        unresolved_attempts: Math.max(0, rows.length - resolved),
        remaining,
        complete: remaining === 0,
        minimum_additional_runs_at_limit: Math.ceil(remaining / options.limit),
    };
    console.log(JSON.stringify(result));
    return result;
}

async function main() {
    try {
        await run(parseOptions());
    } catch (error) {
        console.error('[ZIP place ID backfill] failed:', error);
        process.exitCode = 1;
    } finally {
        await db.pool.end();
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    candidateQuery,
    eligibleCountQuery,
    parseOptions,
    run,
};
