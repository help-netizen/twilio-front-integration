'use strict';

const ivm = require('isolated-vm');
const { LIMITS } = require('./config');
const {
    BuilderValidationError,
    validateSourcePolicy,
} = require('./builderSourcePolicy');

async function validateApplicationSource(source) {
    const policy = validateSourcePolicy(source);
    const isolate = new ivm.Isolate({ memoryLimit: LIMITS.memoryMb });
    try {
        const module = await isolate.compileModule(source, {
            filename: 'app://builder-validation/app.js',
        });
        if (module.dependencySpecifiers.length > 0) {
            throw new BuilderValidationError(
                'IMPORT_FORBIDDEN',
                'Application modules may not import dependencies.'
            );
        }
        return policy;
    } catch (error) {
        if (error instanceof BuilderValidationError) throw error;
        throw new BuilderValidationError(
            'SOURCE_PARSE_ERROR',
            'Application source is not valid JavaScript.'
        );
    } finally {
        if (!isolate.isDisposed) isolate.dispose();
    }
}

module.exports = {
    validateApplicationSource,
};
