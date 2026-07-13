/**
 * In-app product feedback — CLIENT-FEEDBACK-WIDGET-001.
 * Mounted at /api/feedback behind authenticate + requireCompanyAccess.
 */

const express = require('express');
const multer = require('multer');
const feedbackService = require('../services/feedbackService');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: feedbackService.MAX_FILE_SIZE,
        files: feedbackService.MAX_FILES,
    },
});

function handleUpload(req, res, next) {
    upload.array('files', feedbackService.MAX_FILES)(req, res, err => {
        if (!err) return next();
        if (['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(err.code)) {
            return res.status(422).json({ ok: false, error: 'Invalid feedback attachment' });
        }
        return next(err);
    });
}

router.post('/', handleUpload, async (req, res) => {
    try {
        const submission = await feedbackService.submitFeedback({
            companyId: req.companyFilter?.company_id,
            userId: req.user?.crmUser?.id ?? null,
            userEmail: req.body.email || req.user?.email,
            message: req.body.message,
            files: req.files || [],
        });
        return res.status(201).json({ ok: true, data: { id: submission.id } });
    } catch (err) {
        if (err.status === 422) {
            return res.status(422).json({ ok: false, error: err.message });
        }
        console.error('[FeedbackRoute] Submission failed:', err.message);
        return res.status(500).json({ ok: false, error: 'Failed to submit feedback' });
    }
});

module.exports = router;
