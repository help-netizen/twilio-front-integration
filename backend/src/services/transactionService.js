'use strict';

const db = require('../db/connection');

async function withTransaction(work) {
    const client = await db.getClient();
    const afterCommitCallbacks = [];
    const previousAfterCommit = client.afterCommit;
    client.afterCommit = callback => {
        if (typeof callback !== 'function') {
            throw new Error('afterCommit callback must be a function');
        }
        afterCommitCallbacks.push(callback);
    };
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        for (const callback of afterCommitCallbacks) {
            try {
                await callback();
            } catch (error) {
                console.warn('[transactionService] afterCommit callback failed:', error.message);
            }
        }
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        if (previousAfterCommit === undefined) delete client.afterCommit;
        else client.afterCommit = previousAfterCommit;
        client.release();
    }
}

module.exports = { withTransaction };
