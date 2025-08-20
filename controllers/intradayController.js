// backend/controllers/intradayController.js
const { getIntradayData } = require("../services/intradayService");

// GET /api/intraday/:symbol
const fetchIntradayData = async (req, res) => {
  try {
    const { symbol } = req.params;
    if (!symbol) {
      return res.status(400).json({ error: "Symbol is required" });
    }

    const data = await getIntradayData(symbol);
    res.json({ success: true, symbol, data });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
};

module.exports = { fetchIntradayData };
