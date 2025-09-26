// backend/routes/stage4.js
const express = require('express');
const router = express.Router();
const { saveConfig, getLabelsForUnderlying, scanStage3Rows } = require('../controllers/stage4Controller');

router.post('/config', saveConfig);
router.get('/labels/:symbol', getLabelsForUnderlying);
router.post('/scan', scanStage3Rows);

module.exports = router;
