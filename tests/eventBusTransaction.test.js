'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const eventBus = require('../backend/src/services/eventBus');

test('a rejected domain event rolls back its savepoint without poisoning the caller transaction', async () => {
    const client = {
        query: jest.fn()
            .mockResolvedValueOnce({ rows: [] })
            .mockRejectedValueOnce(new Error('actor check rejected'))
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ still_usable: true }] }),
    };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(eventBus.emit('company-a', 'job.updated', { id: 1 }, {
        client,
        actorType: 'unexpected',
    })).resolves.toBeNull();
    await expect(client.query('SELECT true AS still_usable')).resolves.toEqual({
        rows: [{ still_usable: true }],
    });

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
        'SAVEPOINT event_bus_persist',
        expect.stringContaining('INSERT INTO domain_events'),
        'ROLLBACK TO SAVEPOINT event_bus_persist',
        'RELEASE SAVEPOINT event_bus_persist',
        'SELECT true AS still_usable',
    ]);
    errorSpy.mockRestore();
});

test('a supplied idle pg client persists without issuing an illegal savepoint', async () => {
    const event = { id: 9, created_at: new Date('2026-08-17T12:00:00Z') };
    const client = {
        readyForQuery: 'I',
        query: jest.fn().mockResolvedValue({ rows: [event] }),
    };

    await expect(eventBus.emit('company-a', 'job.updated', { id: 1 }, {
        client,
        dispatch: false,
    })).resolves.toBe(event);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('INSERT INTO domain_events');
});
