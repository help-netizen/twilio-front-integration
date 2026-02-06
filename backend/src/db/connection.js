const { Pool } = require('pg');

// Create connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000, // Timeout after 2 seconds
});

// Handle pool errors
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle database client:', err);
    process.exit(-1);
});

// Test connection function
async function testConnection() {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        console.log('Database connected successfully at:', result.rows[0].now);
        client.release();
        return true;
    } catch (err) {
        console.error('Database connection error:', err);
        return false;
    }
}

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
    testConnection,
};
