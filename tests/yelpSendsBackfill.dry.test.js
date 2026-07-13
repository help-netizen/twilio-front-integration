'use strict';

/**
 * YELP-CONVO-CONTEXT-002 — owner backfill dry-run, CLI, and structural cases.
 *
 * Run:
 *   node --use-bundled-ca <repo>/node_modules/jest/bin/jest.js \
 *     tests/yelpSendsBackfill.dry.test.js --rootDir . \
 *     --testPathIgnorePatterns "/node_modules/" --forceExit
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockPoolEnd = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: mockQuery,
    pool: { connect: mockConnect, end: mockPoolEnd },
}));

const { runBackfill, parseCliArgs } = require('../backend/scripts/yelp_agent_sends_backfill');
const { sanitizeEntry } = require('../backend/src/services/yelpConvoHistory');
const { DEFAULT_COMPANY_ID } = require('./yelpFixtures');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yelp-sends-backfill-dry-'));
const fakeLogger = { log: jest.fn(), warn: jest.fn() };

let anchors;
let candidates;

function anchor(threadId, timelineId, convId, displayName) {
    return {
        thread_id: threadId,
        timeline_id: timelineId,
        yelp_conversation_id: convId,
        display_name: displayName,
    };
}

function candidate(id, threadId, overrides = {}) {
    return {
        id,
        provider_message_id: `sent-${id}`,
        thread_id: threadId,
        subject: `Subject ${id}`,
        gmail_internal_at: new Date(`2026-07-11T${String(id - 891).padStart(2, '0')}:00:00.000Z`),
        body_text: `Agent message ${id}`,
        snippet: `Snippet ${id}`,
        ...overrides,
    };
}

function allLogLines() {
    return [
        ...fakeLogger.log.mock.calls.map(call => call.join(' ')),
        ...fakeLogger.warn.mock.calls.map(call => call.join(' ')),
    ];
}

beforeEach(() => {
    jest.clearAllMocks();
    anchors = [
        anchor(77, 3207, '9Xk2mZ7bQ1', 'Kim L.'),
        anchor(78, 3208, '7Yr4nP2wT9', 'Jenna R.'),
    ];
    candidates = [
        candidate(901, 77),
        candidate(902, 77, { body_text: 'Bounced agent reply' }),
        candidate(903, 78, {
            body_text: `${'A'.repeat(200)}\nOn Sat, Jul 11, 2026 at 9:39 PM Kim L. <reply+x@messaging.yelp.com> wrote:\n> old`,
            snippet: 'long sent message',
        }),
    ];

    mockQuery.mockImplementation(async (sql, params) => {
        if (/SELECT DISTINCT em\.thread_id/i.test(sql)
            && /JOIN timelines tl/i.test(sql)) {
            expect(params).toEqual([DEFAULT_COMPANY_ID]);
            return { rows: anchors };
        }
        if (/FROM email_messages em/i.test(sql)
            && /direction = 'outbound'/i.test(sql)
            && /timeline_id IS NULL/i.test(sql)) {
            expect(params[0]).toBe(DEFAULT_COMPANY_ID);
            return { rows: candidates };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    });

    mockClientQuery.mockImplementation(async (sql, params) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
        if (/UPDATE email_messages/i.test(sql)) {
            return { rows: params[1].map(id => ({ id })), rowCount: params[1].length };
        }
        throw new Error(`Unexpected client SQL: ${sql}`);
    });
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
});

afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('Yelp agent sends backfill · dry-run / CLI / structural', () => {
    it('TC-C1-01 · default dry-run snapshots all candidates, previews the plan, and writes zero rows', async () => {
        const snapshotDir = path.join(tempRoot, 'c1');
        const out = await runBackfill({
            companyId: DEFAULT_COMPANY_ID,
            snapshotDir,
            logger: fakeLogger,
        });

        expect(out).toMatchObject({
            companyId: DEFAULT_COMPANY_ID,
            dryRun: true,
            linked: 0,
            conflictThreadIds: [],
            residueOutbound: 0,
        });
        expect(out.threads).toHaveLength(2);
        expect(out.threads[0]).toMatchObject({
            threadId: 77,
            timelineId: 3207,
            convId: '9Xk2mZ7bQ1',
            displayName: 'Kim L.',
        });
        expect(out.threads[0].messages).toHaveLength(2);
        expect(out.threads[1].messages).toHaveLength(1);

        const preview903 = out.threads[1].messages.find(message => message.id === 903).preview;
        expect(preview903).toBe(sanitizeEntry(candidates[2].body_text, {
            snippet: candidates[2].snippet,
        }, 80));
        expect(preview903).not.toContain('wrote:');

        expect(out.snapshotFile).toBeTruthy();
        expect(fs.existsSync(out.snapshotFile)).toBe(true);
        const snapshot = JSON.parse(fs.readFileSync(out.snapshotFile, 'utf8'));
        expect(snapshot.email_messages.map(message => message.id)).toEqual([901, 902, 903]);

        const lines = allLogLines();
        expect(lines[0]).toMatch(/snapshot written:/);
        expect(lines).toEqual(expect.arrayContaining([
            expect.stringContaining('conv=9Xk2mZ7bQ1 timeline=3207 name=Kim L.'),
            expect.stringMatching(/id=901 pmid=sent-901 at=.* subj=Subject 901 preview=/),
        ]));
        expect(mockQuery.mock.calls.some(([sql]) => /UPDATE email_messages/i.test(sql))).toBe(false);
        expect(mockClientQuery.mock.calls.some(([sql]) => /UPDATE email_messages/i.test(sql))).toBe(false);
        expect(mockConnect).not.toHaveBeenCalled();
    });

    it('TC-C3-01 · a multi-timeline thread is skipped, warned, and counted as residue', async () => {
        anchors = [
            anchor(77, 3207, '9Xk2mZ7bQ1', 'Kim L.'),
            anchor(79, 3210, 'conflict-a', 'Conflict A'),
            anchor(79, 3213, 'conflict-b', 'Conflict B'),
        ];
        candidates = [candidate(904, 77), candidate(905, 79), candidate(906, 79)];

        const dry = await runBackfill({
            companyId: DEFAULT_COMPANY_ID,
            dryRun: true,
            snapshotDir: path.join(tempRoot, 'c3-dry'),
            logger: fakeLogger,
        });
        expect(dry.conflictThreadIds).toEqual([79]);
        expect(dry.threads.map(thread => thread.threadId)).toEqual([77]);
        expect(dry.residueOutbound).toBe(2);
        expect(fakeLogger.warn).toHaveBeenCalledWith(expect.stringContaining('thread=79'));

        const applied = await runBackfill({
            companyId: DEFAULT_COMPANY_ID,
            dryRun: false,
            snapshotDir: path.join(tempRoot, 'c3-apply'),
            logger: fakeLogger,
        });
        expect(applied.linked).toBe(1);
        const updateCall = mockClientQuery.mock.calls.find(([sql]) => /UPDATE email_messages/i.test(sql));
        expect(updateCall).toBeDefined();
        expect(updateCall[1]).toEqual([DEFAULT_COMPANY_ID, [904], 3207]);
        expect(updateCall[0]).toMatch(/WHERE company_id = \$1/i);
        expect(updateCall[0]).toMatch(/timeline_id IS NULL/i);
        expect(updateCall[0]).toMatch(/contact_id IS NULL/i);
        expect(updateCall[0]).not.toMatch(/SET[\s\S]*contact_id\s*=/i);
        expect(updateCall[0]).not.toMatch(/DELETE|unread|publish|realtime/i);
    });

    it('TC-C5-01 · an unwritable snapshot aborts before writes; zero candidates no-op without a snapshot', async () => {
        const regularFile = path.join(tempRoot, 'not-a-directory');
        fs.writeFileSync(regularFile, 'occupied', 'utf8');

        await expect(runBackfill({
            companyId: DEFAULT_COMPANY_ID,
            dryRun: false,
            snapshotDir: path.join(regularFile, 'snapshots'),
            logger: fakeLogger,
        })).rejects.toThrow(/ABORT.*snapshot/i);
        expect(mockConnect).not.toHaveBeenCalled();
        expect(mockClientQuery.mock.calls.some(([sql]) => /UPDATE email_messages/i.test(sql))).toBe(false);

        candidates = [];
        const noOp = await runBackfill({
            companyId: DEFAULT_COMPANY_ID,
            dryRun: false,
            snapshotDir: path.join(tempRoot, 'c5-empty'),
            logger: fakeLogger,
        });
        expect(noOp).toMatchObject({
            threads: [],
            conflictThreadIds: [],
            linked: 0,
            residueOutbound: 0,
            snapshotFile: null,
        });
        expect(mockConnect).not.toHaveBeenCalled();
    });

    it('TC-C6-01 · --apply without --yes exits 1 before attempting a database connection', () => {
        const guardSnapshotDir = path.join(tempRoot, 'cli-guard');
        const result = spawnSync(
            process.execPath,
            [
                'backend/scripts/yelp_agent_sends_backfill.js',
                '--apply',
                '--snapshot-dir',
                guardSnapshotDir,
            ],
            {
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, DATABASE_URL: 'postgres://127.0.0.1:1/none' },
                encoding: 'utf8',
                timeout: 15000,
            }
        );

        expect(result.status).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/--yes/);
        expect(result.error).toBeUndefined();
        expect(fs.existsSync(guardSnapshotDir)).toBe(false);
    });

    it('TC-C6-02 · the owner script is never wired into ingest, poll, workers, or migrations', () => {
        const sourceFiles = [
            'backend/src/services/email/emailTimelineService.js',
            'backend/src/services/yelpLeadService.js',
            'backend/src/services/agentWorker.js',
            'backend/src/services/agentHandlers.js',
            'backend/src/services/emailSyncService.js',
        ];
        for (const file of sourceFiles) {
            expect(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
                .not.toMatch(/yelp_agent_sends_backfill/);
        }

        const migrationsDir = path.join(__dirname, '..', 'backend/db/migrations');
        for (const name of fs.readdirSync(migrationsDir)) {
            const fullPath = path.join(migrationsDir, name);
            if (!fs.statSync(fullPath).isFile()) continue;
            expect(fs.readFileSync(fullPath, 'utf8')).not.toMatch(/yelp_agent_sends_backfill/);
        }
    });

    it('TC-C6-03 · --dry-run overrides --apply and dry-run remains the default', () => {
        expect(parseCliArgs(['--apply', '--yes', '--dry-run']).dryRun).toBe(true);
        expect(parseCliArgs(['--apply', '--yes']).dryRun).toBe(false);
        expect(parseCliArgs([]).dryRun).toBe(true);
    });

    it('TC-C8-01 · the header documents scp, docker cp, and DATABASE_URL production steps', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '../backend/scripts/yelp_agent_sends_backfill.js'),
            'utf8'
        );
        expect(source).toMatch(/scp/);
        expect(source).toMatch(/docker cp/);
        expect(source).toMatch(/DATABASE_URL/);
    });
});
