const fs = require('fs');
const db = require('./backend/src/db/connection');

async function runMigrations() {
    try {
        console.log('📋 Reading schema.sql...');
        const schema = fs.readFileSync('./backend/db/schema.sql', 'utf8');

        console.log('🔄 Running migrations...');
        await db.query(schema);

        console.log('✅ Migrations completed successfully!');

        // Verify tables were created
        const result = await db.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name;
        `);

        console.log('📊 Created tables:');
        result.rows.forEach(row => console.log(`  - ${row.table_name}`));

        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    }
}

runMigrations();
