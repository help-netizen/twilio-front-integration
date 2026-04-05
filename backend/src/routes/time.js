const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.json({ utc: Date.now() });
});

module.exports = router;
