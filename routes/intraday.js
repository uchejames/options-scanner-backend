// backend/routes/intraday.js
const express = require("express");
const router = express.Router();
const { fetchIntradayData } = require("../controllers/intradayController");

// GET intraday chart data
router.get("/:symbol", fetchIntradayData);

module.exports = router;
