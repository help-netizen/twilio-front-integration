'use strict';

const {
    TEST_TOKEN,
    GATEWAY_BASE_URL,
    response,
    referenceSource,
    runApplication,
} = require('./helpers');

describe('APP-RUN-001 morning digest reference app', () => {
    test('renders today jobs and open tasks from the mocked gateway', async () => {
        const fetchImpl = jest.fn(async (url, options) => {
            const args = JSON.parse(options.body);
            if (url.pathname.endsWith('/svc.list_jobs')) {
                expect(args).toEqual({
                    start_date: '2026-07-31',
                    end_date: '2026-07-31',
                    limit: 100,
                });
                return response({
                    results: [
                        {
                            id: 11,
                            service_name: 'AC repair',
                            scheduled_start: '2026-07-31T09:00:00-04:00',
                            status: 'scheduled',
                        },
                        { id: 12, job_seq: 171, job_number: 'ZB-12' },
                    ],
                });
            }
            expect(url.pathname).toMatch(/svc\.list_tasks$/);
            expect(args).toEqual({ status: 'open', limit: 100 });
            return response({
                tasks: [
                    { id: 21, title: 'Call customer', due_at: '2026-07-31T16:00:00Z' },
                ],
            });
        });

        const result = await runApplication({
            source: referenceSource(),
            input: { today: '2026-07-31' },
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        });

        expect(result).toBe([
            'Morning digest for 2026-07-31',
            'Jobs today: 2',
            '- 09:00 — AC repair (scheduled)',
            '- 171',
            'Open tasks: 1',
            '- Call customer (due 2026-07-31)',
        ].join('\n'));
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    test('empty gateway data produces a meaningful digest instead of failing', async () => {
        const fetchImpl = jest.fn(async url => response(
            url.pathname.endsWith('/svc.list_jobs') ? { results: [] } : { tasks: [] }
        ));
        const result = await runApplication({
            source: referenceSource(),
            input: { today: '2026-08-01' },
            gatewayBaseUrl: GATEWAY_BASE_URL,
            runToken: TEST_TOKEN,
            fetchImpl,
        });

        expect(result).toBe([
            'Morning digest for 2026-08-01',
            'No jobs scheduled for today.',
            'No open tasks.',
        ].join('\n'));
    });
});
