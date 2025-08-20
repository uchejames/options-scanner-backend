// backend/services/intradayService.js
const axios = require("axios");
const { getAccessToken } = require("../utils/schwab"); // you already have this

// Fetch intraday data (15-min intervals)
const getIntradayData = async (symbol, interval = "15m") => {
  try {
    const accessToken = await getAccessToken();

    const res = await axios.get(
      `https://api.schwabapi.com/marketdata/v1/pricehistory`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          symbol: symbol.toUpperCase(),
          periodType: "day",
          period: 1,          // last trading day
          frequencyType: "minute",
          frequency: 15,      // 15-min candles
          needExtendedHoursData: false
        }
      }
    );

    return res.data;
  } catch (err) {
    console.error("❌ Intraday Data Fetch Error:", err.response?.data || err.message);
    throw err;
  }
};

module.exports = { getIntradayData };
