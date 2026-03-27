/**
 * Platform Admin Companies Router
 * 
 * Accessible strictly by users with the platform_role = 'super_admin'.
 * Handles tenant company lifecycle management.
 */

const express = require('express');
const router = express.Router();
const companyQueries = require('../db/companyQueries');
const auditService = require('../services/auditService');

/**
 * GET /api/admin/companies — List all companies
 */
router.get('/', async (req, res) => {
    try {
        const { status, q, page, limit } = req.query;
        const result = await companyQueries.listCompanies({
            status,
            q,
            page: page ? parseInt(page, 10) : 1,
            limit: limit ? parseInt(limit, 10) : 25
        });
        
        // Count users per company (basic aggregation for list view)
        const db = require('../db/connection');
        if (result.companies.length > 0) {
            const ids = result.companies.map(c => c.id);
            const { rows: counts } = await db.query(
                `SELECT company_id, COUNT(*) as user_count 
                 FROM company_memberships 
                 WHERE company_id = ANY($1) AND status = 'active'
                 GROUP BY company_id`,
                [ids]
            );
            const countMap = counts.reduce((acc, row) => ({ ...acc, [row.company_id]: parseInt(row.user_count, 10) }), {});
            result.companies.forEach(c => {
                c.active_users = countMap[c.id] || 0;
            });
        }
        
        res.json(result);
    } catch (err) {
        console.error('[Admin Companies] GET / failed:', err.message);
        res.status(500).json({ error: 'Failed to list companies' });
    }
});

/**
 * GET /api/admin/companies/:id — Get company details
 */
router.get('/:id', async (req, res) => {
    try {
        const company = await companyQueries.getCompanyById(req.params.id);
        if (!company) {
            return res.status(404).json({ error: 'Company not found' });
        }
        res.json(company);
    } catch (err) {
        console.error('[Admin Companies] GET /:id failed:', err.message);
        res.status(500).json({ error: 'Failed to fetch company' });
    }
});

/**
 * POST /api/admin/companies — Create a new company + bootstrap first admin
 */
router.post('/', async (req, res) => {
    try {
        const { name, slug, timezone, locale, admin_email } = req.body;
        
        if (!name || !slug || !admin_email) {
            return res.status(400).json({ error: 'Name, slug and admin_email are required' });
        }
        
        // 1. Create company record
        const company = await companyQueries.createCompany({ 
            name, slug, timezone, locale, contact_email: admin_email 
        });
        
        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            action: 'company_created',
            target_type: 'company',
            target_id: company.id,
            trace_id: req.traceId
        });
        
        // 2. Bootstrap first admin user (Keycloak + DB)
        let adminBootstrapped = false;
        try {
            const keycloakService = require('../services/keycloakService');
            const db = require('../db/connection');
            
            // Create/find user in Keycloak
            const kcUser = await keycloakService.ensureUserExistsAndExecuteAction({
                email: admin_email,
                firstName: '',
                lastName: '',
                companyId: company.id,
            });
            
            if (!kcUser || !kcUser.id) {
                throw new Error('Failed to create or lookup user in Keycloak');
            }
            
            // Assign company_admin realm role
            await keycloakService.assignGlobalRole(kcUser.id, 'company_admin');
            
            // Create crm_user + membership in transaction
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                
                let crmUserId;
                const { rows: existingUser } = await client.query(
                    'SELECT id FROM crm_users WHERE keycloak_sub = $1', [kcUser.id]
                );
                
                if (existingUser.length > 0) {
                    crmUserId = existingUser[0].id;
                    await client.query('UPDATE crm_users SET role = $1 WHERE id = $2', ['company_admin', crmUserId]);
                } else {
                    const { rows: newUser } = await client.query(
                        `INSERT INTO crm_users (keycloak_sub, email, full_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
                        [kcUser.id, admin_email, admin_email, 'company_admin']
                    );
                    crmUserId = newUser[0].id;
                }
                
                // Upsert membership (role_key = tenant_admin)
                const { rows: existingMem } = await client.query(
                    'SELECT id FROM company_memberships WHERE user_id = $1 AND company_id = $2', [crmUserId, company.id]
                );
                if (existingMem.length === 0) {
                    await client.query(
                        `INSERT INTO company_memberships (user_id, company_id, role, role_key, status, is_primary)
                         VALUES ($1, $2, $3, $4, 'active', true)`,
                        [crmUserId, company.id, 'company_admin', 'tenant_admin']
                    );
                } else {
                    await client.query(
                        `UPDATE company_memberships SET role = $1, role_key = $2, status = 'active' WHERE id = $3`,
                        ['company_admin', 'tenant_admin', existingMem[0].id]
                    );
                }
                
                await client.query('COMMIT');
                adminBootstrapped = true;
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
            
            await auditService.log({
                actor_id: req.user.crmUser?.id,
                actor_email: req.user.email,
                action: 'company_admin_bootstrapped',
                target_type: 'company',
                target_id: company.id,
                details: { admin_email },
                trace_id: req.traceId
            });
        } catch (bootstrapErr) {
            console.error('[Admin Companies] Admin bootstrap failed (company created):', bootstrapErr.message);
            // Company is created but admin failed — return partial success
            return res.status(201).json({
                ...company,
                admin_bootstrapped: false,
                bootstrap_error: bootstrapErr.message
            });
        }
        
        res.status(201).json({ ...company, admin_bootstrapped: adminBootstrapped, admin_email });
    } catch (err) {
        console.error('[Admin Companies] POST / failed:', err.message);
        if (err.message.includes('already exists')) {
            return res.status(409).json({ error: err.message });
        }
        res.status(500).json({ error: 'Failed to create company' });
    }
});

/**
 * PATCH /api/admin/companies/:id/status — Update company lifecycle status
 */
router.patch('/:id/status', async (req, res) => {
    try {
        const { status, status_reason } = req.body;
        if (!['active', 'suspended', 'archived', 'onboarding'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        const companyId = req.params.id;
        const current = await companyQueries.getCompanyById(companyId);
        if (!current) return res.status(404).json({ error: 'Company not found' });
        
        const updateFields = { status, status_reason };
        if (status === 'suspended') updateFields.suspended_at = new Date();
        else if (status === 'active' && current.status === 'suspended') updateFields.suspended_at = null;
        
        if (status === 'archived') updateFields.archived_at = new Date();
        else if (status === 'active' && current.status === 'archived') updateFields.archived_at = null;
        
        const updated = await companyQueries.updateCompany(companyId, updateFields);
        
        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            action: 'company_status_changed',
            target_type: 'company',
            target_id: companyId,
            details: { previous: current.status, new: status, reason: status_reason },
            trace_id: req.traceId
        });
        
        res.json(updated);
    } catch (err) {
        console.error('[Admin Companies] PATCH /:id/status failed:', err.message);
        res.status(500).json({ error: 'Failed to update company status' });
    }
});

/**
 * POST /api/admin/companies/:id/bootstrap-admin — Bootstrap first admin
 */
router.post('/:id/bootstrap-admin', async (req, res) => {
    try {
        const { email, first_name, last_name } = req.body;
        const companyId = req.params.id;
        
        if (!email) return res.status(400).json({ error: 'Email is required' });
        
        const company = await companyQueries.getCompanyById(companyId);
        if (!company) return res.status(404).json({ error: 'Company not found' });
        
        // Use KeycloakAdminClient or user service to create user
        const keycloakService = require('../services/keycloakService');
        
        // 1. Ensure user exists in Keycloak (create and set temp password)
        const kcUser = await keycloakService.ensureUserExistsAndExecuteAction({
            email,
            firstName: first_name,
            lastName: last_name,
            companyId,
            requiredActions: ['UPDATE_PASSWORD']
        });
        
        if (!kcUser || !kcUser.id) {
             throw new Error('Failed to create or lookup user in Keycloak');
        }
        
        // 2. Add 'company_admin' realm role in Keycloak (legacy fallback)
        await keycloakService.assignGlobalRole(kcUser.id, 'company_admin');
        
        // 3. Create or upsert crm_user + membership
        const userService = require('../services/userService');
        const db = require('../db/connection');
        
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Upsert crm_user
            let crmUserId;
            const { rows: existingUser } = await client.query('SELECT id FROM crm_users WHERE keycloak_sub = $1', [kcUser.id]);
            
            if (existingUser.length > 0) {
                crmUserId = existingUser[0].id;
                await client.query('UPDATE crm_users SET role = $1 WHERE id = $2', ['company_admin', crmUserId]);
            } else {
                const { rows: newUser } = await client.query(
                    `INSERT INTO crm_users (keycloak_sub, email, full_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
                    [kcUser.id, email, `${first_name || ''} ${last_name || ''}`.trim(), 'company_admin']
                );
                crmUserId = newUser[0].id;
            }
            
            // Upsert membership (role_key = tenant_admin)
            const { rows: existingMem } = await client.query('SELECT id FROM company_memberships WHERE user_id = $1 AND company_id = $2', [crmUserId, companyId]);
            if (existingMem.length === 0) {
                 await client.query(
                     `INSERT INTO company_memberships (user_id, company_id, role, role_key, status, is_primary)
                      VALUES ($1, $2, $3, $4, 'active', true)`,
                     [crmUserId, companyId, 'company_admin', 'tenant_admin']
                 );
            } else {
                 await client.query(
                     `UPDATE company_memberships SET role = $1, role_key = $2, status = 'active' WHERE id = $3`,
                     ['company_admin', 'tenant_admin', existingMem[0].id]
                 );
            }
            
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        
        await auditService.log({
            actor_id: req.user.crmUser?.id,
            actor_email: req.user.email,
            action: 'company_admin_bootstrapped',
            target_type: 'company',
            target_id: companyId,
            details: { admin_email: email },
            trace_id: req.traceId
        });
        
        res.json({ message: 'Admin bootstrapped successfully', email });
    } catch (err) {
        console.error('[Admin Companies] POST /:id/bootstrap-admin failed:', err);
        res.status(500).json({ error: err.message || 'Failed to bootstrap admin' });
    }
});

module.exports = router;
