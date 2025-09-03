const axios = require("axios");
const { getAccessToken } = require("../utils/schwab");

const getIntradayData = async (symbol, interval = "15m") => {
  try {
    const accessToken = await getAccessToken();

    const res = await axios.get(`https://api.schwabapi.com/marketdata/v1/pricehistory`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        symbol: symbol.toUpperCase(),
        periodType: "day",
        period: 1,
        frequencyType: "minute",
        frequency: parseInt(interval) || 15,
        needExtendedHoursData: false,
      },
    });

    return res.data;
  } catch (err) {
    console.error("❌ Intraday Data Fetch Error:", err.response?.data || err.message);
    throw err;
  }
};

const getMultipleIntradayData = async (symbols, interval = "15m") => {
  const promises = symbols.map((symbol) => getIntradayData(symbol, interval));
  const results = await Promise.allSettled(promises);
  return results.map((result, index) => ({
    symbol: symbols[index],
    data: result.status === "fulfilled" ? result.value : null,
    error: result.status === "rejected" ? result.reason.message : null,
  }));
};

module.exports = { getIntradayData, getMultipleIntradayData };