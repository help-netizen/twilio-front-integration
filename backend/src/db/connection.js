const { Pool } = require('pg');

const MAX_JOB_CODE_FEISTEL_KEY = 4294967295n;

class DatabaseConfigurationError extends Error {
    constructor(code) {
        super(code);
        this.name = 'DatabaseConfigurationError';
        this.code = code;
    }
}

function resolveJobCodeFeistelKey(environment = process.env) {
    const supplied = environment.JOB_CODE_FEISTEL_KEY;
    if (typeof supplied !== 'string' || supplied === '') {
        throw new DatabaseConfigurationError('JOB_CODE_FEISTEL_KEY_REQUIRED');
    }
    if (!/^[1-9][0-9]{0,9}$/.test(supplied)) {
        throw new DatabaseConfigurationError('JOB_CODE_FEISTEL_KEY_INVALID');
    }
    const numeric = BigInt(supplied);
    if (numeric > MAX_JOB_CODE_FEISTEL_KEY) {
        throw new DatabaseConfigurationError('JOB_CODE_FEISTEL_KEY_INVALID');
    }
    return supplied;
}

function inspectJobCodeFeistelKey(environment = process.env) {
    try {
        return { configured: true, key: resolveJobCodeFeistelKey(environment), code: null };
    } catch (error) {
        if (!(error instanceof DatabaseConfigurationError)) throw error;
        return { configured: false, key: null, code: error.code };
    }
}

const jobCodeConfiguration = inspectJobCodeFeistelKey();
let databaseRuntimeDiagnostics = {
    jobNumbering: {
        configured: jobCodeConfiguration.configured,
        degraded: !jobCodeConfiguration.configured,
        code: jobCodeConfiguration.code,
        databaseDefaultPresent: null,
    },
};

// Create connection pool
const poolOptions = {
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls',
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 2000, // Timeout after 2 seconds
};
if (jobCodeConfiguration.configured) {
    // The application setting is authoritative for new/replacement connections.
    // Migration 273 also pins the database default so the pre-restart process and
    // raw psql are safe during the deploy window; the DB fingerprint catches drift.
    poolOptions.options = `-c app.job_code_feistel_key=${jobCodeConfiguration.key}`;
}
const pool = new Pool(poolOptions);

// Handle pool errors — log but do NOT crash the process.
// Idle client errors are recoverable; the pool will create new connections.
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle database client:', err.message);
});

// Test connection function
async function testConnection() {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        console.log('Database connected successfully at:', result.rows[0].now);
        let databaseDefaultPresent = false;
        try {
            const diagnostic = await client.query(
                `SELECT EXISTS (
                     SELECT 1
                     FROM pg_db_role_setting settings
                     CROSS JOIN LATERAL unnest(settings.setconfig) AS item(setting)
                     JOIN pg_database database ON database.oid = settings.setdatabase
                     WHERE database.datname = current_database()
                       AND settings.setrole = 0
                       AND item.setting LIKE 'app.job_code_feistel_key=%'
                       AND NULLIF(split_part(item.setting, '=', 2), '') IS NOT NULL
                 ) AS database_default_present,
                 to_regclass('job_public_code_key_state') IS NOT NULL AS key_state_present`,
            );
            databaseDefaultPresent = diagnostic.rows[0]?.database_default_present === true;
            if (diagnostic.rows[0]?.key_state_present === true) {
                await client.query(
                    `UPDATE job_public_code_key_state
                     SET diagnostic_code = $1,
                         diagnostic_at = CASE WHEN $1 IS NULL THEN NULL ELSE now() END
                     WHERE singleton = true`,
                    [jobCodeConfiguration.code],
                );
            }
        } catch (error) {
            console.error('[database] job numbering diagnostic unavailable:', error.message);
        }
        databaseRuntimeDiagnostics = {
            ...databaseRuntimeDiagnostics,
            jobNumbering: {
                configured: jobCodeConfiguration.configured,
                degraded: !jobCodeConfiguration.configured,
                code: jobCodeConfiguration.code,
                databaseDefaultPresent,
            },
        };
        if (!jobCodeConfiguration.configured) {
            console.error('[database] JOB_CODE_FEISTEL_KEY missing/invalid; job creation is disabled while other surfaces remain available');
        }
        return true;
    } catch (err) {
        console.error('Database connection error:', err);
        return false;
    } finally {
        if (client) client.release();
    }
}

function getRuntimeDiagnostics() {
    return databaseRuntimeDiagnostics;
}

module.exports = {
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(),
    pool,
    testConnection,
    DatabaseConfigurationError,
    resolveJobCodeFeistelKey,
    inspectJobCodeFeistelKey,
    getRuntimeDiagnostics,
};
