'use strict';

const MAX_ACTIONS = 8;
const MAX_ACTION_LABEL_LENGTH = 40;
const ACTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

class AppActionValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AppActionValidationError';
        this.code = 'APP_ACTIONS_INVALID';
        this.httpStatus = 422;
    }
}

function fail(path, message) {
    throw new AppActionValidationError(`${path} ${message}`);
}

function validateActions(value) {
    if (!Array.isArray(value)) fail('actions', 'must be an array.');
    if (value.length > MAX_ACTIONS) {
        fail('actions', `must contain no more than ${MAX_ACTIONS} actions.`);
    }
    const ids = new Set();
    return value.map((action, index) => {
        const path = `actions[${index}]`;
        if (!action || typeof action !== 'object' || Array.isArray(action)) {
            fail(path, 'must be an object.');
        }
        for (const key of Object.keys(action)) {
            if (key !== 'id' && key !== 'label') fail(`${path}.${key}`, 'is not supported.');
        }
        if (!Object.prototype.hasOwnProperty.call(action, 'id')
            || !Object.prototype.hasOwnProperty.call(action, 'label')) {
            fail(path, 'must include "id" and "label".');
        }
        if (typeof action.id !== 'string' || !ACTION_ID_PATTERN.test(action.id)) {
            fail(`${path}.id`, 'must start with a lowercase letter and contain only lowercase letters, digits, or underscores, up to 32 characters.');
        }
        if (ids.has(action.id)) fail(`${path}.id`, 'must be unique.');
        ids.add(action.id);
        if (typeof action.label !== 'string' || action.label.trim().length === 0) {
            fail(`${path}.label`, 'must be a non-empty string.');
        }
        if (Array.from(action.label).length > MAX_ACTION_LABEL_LENGTH) {
            fail(`${path}.label`, `must contain no more than ${MAX_ACTION_LABEL_LENGTH} characters.`);
        }
        return { id: action.id, label: action.label };
    });
}

function renderActionContract() {
    return [
        'APP ACTIONS CONTRACT:',
        'The response declares actions next to data_collections:',
        '"actions":[{"id":"mark_ordered","label":"Mark ordered"}]',
        `Declare at most ${MAX_ACTIONS} actions. Each id must match ${ACTION_ID_PATTERN}; each label is required and limited to ${MAX_ACTION_LABEL_LENGTH} characters.`,
        'Use [] when the app has no actions.',
        'When ctx.input.action is present, it is {"id":"mark_ordered","row_key":"purchase-41"}.',
        'Handle that branch through the same run(ctx), update only ctx.data, and return a fresh view document.',
    ].join('\n');
}

module.exports = {
    ACTION_ID_PATTERN,
    MAX_ACTIONS,
    MAX_ACTION_LABEL_LENGTH,
    AppActionValidationError,
    renderActionContract,
    validateActions,
};
