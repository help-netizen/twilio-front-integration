'use strict';

jest.mock('../backend/src/db/connection', () => ({
    pool: { end: jest.fn(async () => {}) },
}));
jest.mock('../backend/src/services/jobTechnicianIdCanonicalizationService', () => ({
    canonicalizeJobTechnicianIds: jest.fn(),
}));

const { parseArgs } = require('../backend/src/cli/canonicalizeJobTechnicianIds');

const COMPANY = '00000000-0000-0000-0000-000000000001';

it('defaults to dry-run and requires --apply for writes', () => {
    expect(parseArgs(['node', 'canonicalizeJobTechnicianIds.js', '--company-id', COMPANY]))
        .toEqual({ companyId: COMPANY, dryRun: true, help: false });
    expect(parseArgs([
        'node',
        'canonicalizeJobTechnicianIds.js',
        `--company-id=${COMPANY}`,
        '--apply',
    ])).toEqual({ companyId: COMPANY, dryRun: false, help: false });
});
