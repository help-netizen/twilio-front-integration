'use strict';

jest.mock('googleapis', () => ({ google: { gmail: jest.fn() } }));
jest.mock('../backend/src/db/emailQueries', () => ({}));
jest.mock('../backend/src/services/emailMailboxService', () => ({}));

const {
    classifyGmailMessage,
    pruneIngestedEmailDrafts,
} = require('../backend/src/services/emailDraftPruneService');
const { parseArgs } = require('../backend/src/cli/pruneIngestedEmailDrafts');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const MAILBOX_A = '11111111-1111-1111-1111-111111111111';

function gmailWithGet(implementation) {
    return { users: { messages: { get: jest.fn(implementation) } } };
}

describe('historical Gmail message classifier', () => {
    test('404 is a draft-artifact candidate', async () => {
        const gmail = gmailWithGet(async () => {
            throw Object.assign(new Error('not found'), { code: 404 });
        });

        await expect(classifyGmailMessage(gmail, 'draft-id')).resolves.toEqual({
            isDraftArtifact: true,
            status: 'missing',
            attempts: 1,
        });
    });

    test('200 is retained as a real sent message', async () => {
        const gmail = gmailWithGet(async () => ({ data: { id: 'sent-id' } }));

        await expect(classifyGmailMessage(gmail, 'sent-id')).resolves.toEqual({
            isDraftArtifact: false,
            status: 'exists',
            attempts: 1,
        });
    });

    test('network error fails closed and is not a candidate', async () => {
        const gmail = gmailWithGet(async () => {
            throw new Error('socket reset');
        });

        await expect(classifyGmailMessage(gmail, 'unknown-id')).resolves.toEqual({
            isDraftArtifact: false,
            status: 'error',
            attempts: 1,
            error: 'socket reset',
        });
    });

    test('rate-limit responses use exponential backoff before succeeding', async () => {
        const rateLimit = Object.assign(new Error('quota'), { code: 429 });
        const gmail = gmailWithGet(jest.fn()
            .mockRejectedValueOnce(rateLimit)
            .mockRejectedValueOnce(rateLimit)
            .mockResolvedValueOnce({ data: { id: 'sent-id' } }));
        const wait = jest.fn().mockResolvedValue(undefined);

        const result = await classifyGmailMessage(gmail, 'sent-id', {
            baseBackoffMs: 10,
            sleep: wait,
        });

        expect(result).toEqual({ isDraftArtifact: false, status: 'exists', attempts: 3 });
        expect(wait.mock.calls).toEqual([[10], [20]]);
    });
});

describe('pruneIngestedEmailDrafts', () => {
    function dependencies({ apply = false } = {}) {
        const rows = [
            {
                id: 1,
                provider_message_id: 'missing-id',
                gmail_internal_at: '2026-08-14T12:00:00.000Z',
                body_text_length: 37,
                body_text: 'PRIVATE CUSTOMER MESSAGE MUST NOT BE LOGGED',
            },
            {
                id: 2,
                provider_message_id: 'exists-id',
                gmail_internal_at: '2026-08-14T12:01:00.000Z',
                body_text_length: 80,
            },
            {
                id: 3,
                provider_message_id: 'error-id',
                gmail_internal_at: '2026-08-14T12:02:00.000Z',
                body_text_length: 120,
            },
        ];
        const queries = {
            getMailboxByCompany: jest.fn().mockResolvedValue({
                id: MAILBOX_A,
                company_id: COMPANY_A,
                status: 'connected',
            }),
            listOutboundDraftArtifactCandidates: jest.fn().mockResolvedValue(rows),
            markDraftArtifact: jest.fn().mockResolvedValue(
                apply ? { id: 1, provider_message_id: 'missing-id', is_draft_artifact: true } : null
            ),
        };
        const gmail = gmailWithGet(async ({ id }) => {
            if (id === 'missing-id') throw Object.assign(new Error('gone'), { code: 404 });
            if (id === 'error-id') throw new Error('network down');
            return { data: { id } };
        });
        return {
            gmail,
            emailQueries: queries,
            emailMailboxService: { getValidAccessToken: jest.fn().mockResolvedValue('token') },
            sleep: jest.fn().mockResolvedValue(undefined),
            logger: { log: jest.fn(), warn: jest.fn() },
        };
    }

    test('dry-run is default, honors limit, and never marks candidates', async () => {
        const deps = dependencies();

        const summary = await pruneIngestedEmailDrafts({
            companyId: COMPANY_A,
            limit: 3,
        }, deps);

        expect(deps.emailQueries.listOutboundDraftArtifactCandidates)
            .toHaveBeenCalledWith(COMPANY_A, MAILBOX_A, { limit: 3 });
        expect(deps.emailQueries.markDraftArtifact).not.toHaveBeenCalled();
        expect(summary).toMatchObject({
            company_id: COMPANY_A,
            mailbox_id: MAILBOX_A,
            dry_run: true,
            scanned: 3,
            candidates: 1,
            marked: 0,
            exists: 1,
            errors: 1,
        });
        const candidateLogs = deps.logger.log.mock.calls
            .map(([line]) => line)
            .filter(line => line.includes('[EmailDraftPrune] candidate '));
        expect(candidateLogs).toEqual([
            '[EmailDraftPrune] candidate row_id=1 provider_message_id=missing-id gmail_internal_at=2026-08-14T12:00:00.000Z length(body_text)=37',
        ]);
        expect(candidateLogs.join('\n')).not.toContain('exists-id');
        expect(candidateLogs.join('\n')).not.toContain('error-id');
        expect(deps.logger.log.mock.calls.flat().join('\n'))
            .not.toContain('PRIVATE CUSTOMER MESSAGE MUST NOT BE LOGGED');
    });

    test('--apply marks only the 404 and keeps company+mailbox scope', async () => {
        const deps = dependencies({ apply: true });

        const summary = await pruneIngestedEmailDrafts({
            companyId: COMPANY_A,
            dryRun: false,
            limit: 3,
        }, deps);

        expect(deps.emailQueries.markDraftArtifact)
            .toHaveBeenCalledWith(COMPANY_A, MAILBOX_A, 'missing-id');
        expect(deps.emailQueries.markDraftArtifact).toHaveBeenCalledTimes(1);
        expect(summary.marked).toBe(1);
        expect(summary.errors).toBe(1);
    });
});

describe('prune CLI arguments', () => {
    test('defaults to dry-run and supports --limit N', () => {
        expect(parseArgs(['node', 'cli', '--company-id', COMPANY_A, '--limit', '25']))
            .toEqual({ companyId: COMPANY_A, dryRun: true, limit: 25, help: false });
    });

    test('--apply opts into mutations', () => {
        expect(parseArgs(['node', 'cli', `--company-id=${COMPANY_A}`, '--limit=1', '--apply']))
            .toEqual({ companyId: COMPANY_A, dryRun: false, limit: 1, help: false });
    });
});
