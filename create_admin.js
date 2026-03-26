require('dotenv').config({ path: './.env' });
const db = require('./backend/src/db/connection');
const userService = require('./backend/src/services/userService');

async function createAdminUser() {
    try {
        console.log('Fetching first company...');
        const compRes = await db.query('SELECT id FROM companies ORDER BY created_at ASC LIMIT 1');
        const companyId = compRes.rows[0].id;

        console.log('Creating new admin user for company:', companyId);
        const result = await userService.createUserWithMembership({
            email: 'newadmin2@crm.local',
            fullName: 'New Admin2',
            role_key: 'tenant_admin',
            companyId: companyId
        });
        console.log('User created successfully:', result);
    } catch (err) {
        console.error('Failed to create user:', err);
    } finally {
        process.exit(0);
    }
}

createAdminUser();
