describe('zenbookerClient job creation', () => {
    const originalApiKey = process.env.ZENBOOKER_API_KEY;

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('axios');
        if (originalApiKey === undefined) {
            delete process.env.ZENBOOKER_API_KEY;
        } else {
            process.env.ZENBOOKER_API_KEY = originalApiKey;
        }
    });

    it('does not retry direct POST /jobs because Zenbooker job creation is not idempotent', async () => {
        jest.resetModules();
        process.env.ZENBOOKER_API_KEY = 'test-key';

        const post = jest.fn().mockRejectedValue(new Error('timeout'));
        const create = jest.fn(() => ({ post }));
        jest.doMock('axios', () => ({ create }));

        const zenbookerClient = require('../backend/src/services/zenbookerClient');

        await expect(zenbookerClient.createJob({ territory_id: 'territory-1' })).rejects.toThrow('timeout');
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('does not retry lead-derived POST /jobs after territory lookup succeeds', async () => {
        jest.resetModules();
        process.env.ZENBOOKER_API_KEY = 'test-key';

        const get = jest.fn().mockResolvedValue({
            data: {
                results: [{
                    id: 'territory-1',
                    enabled: true,
                    service_area: { postal_codes: ['02110'] },
                }],
            },
        });
        const post = jest.fn().mockRejectedValue(new Error('timeout'));
        const create = jest.fn(() => ({ get, post }));
        jest.doMock('axios', () => ({ create }));

        const zenbookerClient = require('../backend/src/services/zenbookerClient');

        await expect(zenbookerClient.createJobFromLead({
            PostalCode: '02110',
            FirstName: 'Ada',
            LastName: 'Lovelace',
            Phone: '+16175550000',
            Email: 'ada@example.com',
            Address: '1 Main St',
            City: 'Boston',
            State: 'MA',
            Country: 'US',
            JobType: 'Repair',
        })).rejects.toThrow('timeout');

        expect(get).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledTimes(1);
    });
});
