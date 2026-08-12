/**
 * TECH-MERGE-001 — loss-aware, tenant-scoped technician merge.
 *
 * Native technician UUIDs are the post-merge operational key. Legacy TEXT
 * columns are canonicalized to the survivor UUID string; external identities
 * move to the survivor as provenance/compatibility aliases. The loser remains
 * as an inactive `merged_into` tombstone for idempotency and audit.
 */

const db = require('../db/connection');
const scheduleQueries = require('../db/scheduleQueries');

const DATA_WINS_FAIL = 'fail-closed';
const DATA_WINS_SURVIVOR = 'survivor';
const DATA_WINS_LOSER = 'loser';

const CONFIG_TABLES = [
    { table: 'technician_profiles', textColumn: 'tech_id' },
    { table: 'technician_base_locations', textColumn: 'tech_id' },
    { table: 'technician_time_off', textColumn: 'technician_id' },
    { table: 'technician_work_schedules', textColumn: 'technician_id' },
    { table: 'technician_work_schedule_days', textColumn: 'technician_id' },
    { table: 'technician_district_assignments', textColumn: 'technician_id' },
    { table: 'technician_radius_assignments', textColumn: 'technician_id' },
    { table: 'technician_area_wildcards', textColumn: 'technician_id' },
];

class TechnicianMergeConflictError extends Error {
    constructor(conflicts, plan) {
        const tables = conflicts.map(conflict => conflict.table).join(', ');
        super(
            `[TechnicianMerge] singleton conflict in ${tables} for loser ${plan.loser.id} `
            + `and survivor ${plan.survivor.id}. Remove one configuration manually or rerun `
            + `with dataWins="survivor" or dataWins="loser"; either opt-in discards and audits `
            + `the non-winning rows.`
        );
        this.name = 'TechnicianMergeConflictError';
        this.code = 'TECHNICIAN_MERGE_CONFLICT';
        this.conflicts = conflicts;
        this.plan = plan;
    }
}

function mergeError(code, message) {
    const error = new Error(`[TechnicianMerge] ${message}`);
    error.code = code;
    return error;
}

function normalizedId(value) {
    return String(value || '').trim().toLowerCase();
}

function serializeRow(row) {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
    ]));
}

function rowOwner(row, textColumn, identities) {
    const nativeId = normalizedId(row.technician_uuid);
    if (nativeId === identities.loserId) return 'loser';
    if (nativeId === identities.survivorId) return 'survivor';
    if (nativeId) return null;

    const textId = String(row[textColumn] || '');
    if (identities.loserTextIds.has(textId)) return 'loser';
    if (identities.survivorTextIds.has(textId)) return 'survivor';
    return null;
}

function classifyRows(rows, descriptor, identities) {
    const classified = { loser: [], survivor: [] };
    for (const row of rows) {
        const owner = rowOwner(row, descriptor.textColumn, identities);
        if (!owner) {
            throw mergeError(
                'TECHNICIAN_MERGE_INCONSISTENT_REFERENCE',
                `${descriptor.table} contains a row whose native and legacy technician keys disagree`
            );
        }
        classified[owner].push(row);
    }
    return classified;
}

async function readRelatedRows(client, descriptor, companyId, identities, forUpdate = true) {
    const { rows } = await client.query(
        `SELECT *
           FROM ${descriptor.table}
          WHERE company_id = $1
            AND (
                technician_uuid = ANY($2::uuid[])
                OR (
                    technician_uuid IS NULL
                    AND ${descriptor.textColumn} = ANY($3::text[])
                )
            )${forUpdate ? '\n          FOR UPDATE' : ''}`,
        [
            companyId,
            [identities.loserId, identities.survivorId],
            [...identities.allTextIds],
        ]
    );
    return classifyRows(rows, descriptor, identities);
}

async function deleteRelatedRows(client, descriptor, companyId, identities) {
    await client.query(
        `DELETE FROM ${descriptor.table}
          WHERE company_id = $1
            AND (
                technician_uuid = ANY($2::uuid[])
                OR (
                    technician_uuid IS NULL
                    AND ${descriptor.textColumn} = ANY($3::text[])
                )
            )`,
        [
            companyId,
            [identities.loserId, identities.survivorId],
            [...identities.allTextIds],
        ]
    );
}

function winningOwner(rowsByOwner, dataWins) {
    if (rowsByOwner.loser.length === 0) return rowsByOwner.survivor.length > 0 ? 'survivor' : null;
    if (rowsByOwner.survivor.length === 0) return 'loser';
    return dataWins === DATA_WINS_LOSER ? 'loser' : 'survivor';
}

function preferredRow(rowsByOwner, dataWins) {
    const owner = winningOwner(rowsByOwner, dataWins);
    return owner ? rowsByOwner[owner][0] : null;
}

function rangeKey(row) {
    return `${new Date(row.starts_at).toISOString()}|${new Date(row.ends_at).toISOString()}`;
}

function timeOffMerge(rowsByOwner, dataWins) {
    const ownerOrder = dataWins === DATA_WINS_LOSER
        ? ['loser', 'survivor']
        : ['survivor', 'loser'];
    const candidates = ownerOrder.flatMap(owner =>
        rowsByOwner[owner].map(row => ({ owner, row }))
    );
    const winnerByRange = new Map();
    const discarded = [];
    for (const candidate of candidates) {
        const key = rangeKey(candidate.row);
        if (winnerByRange.has(key)) {
            discarded.push({
                row: candidate.row,
                winner: winnerByRange.get(key).row,
            });
        } else {
            winnerByRange.set(key, candidate);
        }
    }
    return {
        winners: [...winnerByRange.values()].map(candidate => candidate.row),
        duplicateIds: discarded.map(candidate => candidate.row.id),
        discarded,
    };
}

function setWinners(rowsByOwner, keyColumn, dataWins) {
    if (rowsByOwner.loser.length > 0 && rowsByOwner.survivor.length > 0
        && dataWins !== DATA_WINS_FAIL) {
        return [...rowsByOwner[dataWins]];
    }
    const winners = new Map();
    for (const owner of ['survivor', 'loser']) {
        for (const row of rowsByOwner[owner]) {
            const key = String(row[keyColumn]);
            if (!winners.has(key)) winners.set(key, row);
        }
    }
    return [...winners.values()];
}

async function readJobs(client, companyId, identities) {
    const { rows } = await client.query(
        `SELECT id, assigned_techs
           FROM jobs
          WHERE company_id = $1
            AND jsonb_typeof(assigned_techs) = 'array'
            AND EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(assigned_techs) assignment
                 WHERE assignment->>'id' = ANY($2::text[])
            )
          ORDER BY id
          FOR UPDATE`,
        [companyId, [...identities.allTextIds]]
    );
    return rows;
}

function countJobAssignments(jobs, identities) {
    const counts = { affected_rows: jobs.length, loser_assignments: 0, survivor_assignments: 0 };
    for (const job of jobs) {
        for (const assignment of job.assigned_techs || []) {
            const id = String(assignment?.id || '');
            if (identities.loserTextIds.has(id)) counts.loser_assignments += 1;
            else if (identities.survivorTextIds.has(id)) counts.survivor_assignments += 1;
        }
    }
    return counts;
}

function singletonConflict(table, rowsByOwner, childRows = null) {
    if (rowsByOwner.loser.length === 0 || rowsByOwner.survivor.length === 0) return null;
    const conflict = {
        table,
        loser_rows: rowsByOwner.loser.map(serializeRow),
        survivor_rows: rowsByOwner.survivor.map(serializeRow),
    };
    if (childRows) {
        conflict.loser_child_rows = childRows.loser.map(serializeRow);
        conflict.survivor_child_rows = childRows.survivor.map(serializeRow);
    }
    return conflict;
}

function discardedSingleton(conflict, dataWins) {
    const losingOwner = dataWins === DATA_WINS_LOSER ? 'survivor' : 'loser';
    return {
        table: conflict.table,
        winning_owner: dataWins,
        discarded_rows: conflict[`${losingOwner}_rows`],
        discarded_child_rows: conflict[`${losingOwner}_child_rows`] || [],
    };
}

function discardedSet(table, rowsByOwner, dataWins) {
    if (dataWins === DATA_WINS_FAIL
        || rowsByOwner.loser.length === 0
        || rowsByOwner.survivor.length === 0) return null;
    const losingOwner = dataWins === DATA_WINS_LOSER ? 'survivor' : 'loser';
    return {
        table,
        winning_owner: dataWins,
        discarded_rows: rowsByOwner[losingOwner].map(serializeRow),
        discarded_child_rows: [],
    };
}

async function buildPlan(client, pair, companyId, dataWins, dryRun) {
    const loser = pair.loser;
    const survivor = pair.survivor;
    const { rows: externalRows } = await client.query(
        `SELECT company_id, source, external_id, technician_id, created_at
           FROM technician_external_identities
          WHERE company_id = $1 AND technician_id = ANY($2::uuid[])
          ORDER BY source, created_at, external_id
          FOR UPDATE`,
        [companyId, [loser.id, survivor.id]]
    );
    const loserId = normalizedId(loser.id);
    const survivorId = normalizedId(survivor.id);
    const identities = {
        loserId,
        survivorId,
        loserTextIds: new Set([loserId]),
        survivorTextIds: new Set([survivorId]),
    };
    for (const row of externalRows) {
        const target = normalizedId(row.technician_id) === loserId
            ? identities.loserTextIds
            : identities.survivorTextIds;
        target.add(String(row.external_id));
    }
    identities.allTextIds = new Set([
        ...identities.loserTextIds,
        ...identities.survivorTextIds,
    ]);

    const rows = {};
    for (const descriptor of CONFIG_TABLES) {
        rows[descriptor.table] = await readRelatedRows(
            client, descriptor, companyId, identities
        );
    }
    const jobs = await readJobs(client, companyId, identities);
    const timeOff = timeOffMerge(rows.technician_time_off, dataWins);
    const conflicts = [
        singletonConflict('technician_profiles', rows.technician_profiles),
        singletonConflict('technician_base_locations', rows.technician_base_locations),
        singletonConflict(
            'technician_work_schedules',
            rows.technician_work_schedules,
            rows.technician_work_schedule_days
        ),
    ].filter(Boolean);
    const discardedData = dataWins === DATA_WINS_FAIL
        ? []
        : [
            ...conflicts.map(conflict => discardedSingleton(conflict, dataWins)),
            discardedSet(
                'technician_district_assignments',
                rows.technician_district_assignments,
                dataWins
            ),
            discardedSet(
                'technician_radius_assignments',
                rows.technician_radius_assignments,
                dataWins
            ),
            discardedSet(
                'technician_area_wildcards',
                rows.technician_area_wildcards,
                dataWins
            ),
            timeOff.discarded.length > 0 ? {
                table: 'technician_time_off',
                winning_owner: dataWins,
                reason: 'exact_range_collision',
                discarded_rows: timeOff.discarded.map(candidate => serializeRow(candidate.row)),
                retained_rows: timeOff.discarded.map(candidate => serializeRow(candidate.winner)),
                discarded_child_rows: [],
            } : null,
        ].filter(Boolean);

    const references = {};
    for (const descriptor of CONFIG_TABLES) {
        const tableRows = rows[descriptor.table];
        references[descriptor.table] = {
            loser_rows: tableRows.loser.length,
            survivor_rows: tableRows.survivor.length,
        };
    }
    references.technician_time_off.duplicate_ranges = timeOff.duplicateIds.length;
    references.jobs = countJobAssignments(jobs, identities);
    references.technician_external_identities = {
        loser_rows: externalRows.filter(row => normalizedId(row.technician_id) === loserId).length,
        survivor_rows: externalRows.filter(row => normalizedId(row.technician_id) === survivorId).length,
    };

    for (const table of ['rate_tokens', 'technician_ratings']) {
        const { rows: countRows } = await client.query(
            `SELECT COUNT(*)::int AS count
               FROM ${table}
              WHERE company_id = $1 AND tech_id = ANY($2::text[])`,
            [companyId, [...identities.allTextIds]]
        );
        references[table] = { rows: Number(countRows[0]?.count || 0) };
    }

    return {
        plan: {
            status: conflicts.length > 0 && dataWins === DATA_WINS_FAIL
                ? 'blocked'
                : (dryRun ? 'dry-run' : 'ready'),
            company_id: companyId,
            loser: {
                id: loserId,
                display_name: loser.display_name,
                active: loser.active,
                crm_user_id: loser.crm_user_id,
            },
            survivor: {
                id: survivorId,
                display_name: survivor.display_name,
                active: survivor.active,
                crm_user_id: survivor.crm_user_id,
            },
            effective_display_name: pair.effectiveDisplayName,
            data_wins: dataWins,
            references,
            conflicts,
            discarded_data: discardedData,
        },
        identities,
        rows,
        jobs,
        externalRows,
        timeOff,
        conflicts,
        discardedData,
    };
}

async function applyProfile(client, companyId, survivorId, rowsByOwner, dataWins) {
    const winner = preferredRow(rowsByOwner, dataWins);
    if (!winner) return;
    const winnerOwner = winningOwner(rowsByOwner, dataWins);
    const discarded = rowsByOwner[winnerOwner === 'loser' ? 'survivor' : 'loser'];
    if (discarded.length > 0) {
        await client.query(
            `DELETE FROM technician_profiles
              WHERE company_id = $1 AND id = ANY($2::bigint[])`,
            [companyId, discarded.map(row => row.id)]
        );
    }
    await client.query(
        `UPDATE technician_profiles
            SET tech_id = $3, technician_uuid = $4::uuid, updated_at = NOW()
          WHERE company_id = $1 AND id = $2`,
        [companyId, winner.id, survivorId, survivorId]
    );
}

async function applyBaseLocation(
    client, companyId, survivorId, rowsByOwner, descriptor, identities, dataWins
) {
    const winner = preferredRow(rowsByOwner, dataWins);
    if (!winner) return;
    await deleteRelatedRows(client, descriptor, companyId, identities);
    await client.query(
        `INSERT INTO technician_base_locations
            (company_id, tech_id, technician_uuid, lat, lng, label, address,
             created_at, updated_at, street, apt, city, state, zip)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
            companyId, survivorId, survivorId,
            winner.lat, winner.lng, winner.label, winner.address,
            winner.created_at, winner.updated_at, winner.street, winner.apt,
            winner.city, winner.state, winner.zip,
        ]
    );
}

async function applyTimeOff(client, companyId, survivorId, displayName, timeOff) {
    if (timeOff.duplicateIds.length > 0) {
        await client.query(
            `DELETE FROM technician_time_off
              WHERE company_id = $1 AND id = ANY($2::uuid[])`,
            [companyId, timeOff.duplicateIds]
        );
    }
    if (timeOff.winners.length > 0) {
        await client.query(
            `UPDATE technician_time_off
                SET technician_id = $3,
                    technician_uuid = $4::uuid,
                    technician_name = $5
              WHERE company_id = $1 AND id = ANY($2::uuid[])`,
            [
                companyId,
                timeOff.winners.map(row => row.id),
                survivorId,
                survivorId,
                displayName,
            ]
        );
    }
}

async function applyWorkSchedule(
    client, companyId, survivorId, parentRows, dayRows,
    descriptorByTable, identities, dataWins
) {
    const winner = preferredRow(parentRows, dataWins);
    if (!winner) return;
    const owner = winningOwner(parentRows, dataWins);
    const winningDays = dayRows[owner];
    await deleteRelatedRows(
        client, descriptorByTable.technician_work_schedule_days, companyId, identities
    );
    await deleteRelatedRows(
        client, descriptorByTable.technician_work_schedules, companyId, identities
    );
    await client.query(
        `INSERT INTO technician_work_schedules
            (company_id, technician_id, technician_uuid, inherits_company_schedule,
             created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8)`,
        [
            companyId, survivorId, survivorId, winner.inherits_company_schedule,
            winner.created_by, winner.updated_by, winner.created_at, winner.updated_at,
        ]
    );
    for (const day of winningDays) {
        await client.query(
            `INSERT INTO technician_work_schedule_days
                (company_id, technician_id, technician_uuid, day_of_week,
                 is_working, work_start_time, work_end_time)
             VALUES ($1, $2, $3::uuid, $4, $5, $6, $7)`,
            [
                companyId, survivorId, survivorId, day.day_of_week, day.is_working,
                day.work_start_time, day.work_end_time,
            ]
        );
    }
}

async function applySetTable(
    client, descriptor, companyId, survivorId, identities, rowsByOwner, keyColumn, dataWins
) {
    const winners = setWinners(rowsByOwner, keyColumn, dataWins);
    if (winners.length === 0) return;
    await deleteRelatedRows(client, descriptor, companyId, identities);
    for (const winner of winners) {
        const value = winner[keyColumn];
        if (descriptor.table === 'technician_district_assignments') {
            await client.query(
                `INSERT INTO technician_district_assignments
                    (company_id, technician_id, technician_uuid, district_name, created_by, created_at)
                 VALUES ($1, $2, $3::uuid, $4, $5, $6)`,
                [companyId, survivorId, survivorId, value, winner.created_by, winner.created_at]
            );
        } else {
            await client.query(
                `INSERT INTO technician_radius_assignments
                    (company_id, technician_id, technician_uuid, radius_id, created_by, created_at)
                 VALUES ($1, $2, $3::uuid, $4, $5, $6)`,
                [companyId, survivorId, survivorId, value, winner.created_by, winner.created_at]
            );
        }
    }
}

async function applyWildcard(
    client, descriptor, companyId, survivorId, identities, rowsByOwner, dataWins
) {
    const winner = preferredRow(rowsByOwner, dataWins);
    if (!winner) return;
    await deleteRelatedRows(client, descriptor, companyId, identities);
    await client.query(
        `INSERT INTO technician_area_wildcards
            (company_id, technician_id, technician_uuid, created_by, created_at)
         VALUES ($1, $2, $3::uuid, $4, $5)`,
        [companyId, survivorId, survivorId, winner.created_by, winner.created_at]
    );
}

async function applyJobs(client, companyId, survivorId, displayName, jobs, identities) {
    for (const job of jobs) {
        const assignments = [];
        for (const assignment of job.assigned_techs || []) {
            const id = String(assignment?.id || '');
            assignments.push(identities.allTextIds.has(id)
                ? { ...assignment, id: survivorId, name: displayName }
                : assignment);
        }
        // OB-58: use the established atomic writer. It replaces assigned_techs
        // and derives assigned_provider_user_ids inside the same UPDATE/tx.
        await scheduleQueries.reassignJob(companyId, job.id, assignments, null, client);
    }
}

async function assertNoLoserReferences(client, companyId, identities) {
    const remaining = [];
    for (const descriptor of CONFIG_TABLES) {
        const { rows } = await client.query(
            `SELECT COUNT(*)::int AS count
               FROM ${descriptor.table}
              WHERE company_id = $1
                AND (
                    technician_uuid = $2::uuid
                    OR ${descriptor.textColumn} = ANY($3::text[])
                )`,
            [companyId, identities.loserId, [...identities.loserTextIds]]
        );
        if (Number(rows[0]?.count || 0) > 0) {
            remaining.push(`${descriptor.table}=${rows[0].count}`);
        }
    }
    for (const table of ['rate_tokens', 'technician_ratings']) {
        const { rows } = await client.query(
            `SELECT COUNT(*)::int AS count FROM ${table}
              WHERE company_id = $1 AND tech_id = ANY($2::text[])`,
            [companyId, [...identities.loserTextIds]]
        );
        if (Number(rows[0]?.count || 0) > 0) remaining.push(`${table}=${rows[0].count}`);
    }
    const checks = [
        client.query(
            `SELECT COUNT(*)::int AS count
               FROM technician_external_identities
              WHERE company_id = $1 AND technician_id = $2`,
            [companyId, identities.loserId]
        ),
        client.query(
            `SELECT COUNT(*)::int AS count
               FROM jobs
              WHERE company_id = $1
                AND jsonb_typeof(assigned_techs) = 'array'
                AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(assigned_techs) assignment
                    WHERE assignment->>'id' = ANY($2::text[])
                )`,
            [companyId, [...identities.loserTextIds]]
        ),
    ];
    const [external, jobs] = await Promise.all(checks);
    if (Number(external.rows[0]?.count || 0) > 0) remaining.push('technician_external_identities');
    if (Number(jobs.rows[0]?.count || 0) > 0) remaining.push('jobs.assigned_techs');
    if (remaining.length > 0) {
        throw mergeError(
            'TECHNICIAN_MERGE_REFS_REMAIN',
            `zero loser references assertion failed: ${remaining.join(', ')}`
        );
    }

    // Deliberately exhaustive (not tenant-scoped): the UUID is globally unique.
    // Any cross-tenant native reference is corrupt data and must block tombstoning
    // rather than be hidden by the actor company's filter (lessons L-024).
    const globalRemaining = [];
    for (const descriptor of CONFIG_TABLES) {
        const { rows } = await client.query(
            `SELECT COUNT(*)::int AS count FROM ${descriptor.table}
              WHERE technician_uuid = $1::uuid OR ${descriptor.textColumn} = $1::text`,
            [identities.loserId]
        );
        if (Number(rows[0]?.count || 0) > 0) globalRemaining.push(descriptor.table);
    }
    for (const table of ['rate_tokens', 'technician_ratings']) {
        const { rows } = await client.query(
            `SELECT COUNT(*)::int AS count FROM ${table} WHERE tech_id = $1::text`,
            [identities.loserId]
        );
        if (Number(rows[0]?.count || 0) > 0) globalRemaining.push(table);
    }
    const { rows: globalJobs } = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM jobs
          WHERE jsonb_typeof(assigned_techs) = 'array'
            AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(assigned_techs) assignment
                WHERE assignment->>'id' = $1::text
            )`,
        [identities.loserId]
    );
    if (Number(globalJobs[0]?.count || 0) > 0) globalRemaining.push('jobs.assigned_techs');
    if (globalRemaining.length > 0) {
        throw mergeError(
            'TECHNICIAN_MERGE_CROSS_TENANT_REFERENCE',
            `cross-tenant native loser reference found in ${globalRemaining.join(', ')}`
        );
    }
}

async function applyPlan(client, pair, state, companyId, dataWins) {
    const { identities, rows, jobs, timeOff, plan, discardedData } = state;
    const survivorId = identities.survivorId;
    const descriptorByTable = Object.fromEntries(CONFIG_TABLES.map(row => [row.table, row]));

    await applyProfile(
        client, companyId, survivorId, rows.technician_profiles, dataWins
    );
    await applyBaseLocation(
        client,
        companyId,
        survivorId,
        rows.technician_base_locations,
        descriptorByTable.technician_base_locations,
        identities,
        dataWins
    );
    await applyTimeOff(
        client, companyId, survivorId, pair.effectiveDisplayName, timeOff
    );
    await applyWorkSchedule(
        client,
        companyId,
        survivorId,
        rows.technician_work_schedules,
        rows.technician_work_schedule_days,
        descriptorByTable,
        identities,
        dataWins
    );
    await applySetTable(
        client,
        descriptorByTable.technician_district_assignments,
        companyId,
        survivorId,
        identities,
        rows.technician_district_assignments,
        'district_name',
        dataWins
    );
    await applySetTable(
        client,
        descriptorByTable.technician_radius_assignments,
        companyId,
        survivorId,
        identities,
        rows.technician_radius_assignments,
        'radius_id',
        dataWins
    );
    await applyWildcard(
        client,
        descriptorByTable.technician_area_wildcards,
        companyId,
        survivorId,
        identities,
        rows.technician_area_wildcards,
        dataWins
    );

    await client.query(
        `UPDATE rate_tokens
            SET tech_id = $2, tech_name = $3
          WHERE company_id = $1 AND tech_id = ANY($4::text[])`,
        [companyId, survivorId, pair.effectiveDisplayName, [...identities.allTextIds]]
    );
    await client.query(
        `UPDATE technician_ratings
            SET tech_id = $2
          WHERE company_id = $1 AND tech_id = ANY($3::text[])`,
        [companyId, survivorId, [...identities.allTextIds]]
    );
    await client.query(
        `UPDATE technician_external_identities
            SET technician_id = $2
          WHERE company_id = $1 AND technician_id = $3`,
        [companyId, survivorId, identities.loserId]
    );

    await client.query(
        `UPDATE technicians
            SET display_name = $3
          WHERE company_id = $1 AND id = $2`,
        [companyId, survivorId, pair.effectiveDisplayName]
    );
    if (pair.survivor.crm_user_id) {
        await client.query(
            `UPDATE crm_users user_row
                SET full_name = $3, updated_at = NOW()
              WHERE user_row.id = $2
                AND EXISTS (
                    SELECT 1
                      FROM company_memberships membership
                     WHERE membership.company_id = $1
                       AND membership.user_id = user_row.id
                )`,
            [companyId, pair.survivor.crm_user_id, pair.effectiveDisplayName]
        );
    }
    await applyJobs(
        client, companyId, survivorId, pair.effectiveDisplayName, jobs, identities
    );

    await assertNoLoserReferences(client, companyId, identities);
    const tombstone = await client.query(
        `UPDATE technicians
            SET active = FALSE,
                crm_user_id = NULL,
                merged_into = $3,
                merged_at = NOW()
          WHERE company_id = $1 AND id = $2 AND merged_into IS NULL
          RETURNING id, merged_into, merged_at`,
        [companyId, identities.loserId, survivorId]
    );
    if (tombstone.rowCount !== 1) {
        throw mergeError('TECHNICIAN_MERGE_TOMBSTONE_FAILED', 'loser tombstone update failed');
    }

    const audit = await client.query(
        `INSERT INTO technician_merge_audits
            (company_id, loser_id, survivor_id, data_wins,
             display_name, plan, discarded_data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         RETURNING id, created_at`,
        [
            companyId,
            identities.loserId,
            survivorId,
            dataWins,
            pair.effectiveDisplayName,
            JSON.stringify(plan),
            JSON.stringify(discardedData),
        ]
    );
    return {
        status: 'merged',
        idempotent: false,
        dry_run: false,
        audit_id: audit.rows[0].id,
        plan,
        discarded_data: discardedData,
    };
}

async function mergeInTransaction(client, options) {
    const { companyId, loserId, survivorId, displayName, dryRun, dataWins } = options;
    const { rows } = await client.query(
        `SELECT id, company_id, display_name, active, crm_user_id,
                merged_into, merged_at, created_at
           FROM technicians
          WHERE company_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [companyId, [loserId, survivorId]]
    );
    if (rows.length !== 2) {
        throw mergeError(
            'TECHNICIAN_MERGE_TENANT_MISMATCH',
            'loser and survivor must both exist in the requested company'
        );
    }
    const loser = rows.find(row => normalizedId(row.id) === normalizedId(loserId));
    const survivor = rows.find(row => normalizedId(row.id) === normalizedId(survivorId));
    if (!loser || !survivor) {
        throw mergeError('TECHNICIAN_MERGE_TENANT_MISMATCH', 'technician pair unavailable');
    }
    if (survivor.active !== true || survivor.merged_into) {
        throw mergeError('TECHNICIAN_MERGE_SURVIVOR_INACTIVE', 'survivor must be active and unmerged');
    }
    if (loser.merged_into) {
        if (normalizedId(loser.merged_into) !== normalizedId(survivor.id)) {
            throw mergeError(
                'TECHNICIAN_ALREADY_MERGED',
                `loser is already merged into ${loser.merged_into}`
            );
        }
        const { rows: audits } = await client.query(
            `SELECT id, plan, discarded_data, created_at
               FROM technician_merge_audits
              WHERE company_id = $1 AND loser_id = $2 AND survivor_id = $3`,
            [companyId, loser.id, survivor.id]
        );
        return {
            status: 'noop',
            idempotent: true,
            dry_run: dryRun,
            audit_id: audits[0]?.id || null,
            plan: audits[0]?.plan || null,
            discarded_data: audits[0]?.discarded_data || [],
        };
    }

    const effectiveDisplayName = displayName === undefined
        ? String(survivor.display_name)
        : String(displayName).trim();
    if (!effectiveDisplayName) {
        throw mergeError('TECHNICIAN_MERGE_INVALID_NAME', 'displayName cannot be blank');
    }
    const pair = { loser, survivor, effectiveDisplayName };
    const state = await buildPlan(client, pair, companyId, dataWins, dryRun);
    if (state.conflicts.length > 0 && dataWins === DATA_WINS_FAIL) {
        throw new TechnicianMergeConflictError(state.conflicts, state.plan);
    }
    if (dryRun) {
        return {
            status: 'dry-run',
            idempotent: false,
            dry_run: true,
            audit_id: null,
            plan: state.plan,
            discarded_data: state.discardedData,
        };
    }
    return applyPlan(client, pair, state, companyId, dataWins);
}

/**
 * @param {{companyId:string, loserId:string, survivorId:string,
 *          displayName?:string, dryRun?:boolean,
 *          dataWins?:'fail-closed'|'survivor'|'loser'}} options
 */
async function mergeTechnicians(options = {}) {
    const companyId = String(options.companyId || '').trim();
    const loserId = normalizedId(options.loserId);
    const survivorId = normalizedId(options.survivorId);
    const dryRun = options.dryRun === undefined ? true : options.dryRun === true;
    const dataWins = options.dataWins || DATA_WINS_FAIL;
    if (!companyId || !loserId || !survivorId) {
        throw mergeError(
            'TECHNICIAN_MERGE_INVALID_INPUT',
            'companyId, loserId, and survivorId are required'
        );
    }
    if (loserId === survivorId) {
        throw mergeError('TECHNICIAN_MERGE_SAME_ID', 'loser and survivor must be different');
    }
    if (![DATA_WINS_FAIL, DATA_WINS_SURVIVOR, DATA_WINS_LOSER].includes(dataWins)) {
        throw mergeError(
            'TECHNICIAN_MERGE_INVALID_DATA_POLICY',
            'dataWins must be "fail-closed", "survivor", or "loser"'
        );
    }

    const client = await db.getClient();
    let result;
    try {
        await client.query('BEGIN');
        result = await mergeInTransaction(client, {
            companyId,
            loserId,
            survivorId,
            displayName: options.displayName,
            dryRun,
            dataWins,
        });
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }

    if (!dryRun && result.status === 'merged' && result.discarded_data?.length > 0) {
        console.warn(
            `[TechnicianMerge] dataWins=${result.plan.data_wins} discarded configuration:`,
            JSON.stringify(result.discarded_data)
        );
    }
    return result;
}

module.exports = {
    mergeTechnicians,
    TechnicianMergeConflictError,
    DATA_WINS_FAIL,
    DATA_WINS_SURVIVOR,
    DATA_WINS_LOSER,
    CONFIG_TABLES,
};
