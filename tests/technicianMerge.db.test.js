'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const {
    mergeTechnicians,
    TechnicianMergeConflictError,
} = require('../backend/src/services/technicianMergeService');
const { parseArgs } = require('../backend/src/cli/mergeTechnicians');

jest.setTimeout(60000);

const companyIds = [];
const userIds = [];

async function applyMigration() {
    const sql = fs.readFileSync(path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '255_technician_merge_audit.sql'
    ), 'utf8');
    await db.query(sql);
}

async function seedPair(label, { externalId = null, survivorActive = true } = {}) {
    const companyId = randomUUID();
    const loserId = randomUUID();
    const survivorId = randomUUID();
    const userId = randomUUID();
    const suffix = randomUUID();
    companyIds.push(companyId);
    userIds.push(userId);
    await db.query(
        `INSERT INTO companies (id, name, slug, status, timezone)
         VALUES ($1, $2, $3, 'active', 'America/New_York')`,
        [companyId, `TECH-MERGE ${label}`, `tech-merge-${label.toLowerCase()}-${suffix}`]
    );
    await db.query(
        `INSERT INTO crm_users (id, keycloak_sub, email, full_name, company_id)
         VALUES ($1, $2, $3, 'Aqwin', $4)`,
        [userId, `tech-merge-${suffix}`, `tech-merge-${suffix}@example.test`, companyId]
    );
    await db.query(
        `INSERT INTO company_memberships
            (user_id, company_id, role, role_key, status)
         VALUES ($1, $2, 'company_member', 'provider', 'active')`,
        [userId, companyId]
    );
    await db.query(
        `INSERT INTO technicians
            (id, company_id, display_name, active, crm_user_id)
         VALUES ($1, $3, 'Agshin Legacy', FALSE, NULL),
                ($2, $3, 'Aqwin', $4, $5)`,
        [loserId, survivorId, companyId, survivorActive, userId]
    );
    if (externalId) {
        await db.query(
            `INSERT INTO technician_external_identities
                (company_id, source, external_id, technician_id)
             VALUES ($1, 'zenbooker', $2, $3)`,
            [companyId, externalId, loserId]
        );
    }
    return { companyId, loserId, survivorId, userId, externalId, suffix };
}

async function snapshotCompany(companyId, tables) {
    const snapshot = {};
    for (const table of tables) {
        const { rows } = await db.query(
            `SELECT to_jsonb(row_value) AS value
               FROM ${table} row_value
              WHERE company_id = $1
              ORDER BY to_jsonb(row_value)::text`,
            [companyId]
        );
        snapshot[table] = rows.map(row => row.value);
    }
    return snapshot;
}

async function loserReferenceCount(fixture, table, textColumn) {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS count
           FROM ${table}
          WHERE company_id = $1
            AND (technician_uuid = $2 OR ${textColumn} = ANY($3::text[]))`,
        [fixture.companyId, fixture.loserId, [fixture.loserId, fixture.externalId].filter(Boolean)]
    );
    return rows[0].count;
}

beforeAll(async () => {
    await applyMigration();
});

test('full merge moves every supported reference, deduplicates, mirrors OB-58, and reruns as no-op', async () => {
    const fixture = await seedPair('FULL', { externalId: `zb-full-${randomUUID()}` });
    const { companyId, loserId, survivorId, userId, externalId } = fixture;
    const radiusShared = randomUUID();
    const radiusSurvivor = randomUUID();
    await db.query(
        `INSERT INTO territory_radii
            (id, company_id, zip, lat, lon, radius_miles, position)
         VALUES ($1, $3, '02108', 42.357, -71.064, 10, 0),
                ($2, $3, '02109', 42.360, -71.055, 15, 1)`,
        [radiusShared, radiusSurvivor, companyId]
    );
    await db.query(
        `INSERT INTO technician_profiles
            (company_id, tech_id, technician_uuid, name, photo_storage_key)
         VALUES ($1, $2, $3, 'Legacy public profile', 'tech-merge/legacy-photo.jpg')`,
        [companyId, externalId, loserId]
    );
    await db.query(
        `INSERT INTO technician_base_locations
            (company_id, tech_id, technician_uuid, lat, lng, label, address)
         VALUES ($1, $2, $3, 41, -70, 'LOSER BASE', 'Old address'),
                ($1, $4, $5, 42, -71, 'SURVIVOR BASE', 'Current address')`,
        [companyId, externalId, loserId, survivorId, survivorId]
    );
    await db.query(
        `INSERT INTO technician_time_off
            (company_id, technician_id, technician_uuid, technician_name,
             starts_at, ends_at, note, source)
         VALUES ($1, $2, $3, 'Agshin Legacy', '2026-07-12T12:00:00Z', '2026-07-13T12:00:00Z', 'duplicate loser', 'individual'),
                ($1, $2, $3, 'Agshin Legacy', '2026-09-01T12:00:00Z', '2026-09-02T12:00:00Z', 'loser only', 'individual'),
                ($1, $4, $5, 'Aqwin', '2026-07-12T12:00:00Z', '2026-07-13T12:00:00Z', 'survivor wins duplicate', 'individual')`,
        [companyId, externalId, loserId, survivorId, survivorId]
    );
    await db.query(
        `INSERT INTO technician_work_schedules
            (company_id, technician_id, technician_uuid, inherits_company_schedule)
         VALUES ($1, $2, $3, FALSE)`,
        [companyId, externalId, loserId]
    );
    await db.query(
        `INSERT INTO technician_work_schedule_days
            (company_id, technician_id, technician_uuid, day_of_week,
             is_working, work_start_time, work_end_time)
         VALUES ($1, $2, $3, 1, TRUE, '09:00', '17:00'),
                ($1, $2, $3, 2, FALSE, NULL, NULL)`,
        [companyId, externalId, loserId]
    );
    await db.query(
        `INSERT INTO technician_district_assignments
            (company_id, technician_id, technician_uuid, district_name)
         VALUES ($1, $2, $3, 'North'),
                ($1, $2, $3, 'Shared'),
                ($1, $4, $5, 'South'),
                ($1, $4, $5, 'Shared')`,
        [companyId, externalId, loserId, survivorId, survivorId]
    );
    await db.query(
        `INSERT INTO technician_radius_assignments
            (company_id, technician_id, technician_uuid, radius_id)
         VALUES ($1, $2, $3, $4),
                ($1, $5, $6, $4),
                ($1, $5, $6, $7)`,
        [companyId, externalId, loserId, radiusShared, survivorId, survivorId, radiusSurvivor]
    );
    await db.query(
        `INSERT INTO technician_area_wildcards
            (company_id, technician_id, technician_uuid)
         VALUES ($1, $2, $3), ($1, $4, $5)`,
        [companyId, externalId, loserId, survivorId, survivorId]
    );
    const jobs = await db.query(
        `INSERT INTO jobs (company_id, assigned_techs, assigned_provider_user_ids)
         VALUES ($1, $2::jsonb, '[]'::jsonb), ($1, $3::jsonb, '[]'::jsonb)
         RETURNING id`,
        [
            companyId,
            JSON.stringify([{ id: externalId, name: 'Agshin Legacy' }, { id: 'other-tech', name: 'Other' }]),
            JSON.stringify([{ id: loserId, name: 'Agshin Legacy' }, { id: survivorId, name: 'Aqwin' }]),
        ]
    );
    const token = await db.query(
        `INSERT INTO rate_tokens (company_id, token, job_id, tech_id, tech_name)
         VALUES ($1, $2, $3, $4, 'Agshin Legacy') RETURNING id`,
        [companyId, `tech-merge-token-${randomUUID()}`, jobs.rows[0].id, externalId]
    );
    await db.query(
        `INSERT INTO technician_ratings
            (company_id, rate_token_id, job_id, tech_id, stars, feedback)
         VALUES ($1, $2, $3, $4, 5, 'Great')`,
        [companyId, token.rows[0].id, jobs.rows[0].id, externalId]
    );

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await mergeTechnicians({
        companyId,
        loserId,
        survivorId,
        displayName: 'Agshin',
        dryRun: false,
        dataWins: 'survivor',
    });
    expect(result).toMatchObject({ status: 'merged', idempotent: false, dry_run: false });
    expect(warn).toHaveBeenCalledWith(
        '[TechnicianMerge] dataWins=survivor discarded configuration:',
        expect.stringContaining('LOSER BASE')
    );
    expect(result.plan.references.technician_time_off).toMatchObject({
        loser_rows: 2,
        survivor_rows: 1,
        duplicate_ranges: 1,
    });
    expect(result.plan.references.jobs).toMatchObject({ affected_rows: 2, loser_assignments: 2 });

    for (const [table, textColumn] of [
        ['technician_profiles', 'tech_id'],
        ['technician_base_locations', 'tech_id'],
        ['technician_time_off', 'technician_id'],
        ['technician_work_schedules', 'technician_id'],
        ['technician_work_schedule_days', 'technician_id'],
        ['technician_district_assignments', 'technician_id'],
        ['technician_radius_assignments', 'technician_id'],
        ['technician_area_wildcards', 'technician_id'],
    ]) {
        expect(await loserReferenceCount(fixture, table, textColumn)).toBe(0);
        const canonical = await db.query(
            `SELECT COUNT(*)::int AS count FROM ${table}
              WHERE company_id = $1
                AND technician_uuid = $2
                AND ${textColumn} = $2::text`,
            [companyId, survivorId]
        );
        expect(canonical.rows[0].count).toBeGreaterThan(0);
    }

    const technicianRows = await db.query(
        `SELECT id, display_name, active, crm_user_id, merged_into, merged_at
           FROM technicians WHERE company_id = $1 ORDER BY id`,
        [companyId]
    );
    expect(technicianRows.rows.find(row => row.id === loserId)).toMatchObject({
        active: false,
        crm_user_id: null,
        merged_into: survivorId,
    });
    expect(technicianRows.rows.find(row => row.id === survivorId)).toMatchObject({
        display_name: 'Agshin',
        active: true,
        crm_user_id: userId,
        merged_into: null,
    });
    expect((await db.query('SELECT full_name FROM crm_users WHERE id = $1', [userId])).rows[0].full_name)
        .toBe('Agshin');
    expect((await db.query(
        `SELECT technician_id FROM technician_external_identities
          WHERE company_id = $1 AND external_id = $2`,
        [companyId, externalId]
    )).rows[0].technician_id).toBe(survivorId);

    const profile = (await db.query(
        `SELECT name, photo_storage_key FROM technician_profiles WHERE company_id = $1`,
        [companyId]
    )).rows[0];
    expect(profile).toEqual({
        name: 'Legacy public profile',
        photo_storage_key: 'tech-merge/legacy-photo.jpg',
    });
    expect((await db.query(
        `SELECT label FROM technician_base_locations WHERE company_id = $1 AND technician_uuid = $2`,
        [companyId, survivorId]
    )).rows[0].label).toBe('SURVIVOR BASE');
    const timeOff = await db.query(
        `SELECT technician_name, note FROM technician_time_off
          WHERE company_id = $1 ORDER BY starts_at`,
        [companyId]
    );
    expect(timeOff.rows).toHaveLength(2);
    expect(timeOff.rows.map(row => row.technician_name)).toEqual(['Agshin', 'Agshin']);
    expect(timeOff.rows[0].note).toBe('survivor wins duplicate');
    expect((await db.query(
        `SELECT district_name FROM technician_district_assignments
          WHERE company_id = $1 ORDER BY district_name`,
        [companyId]
    )).rows.map(row => row.district_name)).toEqual(['Shared', 'South']);
    expect((await db.query(
        `SELECT radius_id FROM technician_radius_assignments
          WHERE company_id = $1 ORDER BY radius_id`,
        [companyId]
    )).rows.map(row => row.radius_id).sort()).toEqual([radiusShared, radiusSurvivor].sort());

    const mergedJobs = await db.query(
        `SELECT assigned_techs, assigned_provider_user_ids FROM jobs
          WHERE company_id = $1 ORDER BY id`,
        [companyId]
    );
    expect(mergedJobs.rows[0].assigned_techs).toEqual([
        { id: survivorId, name: 'Agshin' },
        { id: 'other-tech', name: 'Other' },
    ]);
    expect(mergedJobs.rows[1].assigned_techs).toEqual([{ id: survivorId, name: 'Agshin' }]);
    for (const job of mergedJobs.rows) {
        expect(job.assigned_provider_user_ids).toEqual([userId]);
    }
    expect((await db.query(
        `SELECT tech_id, tech_name FROM rate_tokens WHERE company_id = $1`, [companyId]
    )).rows[0]).toEqual({ tech_id: survivorId, tech_name: 'Agshin' });
    expect((await db.query(
        `SELECT tech_id FROM technician_ratings WHERE company_id = $1`, [companyId]
    )).rows[0].tech_id).toBe(survivorId);

    const idempotencyTables = [
        'technicians',
        'technician_merge_audits',
        'technician_external_identities',
        'technician_profiles',
        'technician_base_locations',
        'technician_time_off',
        'technician_work_schedules',
        'technician_work_schedule_days',
        'technician_district_assignments',
        'technician_radius_assignments',
        'technician_area_wildcards',
        'rate_tokens',
        'technician_ratings',
        'jobs',
        'crm_users',
    ];
    const beforeRerun = await snapshotCompany(companyId, idempotencyTables);
    warn.mockClear();
    const rerun = await mergeTechnicians({
        companyId,
        loserId,
        survivorId,
        displayName: 'Ignored on idempotent rerun',
        dryRun: false,
    });
    expect(rerun).toMatchObject({ status: 'noop', idempotent: true });
    expect(warn).not.toHaveBeenCalled();
    expect(await snapshotCompany(companyId, idempotencyTables)).toEqual(beforeRerun);
    warn.mockRestore();
});

test('dry-run returns an exact plan and writes nothing', async () => {
    const fixture = await seedPair('DRY', { externalId: `zb-dry-${randomUUID()}` });
    await db.query(
        `INSERT INTO technician_profiles
            (company_id, tech_id, technician_uuid, name)
         VALUES ($1, $2, $3, 'Dry profile')`,
        [fixture.companyId, fixture.externalId, fixture.loserId]
    );
    await db.query(
        `INSERT INTO jobs (company_id, assigned_techs)
         VALUES ($1, $2::jsonb)`,
        [fixture.companyId, JSON.stringify([{ id: fixture.externalId, name: 'Dry loser' }])]
    );
    const tables = [
        'technicians',
        'technician_external_identities',
        'technician_profiles',
        'jobs',
        'technician_merge_audits',
    ];
    const before = await snapshotCompany(fixture.companyId, tables);
    const result = await mergeTechnicians({
        companyId: fixture.companyId,
        loserId: fixture.loserId,
        survivorId: fixture.survivorId,
        displayName: 'Dry Agshin',
    });
    expect(result).toMatchObject({ status: 'dry-run', dry_run: true, audit_id: null });
    expect(result.plan.references.technician_profiles).toEqual({ loser_rows: 1, survivor_rows: 0 });
    expect(result.plan.references.jobs).toMatchObject({ affected_rows: 1, loser_assignments: 1 });
    expect(result.plan.references.technician_external_identities.loser_rows).toBe(1);
    expect(await snapshotCompany(fixture.companyId, tables)).toEqual(before);
});

test('T-blast preserves a tenant with the same external id and cross-company merge is rejected', async () => {
    const sharedExternal = `zb-shared-${randomUUID()}`;
    const tenantA = await seedPair('TENANT-A', { externalId: sharedExternal });
    const tenantB = await seedPair('TENANT-B', { externalId: sharedExternal });
    await db.query(
        `INSERT INTO technician_base_locations
            (company_id, tech_id, technician_uuid, lat, lng, label)
         VALUES ($1, $2, $3, 10, 11, 'A-ONLY'),
                ($4, $2, NULL, 20, 21, 'B-BYTE-SENTINEL')`,
        [tenantA.companyId, sharedExternal, tenantA.loserId, tenantB.companyId]
    );
    await db.query(
        `INSERT INTO jobs (company_id, assigned_techs)
         VALUES ($1, $2::jsonb), ($3, $4::jsonb)`,
        [
            tenantA.companyId,
            JSON.stringify([{ id: sharedExternal, name: 'A' }]),
            tenantB.companyId,
            JSON.stringify([{ id: sharedExternal, name: 'B-BYTE-SENTINEL' }]),
        ]
    );
    const tables = [
        'technicians',
        'technician_external_identities',
        'technician_base_locations',
        'jobs',
    ];
    const beforeA = await snapshotCompany(tenantA.companyId, tables);
    const beforeB = await snapshotCompany(tenantB.companyId, tables);
    await expect(mergeTechnicians({
        companyId: tenantA.companyId,
        loserId: tenantA.loserId,
        survivorId: tenantB.survivorId,
        dryRun: false,
    })).rejects.toMatchObject({ code: 'TECHNICIAN_MERGE_TENANT_MISMATCH' });
    expect(await snapshotCompany(tenantA.companyId, tables)).toEqual(beforeA);
    expect(await snapshotCompany(tenantB.companyId, tables)).toEqual(beforeB);

    await mergeTechnicians({
        companyId: tenantA.companyId,
        loserId: tenantA.loserId,
        survivorId: tenantA.survivorId,
        displayName: 'Tenant A merged',
        dryRun: false,
    });
    expect(await snapshotCompany(tenantB.companyId, tables)).toEqual(beforeB);
});

test('singleton conflict rolls back everything; survivor data policy reports, logs, and audits lost rows', async () => {
    const fixture = await seedPair('CONFLICT', { externalId: `zb-conflict-${randomUUID()}` });
    await db.query(
        `INSERT INTO technician_profiles
            (company_id, tech_id, technician_uuid, name, photo_storage_key)
         VALUES ($1, $2, $3, 'LOSER PROFILE', 'loser-photo-key'),
                ($1, $4, $5, 'SURVIVOR PROFILE', 'survivor-photo-key')`,
        [
            fixture.companyId,
            fixture.externalId,
            fixture.loserId,
            fixture.survivorId,
            fixture.survivorId,
        ]
    );
    await db.query(
        `INSERT INTO technician_work_schedules
            (company_id, technician_id, technician_uuid, inherits_company_schedule)
         VALUES ($1, $2, $3, FALSE), ($1, $4, $5, TRUE)`,
        [
            fixture.companyId,
            fixture.externalId,
            fixture.loserId,
            fixture.survivorId,
            fixture.survivorId,
        ]
    );
    await db.query(
        `INSERT INTO technician_work_schedule_days
            (company_id, technician_id, technician_uuid, day_of_week,
             is_working, work_start_time, work_end_time)
         VALUES ($1, $2, $3, 1, TRUE, '08:00', '12:00'),
                ($1, $4, $5, 2, TRUE, '10:00', '18:00')`,
        [
            fixture.companyId,
            fixture.externalId,
            fixture.loserId,
            fixture.survivorId,
            fixture.survivorId,
        ]
    );
    await db.query(
        `INSERT INTO jobs (company_id, assigned_techs)
         VALUES ($1, $2::jsonb)`,
        [fixture.companyId, JSON.stringify([{ id: fixture.externalId, name: 'Loser' }])]
    );
    const tables = [
        'technicians',
        'technician_external_identities',
        'technician_profiles',
        'technician_work_schedules',
        'technician_work_schedule_days',
        'jobs',
        'technician_merge_audits',
    ];
    const before = await snapshotCompany(fixture.companyId, tables);
    let conflict;
    try {
        await mergeTechnicians({
            companyId: fixture.companyId,
            loserId: fixture.loserId,
            survivorId: fixture.survivorId,
            displayName: 'Agshin',
            dryRun: false,
        });
    } catch (error) {
        conflict = error;
    }
    expect(conflict).toBeInstanceOf(TechnicianMergeConflictError);
    expect(conflict.message).toContain('technician_profiles');
    expect(conflict.message).toContain('technician_work_schedules');
    expect(conflict.message).toContain(fixture.loserId);
    expect(conflict.message).toContain(fixture.survivorId);
    expect(conflict.plan.status).toBe('blocked');
    expect(await snapshotCompany(fixture.companyId, tables)).toEqual(before);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await mergeTechnicians({
        companyId: fixture.companyId,
        loserId: fixture.loserId,
        survivorId: fixture.survivorId,
        displayName: 'Agshin',
        dryRun: false,
        dataWins: 'survivor',
    });
    expect(result.discarded_data).toHaveLength(2);
    expect(result.discarded_data.find(loss => loss.table === 'technician_profiles')).toMatchObject({
        table: 'technician_profiles',
        winning_owner: 'survivor',
        discarded_rows: [expect.objectContaining({
            name: 'LOSER PROFILE',
            photo_storage_key: 'loser-photo-key',
        })],
    });
    expect(result.discarded_data.find(loss => loss.table === 'technician_work_schedules'))
        .toMatchObject({
            winning_owner: 'survivor',
            discarded_rows: [expect.objectContaining({ inherits_company_schedule: false })],
            discarded_child_rows: [expect.objectContaining({
                day_of_week: 1,
                work_start_time: '08:00:00',
                work_end_time: '12:00:00',
            })],
        });
    expect(warn).toHaveBeenCalledWith(
        '[TechnicianMerge] dataWins=survivor discarded configuration:',
        expect.stringContaining('loser-photo-key')
    );
    warn.mockRestore();
    const profiles = await db.query(
        `SELECT tech_id, technician_uuid, name, photo_storage_key
           FROM technician_profiles WHERE company_id = $1`,
        [fixture.companyId]
    );
    expect(profiles.rows).toEqual([{
        tech_id: fixture.survivorId,
        technician_uuid: fixture.survivorId,
        name: 'SURVIVOR PROFILE',
        photo_storage_key: 'survivor-photo-key',
    }]);
    expect((await db.query(
        `SELECT inherits_company_schedule
           FROM technician_work_schedules WHERE company_id = $1`,
        [fixture.companyId]
    )).rows).toEqual([{ inherits_company_schedule: true }]);
    expect((await db.query(
        `SELECT day_of_week, is_working, work_start_time, work_end_time
           FROM technician_work_schedule_days WHERE company_id = $1`,
        [fixture.companyId]
    )).rows).toEqual([{
        day_of_week: 2,
        is_working: true,
        work_start_time: '10:00:00',
        work_end_time: '18:00:00',
    }]);
    const audit = await db.query(
        `SELECT data_wins, discarded_data
           FROM technician_merge_audits WHERE company_id = $1`,
        [fixture.companyId]
    );
    expect(audit.rows[0].data_wins).toBe('survivor');
    expect(audit.rows[0].discarded_data).toEqual(result.discarded_data);
});

test('loser data policy overwrites base/profile while preserving the survivor master account', async () => {
    const fixture = await seedPair('LOSER-WINS', {
        externalId: `zb-loser-wins-${randomUUID()}`,
    });
    await db.query(
        `INSERT INTO technician_profiles
            (company_id, tech_id, technician_uuid, name, photo_storage_key)
         VALUES ($1, $2, $3, 'AGSHIN PROFILE', 'agshin-photo-key'),
                ($1, $4, $5, 'AQWIN DEFAULT PROFILE', 'aqwin-default-photo-key')`,
        [
            fixture.companyId,
            fixture.externalId,
            fixture.loserId,
            fixture.survivorId,
            fixture.survivorId,
        ]
    );
    await db.query(
        `INSERT INTO technician_base_locations
            (company_id, tech_id, technician_uuid, lat, lng, label, address)
         VALUES ($1, $2, $3, 40.100, -70.100, 'AGSHIN BASE', 'Agshin address'),
                ($1, $4, $5, 41.200, -71.200, 'AQWIN DEFAULT BASE', 'Aqwin address')`,
        [
            fixture.companyId,
            fixture.externalId,
            fixture.loserId,
            fixture.survivorId,
            fixture.survivorId,
        ]
    );
    await db.query(
        `INSERT INTO technician_time_off
            (company_id, technician_id, technician_uuid, technician_name,
             starts_at, ends_at, note, source)
         VALUES ($1, $2, $3, 'Agshin', '2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z', 'AGSHIN TIME OFF', 'individual'),
                ($1, $4, $5, 'Aqwin', '2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z', 'AQWIN DEFAULT TIME OFF', 'individual')`,
        [
            fixture.companyId,
            fixture.externalId,
            fixture.loserId,
            fixture.survivorId,
            fixture.survivorId,
        ]
    );
    await db.query(
        `INSERT INTO technician_district_assignments
            (company_id, technician_id, technician_uuid, district_name)
         VALUES ($1, $2, $3, 'AGSHIN ZONE'),
                ($1, $4, $5, 'AQWIN DEFAULT ZONE')`,
        [
            fixture.companyId,
            fixture.externalId,
            fixture.loserId,
            fixture.survivorId,
            fixture.survivorId,
        ]
    );
    const accountBefore = (await db.query(
        `SELECT id, keycloak_sub, email, company_id
           FROM crm_users WHERE id = $1`,
        [fixture.userId]
    )).rows[0];
    const membershipBefore = (await db.query(
        `SELECT user_id, company_id, role, role_key, status
           FROM company_memberships
          WHERE user_id = $1 AND company_id = $2`,
        [fixture.userId, fixture.companyId]
    )).rows[0];

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await mergeTechnicians({
        companyId: fixture.companyId,
        loserId: fixture.loserId,
        survivorId: fixture.survivorId,
        displayName: 'Agshin',
        dryRun: false,
        dataWins: 'loser',
    });
    expect(result).toMatchObject({
        status: 'merged',
        plan: { data_wins: 'loser' },
    });
    expect(result.discarded_data).toEqual(expect.arrayContaining([
        expect.objectContaining({
            table: 'technician_profiles',
            winning_owner: 'loser',
            discarded_rows: [expect.objectContaining({
                name: 'AQWIN DEFAULT PROFILE',
                photo_storage_key: 'aqwin-default-photo-key',
            })],
        }),
        expect.objectContaining({
            table: 'technician_base_locations',
            winning_owner: 'loser',
            discarded_rows: [expect.objectContaining({
                label: 'AQWIN DEFAULT BASE',
                address: 'Aqwin address',
            })],
        }),
        expect.objectContaining({
            table: 'technician_time_off',
            winning_owner: 'loser',
            discarded_rows: [expect.objectContaining({ note: 'AQWIN DEFAULT TIME OFF' })],
        }),
        expect.objectContaining({
            table: 'technician_district_assignments',
            winning_owner: 'loser',
            discarded_rows: [expect.objectContaining({ district_name: 'AQWIN DEFAULT ZONE' })],
        }),
    ]));
    expect(warn).toHaveBeenCalledWith(
        '[TechnicianMerge] dataWins=loser discarded configuration:',
        expect.stringContaining('AQWIN DEFAULT BASE')
    );
    warn.mockRestore();

    expect((await db.query(
        `SELECT tech_id, technician_uuid, name, photo_storage_key
           FROM technician_profiles WHERE company_id = $1`,
        [fixture.companyId]
    )).rows).toEqual([{
        tech_id: fixture.survivorId,
        technician_uuid: fixture.survivorId,
        name: 'AGSHIN PROFILE',
        photo_storage_key: 'agshin-photo-key',
    }]);
    expect((await db.query(
        `SELECT tech_id, technician_uuid, lat, lng, label, address
           FROM technician_base_locations WHERE company_id = $1`,
        [fixture.companyId]
    )).rows).toEqual([{
        tech_id: fixture.survivorId,
        technician_uuid: fixture.survivorId,
        lat: 40.1,
        lng: -70.1,
        label: 'AGSHIN BASE',
        address: 'Agshin address',
    }]);
    expect((await db.query(
        `SELECT technician_id, technician_uuid, technician_name, note
           FROM technician_time_off WHERE company_id = $1`,
        [fixture.companyId]
    )).rows).toEqual([{
        technician_id: fixture.survivorId,
        technician_uuid: fixture.survivorId,
        technician_name: 'Agshin',
        note: 'AGSHIN TIME OFF',
    }]);
    expect((await db.query(
        `SELECT technician_id, technician_uuid, district_name
           FROM technician_district_assignments WHERE company_id = $1`,
        [fixture.companyId]
    )).rows).toEqual([{
        technician_id: fixture.survivorId,
        technician_uuid: fixture.survivorId,
        district_name: 'AGSHIN ZONE',
    }]);

    const survivor = (await db.query(
        `SELECT id, active, crm_user_id, display_name
           FROM technicians WHERE company_id = $1 AND id = $2`,
        [fixture.companyId, fixture.survivorId]
    )).rows[0];
    expect(survivor).toEqual({
        id: fixture.survivorId,
        active: true,
        crm_user_id: fixture.userId,
        display_name: 'Agshin',
    });
    const accountAfter = (await db.query(
        `SELECT id, keycloak_sub, email, company_id
           FROM crm_users WHERE id = $1`,
        [fixture.userId]
    )).rows[0];
    expect(accountAfter).toEqual(accountBefore);
    expect((await db.query(
        `SELECT user_id, company_id, role, role_key, status
           FROM company_memberships
          WHERE user_id = $1 AND company_id = $2`,
        [fixture.userId, fixture.companyId]
    )).rows[0]).toEqual(membershipBefore);

    const audit = (await db.query(
        `SELECT data_wins, discarded_data
           FROM technician_merge_audits WHERE company_id = $1`,
        [fixture.companyId]
    )).rows[0];
    expect(audit.data_wins).toBe('loser');
    expect(audit.discarded_data).toEqual(result.discarded_data);
});

test('guards reject a same-id merge and an inactive survivor', async () => {
    const fixture = await seedPair('GUARDS', { survivorActive: false });
    await expect(mergeTechnicians({
        companyId: fixture.companyId,
        loserId: fixture.loserId,
        survivorId: fixture.loserId,
        dryRun: false,
    })).rejects.toMatchObject({ code: 'TECHNICIAN_MERGE_SAME_ID' });
    await expect(mergeTechnicians({
        companyId: fixture.companyId,
        loserId: fixture.loserId,
        survivorId: fixture.survivorId,
        dryRun: false,
    })).rejects.toMatchObject({ code: 'TECHNICIAN_MERGE_SURVIVOR_INACTIVE' });
});

test('CLI defaults to dry-run/fail-closed and requires an explicit data winner opt-in', () => {
    const base = [
        'node',
        'mergeTechnicians.js',
        '--company-id',
        randomUUID(),
        '--loser-id',
        randomUUID(),
        '--survivor-id',
        randomUUID(),
    ];
    expect(parseArgs(base)).toMatchObject({ dryRun: true, dataWins: 'fail-closed' });
    expect(parseArgs([...base, '--apply', '--survivor-wins'])).toMatchObject({
        dryRun: false,
        dataWins: 'survivor',
    });
    expect(parseArgs([...base, '--apply', '--data-wins', 'loser'])).toMatchObject({
        dryRun: false,
        dataWins: 'loser',
    });
});

afterAll(async () => {
    try {
        for (const companyId of companyIds) {
            await db.query('DELETE FROM jobs WHERE company_id = $1', [companyId]);
            await db.query('DELETE FROM rate_tokens WHERE company_id = $1', [companyId]);
        }
        if (userIds.length > 0) {
            await db.query('DELETE FROM crm_users WHERE id = ANY($1::uuid[])', [userIds]);
        }
        for (const companyId of companyIds) {
            await db.query('DELETE FROM companies WHERE id = $1', [companyId]);
        }
    } finally {
        await db.pool.end().catch(() => {});
    }
});
