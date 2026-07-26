'use strict';

const db = require('../db/connection');

async function withTransaction(work) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { withTransaction };
