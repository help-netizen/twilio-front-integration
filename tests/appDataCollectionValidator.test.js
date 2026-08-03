'use strict';

const {
    renderDataCollectionsContract,
    validateDataCollectionEvolution,
    validateDataCollections,
} = require('../backend/src/services/appDataCollectionValidator');
const { buildPrompt } = require('../backend/src/services/appBuilderService');
const provider = require('../backend/src/services/appBuilderProviderService');
const {
    createAppVersionTransitionService,
} = require('../backend/src/services/appVersionTransitionService');

const PURCHASES = [{
    name: 'purchases',
    key_fields: ['estimate_id', 'part_number'],
    columns: [
        { key: 'estimate_id', type: 'number' },
        { key: 'part_number', type: 'text' },
        { key: 'amount', type: 'currency' },
    ],
}];

describe('APP-DATA-001 Phase D declaration contract', () => {
    test('validates the closed declaration shape and rejects all required invalid classes', () => {
        expect(validateDataCollections(PURCHASES)).toEqual(PURCHASES);
        expect(() => validateDataCollections(Array.from({ length: 5 }, (_, index) => ({
            ...PURCHASES[0],
            name: `collection_${index}`,
        })))).toThrow(/no more than 4 collections/i);
        expect(() => validateDataCollections([{ ...PURCHASES[0], name: 'Bad-Name' }]))
            .toThrow(/must match/i);
        expect(() => validateDataCollections([{
            ...PURCHASES[0],
            key_fields: ['missing'],
        }])).toThrow(/must name a declared column/i);
    });

    test('published key fields and columns are immutable while additive columns remain valid', () => {
        expect(validateDataCollectionEvolution(PURCHASES, [{
            ...PURCHASES[0],
            columns: [...PURCHASES[0].columns, { key: 'status', type: 'badge' }],
        }])).toHaveLength(1);
        expect(() => validateDataCollectionEvolution(PURCHASES, [{
            ...PURCHASES[0],
            key_fields: ['estimate_id'],
        }])).toThrow(/key_fields cannot change/i);
        expect(() => validateDataCollectionEvolution(PURCHASES, [{
            ...PURCHASES[0],
            columns: PURCHASES[0].columns.slice(0, 2),
        }])).toThrow(/cannot be removed/i);
    });

    test('the provider parser and builder prompt use the validator-rendered contract without drift', () => {
        const artifact = provider.parseGeneratedArtifact(JSON.stringify({
            source: 'export async function run(ctx) { return ctx.input; }',
            description: 'Uses installation memory.',
            data_collections: PURCHASES,
            actions: [],
        }));
        expect(artifact.data_collections).toEqual(PURCHASES);
        const rendered = renderDataCollectionsContract();
        const prompt = buildPrompt({ history: [], current_source: null });
        expect(prompt).toContain(rendered);
        expect(prompt).toContain('ctx.data.list/upsert/delete');
        expect(() => provider.parseGeneratedArtifact(JSON.stringify({
            source: artifact.source,
            description: artifact.description,
            data_collections: [{ ...PURCHASES[0], name: 'invalid-name' }],
            actions: [],
        }))).toThrow(/invalid data collections/i);
    });

    test('manual submit revalidates the stored declaration and leaves an invalid draft unchanged', async () => {
        const query = jest.fn(async sql => {
            if (/FROM app_versions version/.test(sql) && /FOR UPDATE OF version/.test(sql)) {
                return { rows: [{
                    id: '40000000-0000-4000-8000-000000000001',
                    app_id: '91',
                    version_number: 'builder-1',
                    status: 'draft',
                    company_id: '10000000-0000-4000-8000-000000000001',
                    data_collections: [{ ...PURCHASES[0], name: 'invalid-name' }],
                }] };
            }
            return { rows: [] };
        });
        const service = createAppVersionTransitionService({
            database: {
                getClient: jest.fn().mockResolvedValue({ query, release: jest.fn() }),
            },
        });
        await expect(service.submitVersion({
            versionId: '40000000-0000-4000-8000-000000000001',
            appId: '91',
            companyId: '10000000-0000-4000-8000-000000000001',
            actorId: '20000000-0000-4000-8000-000000000001',
        })).rejects.toMatchObject({ code: 'DATA_COLLECTIONS_INVALID', httpStatus: 422 });
        expect(query.mock.calls.some(([sql]) => /SET status = 'submitted'/.test(sql))).toBe(false);
        expect(query).toHaveBeenCalledWith('ROLLBACK');
    });
});
