require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./backend/src/db/connection');

async function runAllMigrations() {
    const migrationDir = path.join(__dirname, 'backend', 'db', 'migrations');
    const files = fs.readdirSync(migrationDir)
        .filter(f => f.endsWith('.sql') && !f.startsWith('rollback'))
        .sort();
        
    console.log(`Found ${files.length} migration files.`);
    
    for (const file of files) {
        console.log(`Running ${file}...`);
        const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
        try {
            await db.query(sql);
            console.log(`✅ ${file} applied successfully.`);
        } catch (e) {
            console.error(`❌ Failed applying ${file}: ${e.message}`);
            // We ignore errors if they exist because some might not have IF NOT EXISTS
        }
    }
    
    console.log('Done running all migrations.');
    process.exit(0);
}

runAllMigrations();
