'use strict';

const mockCreateNote = jest.fn();

jest.mock('../backend/src/services/crmNotesService', () => ({
    createNote: mockCreateNote,
}));

const noteService = require('../backend/src/services/appRuntimeNoteService');

const CONTEXT = Object.freeze({
    company_id: '10000000-0000-4000-8000-000000000001',
    app_id: '91',
    installation_id: '101',
    agent_user_id: '40000000-0000-4000-8000-000000000001',
    agent_email: 'app-runtime+101@albusto.invalid',
    agent_full_name: 'App Runtime: Phase H',
});
const ARGS = Object.freeze({
    parent_type: 'lead',
    parent_id: 51,
    text: 'Follow up before scheduling.',
});
const AUTHORIZATION = Object.freeze({
    ownerUserId: '50000000-0000-4000-8000-000000000001',
    ownerScopes: { job_visibility: 'all' },
});

function clientFor({ notes = [], parentExists = true, dailyCount = 0 } = {}) {
    return {
        query: jest.fn(async (sql) => {
            if (sql.includes('FROM marketplace_installations')) return { rows: [{ id: 101 }] };
            if (sql.includes('SELECT COUNT(*)::integer AS count')) {
                return { rows: [{ count: dailyCount }] };
            }
            if (sql.includes('FROM leads') || sql.includes('FROM jobs')) {
                return { rows: parentExists ? [{ id: 51, notes }] : [] };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockCreateNote.mockResolvedValue({
        note: {
            id: 'note-phase-h-1',
            text: ARGS.text,
            created: new Date().toISOString(),
            created_by: CONTEXT.agent_user_id,
            source: 'app',
            installation_id: CONTEXT.installation_id,
            agent_type: 'app',
            agent_input: {
                source: 'app',
                installation_id: CONTEXT.installation_id,
            },
        },
    });
});

describe('APP-DATA-001 Phase H App Note write path', () => {
    test('creates through the canonical service with agent authorship and App source metadata', async () => {
        const client = clientFor();
        const result = await noteService.addNoteInTransaction(
            CONTEXT,
            ARGS,
            client,
            AUTHORIZATION
        );

        expect(result).toMatchObject({
            deduplicated: false,
            note: {
                id: 'note-phase-h-1',
                created_by: CONTEXT.agent_user_id,
                source: 'app',
                installation_id: CONTEXT.installation_id,
            },
        });
        expect(mockCreateNote).toHaveBeenCalledWith(
            CONTEXT.company_id,
            {
                entity_type: 'lead',
                entity_id: 51,
                text: ARGS.text,
                source: 'app',
            },
            expect.objectContaining({
                actorId: CONTEXT.agent_user_id,
                actorEmail: CONTEXT.agent_email,
                actorName: CONTEXT.agent_full_name,
                installationId: CONTEXT.installation_id,
                source: 'App Studio',
                client,
            })
        );
    });

    test('returns the existing Note for the same installation, parent, and exact text within 24 hours', async () => {
        const existing = {
            id: 'note-existing-24h',
            text: ARGS.text,
            created: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
            source: 'app',
            installation_id: CONTEXT.installation_id,
        };
        const result = await noteService.addNoteInTransaction(
            CONTEXT,
            ARGS,
            clientFor({ notes: [existing] }),
            AUTHORIZATION
        );

        expect(result).toEqual({ note: existing, deduplicated: true });
        expect(mockCreateNote).not.toHaveBeenCalled();
    });

    test('a foreign parent is NOT_FOUND and cannot reach the canonical write seam', async () => {
        await expect(noteService.addNoteInTransaction(
            CONTEXT,
            ARGS,
            clientFor({ parentExists: false }),
            AUTHORIZATION
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(mockCreateNote).not.toHaveBeenCalled();
    });

    test('the installation cannot create a one-hundred-and-first Note in one UTC day', async () => {
        await expect(noteService.addNoteInTransaction(
            CONTEXT,
            ARGS,
            clientFor({ dailyCount: 100 }),
            AUTHORIZATION
        )).rejects.toMatchObject({
            code: 'NOTE_DAILY_LIMIT',
            message: 'Daily note creation limit of 100 reached.',
            httpStatus: 429,
        });
        expect(mockCreateNote).not.toHaveBeenCalled();
    });

    test('assigned-only Job Notes include the delegated owner in the parent lock', async () => {
        const client = clientFor();
        const ownerUserId = '50000000-0000-4000-8000-000000000099';
        await noteService.addNoteInTransaction(CONTEXT, {
            parent_type: 'job',
            parent_id: 51,
            text: 'Assigned Job Note.',
        }, client, {
            ownerUserId,
            ownerScopes: { job_visibility: 'assigned_only' },
        });

        const lockCall = client.query.mock.calls.find(([sql]) => (
            sql.includes('FROM jobs') && sql.includes('FOR UPDATE')
        ));
        expect(lockCall[0]).toContain('assigned_provider_user_ids');
        expect(lockCall[1]).toEqual([51, CONTEXT.company_id, JSON.stringify([ownerUserId])]);
    });
});
