const express = require('express');
const router = express.Router();

router.get('/me', (req, res) => {
    try {
        const authz = req.authz || {};
        const crmUser = req.user?.crmUser;

        res.json({
            ok: true,
            user: {
                id: crmUser?.id || req.user?.sub || null,
                email: req.user?.email || null,
                full_name: req.user?.name || null,
                platform_role: authz.platform_role || 'none',
            },
            company: authz.company || null,
            membership: authz.membership || null,
            permissions: authz.permissions || [],
            scopes: authz.scopes || {},
        });
    } catch (err) {
        console.error('[Auth] /me failed:', err.message);
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to load auth context', trace_id: req.traceId });
    }
});

module.exports = router;
