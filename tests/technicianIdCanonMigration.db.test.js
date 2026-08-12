'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');

jest.setTimeout(60000);

const migration256 = fs.readFileSync(path.join(
    __dirname, '..', 'backend', 'db', 'migrations',
    '256_technician_uuid_constraints.sql'
), 'utf8');
const migration257 = fs.readFileSync(path.join(
    __dirname, '..', 'backend', 'db', 'migrations',
    '257_drop_legacy_technician_keys.sql'
), 'utf8');
const rollback257 = fs.readFileSync(path.join(
    __dirname, '..', 'backend', 'db', 'migrations',
    'rollback_257_drop_legacy_technician_keys.sql'
), 'utf8');
const rollback256 = fs.readFileSync(path.join(
    __dirname, '..', 'backend', 'db', 'migrations',
    'rollback_256_technician_uuid_constraints.sql'
), 'utf8');

const prerequisiteFiles = [
    '123_create_technician_profiles.sql',
    '125_create_technician_base_locations.sql',
    '135_base_location_structured_address.sql',
    '167_technician_time_off.sql',
    '183_technician_work_schedules.sql',
    '184_technician_service_area_assignments.sql',
    '239_technician_serves_all_territory.sql',
    '241_native_technician_directory.sql',
];
const prerequisites = prerequisiteFiles.map(file => fs.readFileSync(path.join(
    __dirname, '..', 'backend', 'db', 'migrations', file
), 'utf8'));

async function prepareLegacySchema(client) {
    const schema = `tech_id_canon_${randomUUID().replace(/-/g, '')}`;
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(`
        CREATE TABLE companies (id UUID PRIMARY KEY);
        CREATE TABLE crm_users (id UUID PRIMARY KEY);
        CREATE TABLE company_memberships (
            user_id UUID NOT NULL,
            company_id UUID NOT NULL,
            UNIQUE (user_id, company_id)
        );
        CREATE TABLE territory_radii (
            id UUID PRIMARY KEY,
            company_id UUID NOT NULL,
            zip TEXT,
            radius_miles NUMERIC,
            lat DOUBLE PRECISION,
            lon DOUBLE PRECISION,
            position INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    for (const sql of prerequisites) await client.query(sql);
    return schema;
}

describe('TECH-ID-CANON T3/T4 migrations against real PostgreSQL', () => {
    test('validates eight FKs, enforces seven NOT NULLs, and preserves the company base', async () => {
        const client = await db.getClient();
        const companyId = randomUUID();
        const technicianId = randomUUID();
        try {
            const schema = await prepareLegacySchema(client);
            await client.query(
                'INSERT INTO companies (id) VALUES ($1)',
                [companyId]
            );
            await client.query(
                `INSERT INTO technicians (id, company_id, display_name, active)
                 VALUES ($1, $2, 'Migration Technician', TRUE)`,
                [technicianId, companyId]
            );
            await client.query(
                `INSERT INTO technician_base_locations
                    (company_id, tech_id, technician_uuid, lat, lng, label)
                 VALUES ($1, '__company__', NULL, 42.1, -71.1, 'Company base')`,
                [companyId]
            );

            await client.query(migration256);

            const constraints = await client.query(
                `SELECT conname, convalidated
                 FROM pg_constraint
                 WHERE connamespace = $2::regnamespace
                   AND conname = ANY($1::text[])
                 ORDER BY conname`,
                [[
                    'technician_profiles_native_fk',
                    'technician_base_locations_native_fk',
                    'technician_time_off_native_fk',
                    'technician_work_schedules_native_fk',
                    'technician_work_schedule_days_native_fk',
                    'technician_district_assignments_native_fk',
                    'technician_radius_assignments_native_fk',
                    'technician_area_wildcards_native_fk',
                ], schema]
            );
            expect(constraints.rows).toHaveLength(8);
            expect(constraints.rows.every(row => row.convalidated)).toBe(true);

            const nullable = await client.query(
                `SELECT table_name, is_nullable
                 FROM information_schema.columns
                 WHERE table_schema = $2
                   AND column_name = 'technician_uuid'
                   AND table_name = ANY($1::text[])
                 ORDER BY table_name`,
                [[
                    'technician_profiles',
                    'technician_time_off',
                    'technician_work_schedules',
                    'technician_work_schedule_days',
                    'technician_district_assignments',
                    'technician_radius_assignments',
                    'technician_area_wildcards',
                ], schema]
            );
            expect(nullable.rows).toHaveLength(7);
            expect(nullable.rows.every(row => row.is_nullable === 'NO')).toBe(true);

            const companyBase = await client.query(
                `SELECT id, is_company_default, technician_uuid, label
                 FROM technician_base_locations
                 WHERE company_id = $1 AND is_company_default = TRUE`,
                [companyId]
            );
            expect(companyBase.rows).toEqual([expect.objectContaining({
                id: expect.any(String),
                is_company_default: true,
                technician_uuid: null,
                label: 'Company base',
            })]);

            await expect(client.query(
                `INSERT INTO technician_profiles (company_id, tech_id, technician_uuid, name)
                 VALUES ($1, 'must-fail', NULL, 'Invalid')`,
                [companyId]
            )).rejects.toMatchObject({ code: '23502' });
            await client.query('ROLLBACK');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    });

    test('T4 removes all eight legacy TEXT keys after T3', async () => {
        const client = await db.getClient();
        try {
            const schema = await prepareLegacySchema(client);
            await client.query(migration256);
            await client.query(migration257);
            const columns = await client.query(
                `SELECT table_name, column_name
                 FROM information_schema.columns
                 WHERE table_schema = $1
                   AND (table_name, column_name) IN (
                       ('technician_profiles', 'tech_id'),
                       ('technician_base_locations', 'tech_id'),
                       ('technician_time_off', 'technician_id'),
                       ('technician_work_schedules', 'technician_id'),
                       ('technician_work_schedule_days', 'technician_id'),
                       ('technician_district_assignments', 'technician_id'),
                       ('technician_radius_assignments', 'technician_id'),
                       ('technician_area_wildcards', 'technician_id')
                   )`,
                [schema]
            );
            expect(columns.rows).toEqual([]);
            await client.query('ROLLBACK');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    });

    test('matching rollbacks restore the Phase-A dual-key schema', async () => {
        const client = await db.getClient();
        try {
            const schema = await prepareLegacySchema(client);
            await client.query(migration256);
            await client.query(migration257);
            await client.query(rollback257);
            await client.query(rollback256);

            const legacyColumns = await client.query(
                `SELECT table_name, column_name, is_nullable
                 FROM information_schema.columns
                 WHERE table_schema = $1
                   AND (table_name, column_name) IN (
                       ('technician_profiles', 'tech_id'),
                       ('technician_base_locations', 'tech_id'),
                       ('technician_time_off', 'technician_id'),
                       ('technician_work_schedules', 'technician_id'),
                       ('technician_work_schedule_days', 'technician_id'),
                       ('technician_district_assignments', 'technician_id'),
                       ('technician_radius_assignments', 'technician_id'),
                       ('technician_area_wildcards', 'technician_id')
                   )
                 ORDER BY table_name`,
                [schema]
            );
            expect(legacyColumns.rows).toHaveLength(8);
            expect(legacyColumns.rows.every(row => row.is_nullable === 'NO')).toBe(true);

            const t3Columns = await client.query(
                `SELECT column_name
                 FROM information_schema.columns
                 WHERE table_schema = $1
                   AND table_name = 'technician_base_locations'
                   AND column_name = ANY($2::text[])`,
                [schema, ['id', 'is_company_default']]
            );
            expect(t3Columns.rows).toEqual([]);

            const nativeFks = await client.query(
                `SELECT convalidated
                 FROM pg_constraint
                 WHERE connamespace = $1::regnamespace
                   AND conname = ANY($2::text[])`,
                [schema, [
                    'technician_profiles_native_fk',
                    'technician_base_locations_native_fk',
                    'technician_time_off_native_fk',
                    'technician_work_schedules_native_fk',
                    'technician_work_schedule_days_native_fk',
                    'technician_district_assignments_native_fk',
                    'technician_radius_assignments_native_fk',
                    'technician_area_wildcards_native_fk',
                ]]
            );
            expect(nativeFks.rows).toHaveLength(8);
            expect(nativeFks.rows.every(row => row.convalidated === false)).toBe(true);
            await client.query('ROLLBACK');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    });
});

afterAll(async () => {
    try { await db.pool.end(); } catch (_) { /* already closed */ }
});
