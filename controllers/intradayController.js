// backend/controllers/intradayController.js
const { getIntradayData } = require("../services/intradayService");

// GET /api/intraday/:symbol
const fetchIntradayData = async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = 15 } = req.query; // allow ?interval=5, default 15

    if (!symbol) {
      return res.status(400).json({ success: false, error: "Symbol is required" });
    }

    const rawData = await getIntradayData(symbol, interval);

    if (!rawData || !rawData.candles) {
      return res.status(500).json({ success: false, error: "No intraday data available" });
    }

    // ✅ Normalize Schwab candles -> chart-friendly format
    const data = rawData.candles.map(candle => ({
      time: new Date(candle.datetime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume
    }));

    res.json({ success: true, symbol, interval, data });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
};

module.exports = { fetchIntradayData };
