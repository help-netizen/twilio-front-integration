'use strict';

const provider = require('../backend/src/services/appBuilderProviderService');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    for (const key of [
        'APP_BUILDER_PROVIDER',
        'APP_BUILDER_MODEL',
        'ASSISTANT_PROVIDER',
        'ASSISTANT_MODEL',
    ]) {
        if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = ORIGINAL_ENV[key];
    }
});

describe('APP-BUILD-001 provider seam', () => {
    test('builder env overrides assistant env without mutating it', () => {
        process.env.ASSISTANT_PROVIDER = 'gemini';
        process.env.ASSISTANT_MODEL = 'assistant-model';
        process.env.APP_BUILDER_PROVIDER = 'GEMINI';
        process.env.APP_BUILDER_MODEL = 'builder-model';
        expect(provider.providerName()).toBe('gemini');
        expect(provider.modelName()).toBe('builder-model');
        expect(process.env.ASSISTANT_MODEL).toBe('assistant-model');
    });

    test('builder defaults follow the assistant provider/model seam', () => {
        delete process.env.APP_BUILDER_PROVIDER;
        delete process.env.APP_BUILDER_MODEL;
        process.env.ASSISTANT_PROVIDER = 'gemini';
        process.env.ASSISTANT_MODEL = 'assistant-code-capable-model';
        expect(provider.providerName()).toBe('gemini');
        expect(provider.modelName()).toBe('assistant-code-capable-model');
    });

    test('strict envelope parser returns source and short description', () => {
        expect(provider.parseGeneratedArtifact(JSON.stringify({
            source: 'export async function run(ctx) { return ctx.input; }',
            description: ' Returns the supplied input. ',
        }))).toEqual({
            source: 'export async function run(ctx) { return ctx.input; }',
            description: 'Returns the supplied input.',
        });
        expect(() => provider.parseGeneratedArtifact('{"description":"missing source"}'))
            .toThrow(provider.AppBuilderProviderError);
    });
});
