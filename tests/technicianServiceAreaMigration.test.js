const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/technicianServiceAreaQueries');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const RADIUS = '11111111-1111-4111-8111-111111111111';
const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');

describe('migration 184 technician service-area assignments', () => {
    const forward = fs.readFileSync(
        path.join(MIGRATIONS, '184_technician_service_area_assignments.sql'),
        'utf8'
    );
    const rollback = fs.readFileSync(
        path.join(MIGRATIONS, 'rollback_184_technician_service_area_assignments.sql'),
        'utf8'
    );

    it('is replay-safe and keeps district/radius maps independent and tenant-safe', () => {
        expect(forward).toMatch(/CREATE TABLE IF NOT EXISTS technician_district_assignments/);
        expect(forward).toMatch(/CREATE TABLE IF NOT EXISTS technician_radius_assignments/);
        expect(forward).toMatch(/PRIMARY KEY \(company_id, technician_id, district_name\)/);
        expect(forward).toMatch(/PRIMARY KEY \(company_id, technician_id, radius_id\)/);
        expect(forward).toMatch(/UNIQUE \(company_id, id\)/);
        expect(forward).toMatch(/FOREIGN KEY \(company_id, radius_id\)/);
        expect(forward).not.toMatch(/wildcard\s+(?:BOOLEAN|TEXT)/i);
        expect(rollback).toMatch(/DROP TABLE IF EXISTS technician_radius_assignments/);
        expect(rollback).toMatch(/DROP TABLE IF EXISTS technician_district_assignments/);
    });
});

describe('technicianServiceAreaQueries', () => {
    let client;

    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockResolvedValue({ rows: [] });
        client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
        db.getClient.mockResolvedValue(client);
    });

    it('scopes target and valid-assignment reads by company', async () => {
        await queries.listTargets(COMPANY);
        await queries.listValidAssignments(COMPANY);
        expect(db.query).toHaveBeenCalledTimes(4);
        for (const [sql, params] of db.query.mock.calls) {
            expect(String(sql)).toMatch(/company_id = \$1/);
            expect(params).toEqual([COMPANY]);
        }
        const districtRead = db.query.mock.calls.find(([sql]) =>
            /FROM technician_district_assignments/.test(sql));
        expect(districtRead[0]).toMatch(/EXISTS[\s\S]*service_territories/);
    });

    it('replaces one technician district side atomically without touching radii', async () => {
        client.query.mockImplementation(async sql => {
            if (/SELECT DISTINCT area/.test(sql)) return { rows: [{ area: 'North' }] };
            return { rows: [] };
        });
        await queries.replaceTechnicianDistricts(
            COMPANY,
            'tech-1',
            ['North'],
            '00000000-0000-0000-0000-000000000099'
        );
        const sql = client.query.mock.calls.map(call => String(call[0])).join('\n');
        expect(sql).toMatch(/BEGIN[\s\S]*DELETE FROM technician_district_assignments[\s\S]*INSERT INTO technician_district_assignments[\s\S]*COMMIT/);
        expect(sql).not.toMatch(/DELETE FROM technician_radius_assignments/);
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('validates a radius inside the company before a reverse replacement', async () => {
        client.query.mockImplementation(async sql => {
            if (/SELECT id[\s\S]*FROM territory_radii/.test(sql)) return { rows: [{ id: RADIUS }] };
            return { rows: [] };
        });
        await queries.replaceRadiusTechnicians(COMPANY, RADIUS, ['tech-1'], null);
        const validation = client.query.mock.calls.find(([sql]) => /SELECT id[\s\S]*FROM territory_radii/.test(sql));
        expect(validation[0]).toMatch(/WHERE company_id = \$1/);
        expect(validation[1]).toEqual([COMPANY, [RADIUS]]);
        expect(client.query.mock.calls.some(([sql]) => /technician_district_assignments/.test(sql))).toBe(false);
    });

    it('rolls back before deleting assignments when a target is foreign or stale', async () => {
        client.query.mockResolvedValue({ rows: [] });
        await expect(queries.replaceTechnicianDistricts(COMPANY, 'tech-1', ['Missing'], null))
            .rejects.toMatchObject({ code: 'INVALID_SERVICE_AREA_TARGET', httpStatus: 404 });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.query.mock.calls.some(([sql]) => /DELETE FROM technician_district_assignments/.test(sql))).toBe(false);
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});
