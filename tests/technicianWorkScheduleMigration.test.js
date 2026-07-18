const fs = require('fs');
const path = require('path');

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/technicianWorkScheduleQueries');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const MIGRATIONS = path.join(__dirname, '..', 'backend', 'db', 'migrations');

describe('migration 183 recurring technician schedules', () => {
    const forward = fs.readFileSync(path.join(MIGRATIONS, '183_technician_work_schedules.sql'), 'utf8');
    const rollback = fs.readFileSync(path.join(MIGRATIONS, 'rollback_183_technician_work_schedules.sql'), 'utf8');

    it('is replay-safe and enforces tenant keys plus valid day/time shape', () => {
        expect(forward).toMatch(/CREATE TABLE IF NOT EXISTS technician_work_schedules/);
        expect(forward).toMatch(/PRIMARY KEY \(company_id, technician_id\)/);
        expect(forward).toMatch(/day_of_week BETWEEN 0 AND 6/);
        expect(forward).toMatch(/work_start_time < work_end_time/);
        expect(forward).toMatch(/FOREIGN KEY \(company_id, technician_id\)/);
        expect(forward).toMatch(/REFERENCES crm_users\(id\)/);
        expect(rollback).toMatch(/DROP TABLE IF EXISTS technician_work_schedule_days/);
        expect(rollback).toMatch(/DROP TABLE IF EXISTS technician_work_schedules/);
    });
});

describe('technicianWorkScheduleQueries', () => {
    let client;

    beforeEach(() => {
        jest.clearAllMocks();
        db.query.mockResolvedValue({ rows: [] });
        client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
        db.getClient.mockResolvedValue(client);
    });

    it('scopes schedule reads by company and active technician ids', async () => {
        await queries.listByTechnicianIds(COMPANY, ['tech-1', 'tech-2']);
        expect(db.query).toHaveBeenCalledWith(
            expect.stringMatching(/WHERE s\.company_id = \$1[\s\S]*s\.technician_id = ANY\(\$2::text\[\]\)/),
            [COMPANY, ['tech-1', 'tech-2']]
        );
    });

    it('atomically replaces all seven custom days', async () => {
        const days = Array.from({ length: 7 }, (_, day) => ({
            day_of_week: day,
            is_working: day > 0 && day < 6,
            work_start_time: day > 0 && day < 6 ? '08:00' : null,
            work_end_time: day > 0 && day < 6 ? '17:00' : null,
        }));
        await queries.replace(COMPANY, 'tech-1', {
            inheritsCompanySchedule: false,
            days,
            updatedBy: '00000000-0000-0000-0000-000000000099',
        });

        expect(client.query.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
            'BEGIN',
            expect.stringContaining('INSERT INTO technician_work_schedules'),
            expect.stringContaining('DELETE FROM technician_work_schedule_days'),
            expect.stringContaining('INSERT INTO technician_work_schedule_days'),
            'COMMIT',
        ]));
        const insertDays = client.query.mock.calls.find(call => /INSERT INTO technician_work_schedule_days/.test(call[0]));
        expect(insertDays[1]).toHaveLength(30); // company + tech + 7×4 day values
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('retains saved custom rows when inheritance is enabled', async () => {
        await queries.replace(COMPANY, 'tech-1', {
            inheritsCompanySchedule: true,
            days: [],
            updatedBy: null,
        });
        expect(client.query.mock.calls.some(call => /DELETE FROM technician_work_schedule_days/.test(call[0]))).toBe(false);
        expect(client.query.mock.calls.some(call => /INSERT INTO technician_work_schedule_days/.test(call[0]))).toBe(false);
        expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    });

    it('rolls back and releases the client on a failed replacement', async () => {
        client.query.mockImplementation(async sql => {
            if (/INSERT INTO technician_work_schedules/.test(sql)) throw new Error('write failed');
            return { rows: [] };
        });
        await expect(queries.replace(COMPANY, 'tech-1', {
            inheritsCompanySchedule: true,
            days: [],
            updatedBy: null,
        })).rejects.toThrow('write failed');
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});
