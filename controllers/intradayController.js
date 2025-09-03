const { getIntradayData } = require("../services/intradayService");

const calculateHLCStudy = (data, config) => {
  if (!data || data.length < 10) return data;

  const { length1, length2, avelength1, avelength2, avelength3, avelength4, avelength5 } = config;

  const sma = (arr, period) => {
    if (arr.length < period) return arr.map(() => null);
    return arr.map((_, index) => {
      if (index < period - 1) return null;
      const slice = arr.slice(index - period + 1, index + 1);
      return slice.reduce((sum, val) => sum + (val || 0), 0) / slice.length;
    });
  };

  const avecs = sma(data.map((d) => d.close), length1);
  const avels = sma(data.map((d) => d.low), length1);
  const avehs = sma(data.map((d) => d.high), length1);

  const laggedClose = data.map((_, i) => (i >= 2 ? data[i - 2].close : null));
  const laggedLow = data.map((_, i) => (i >= 2 ? data[i - 2].low : null));
  const laggedHigh = data.map((_, i) => (i >= 2 ? data[i - 2].high : null));

  const avec = sma(laggedClose, length2);
  const avel = sma(laggedLow, length2);
  const aveh = sma(laggedHigh, length2);

  const hlc = data.map((_, i) => {
    if (!avehs[i] || !aveh[i] || !avels[i] || !avel[i] || !avecs[i] || !avec[i]) {
      return null;
    }
    const highMomentum = ((avehs[i] - aveh[i]) * 100) / avehs[i];
    const lowMomentum = ((avels[i] - avel[i]) * 100) / avels[i];
    const closeMomentum = ((avecs[i] - avec[i]) * 100) / avecs[i];
    return (highMomentum + lowMomentum + closeMomentum) / 3;
  });

  const hlcAve1 = sma(hlc, avelength1);
  const hlcAve2 = sma(hlcAve1, avelength2);
  const hlcAve3 = sma(hlcAve2, avelength3);
  const hlcAve4 = sma(hlcAve3, avelength4);
  const hlcAve5 = sma(hlcAve4, avelength5);

  return data.map((candle, i) => ({
    ...candle,
    HLC_ave1: hlcAve1[i],
    HLC_ave2: hlcAve2[i],
    HLC_ave3: hlcAve3[i],
    HLC_ave4: hlcAve4[i],
    HLC_ave5: hlcAve5[i],
  }));
};

// GET /api/intraday/:symbol
const fetchIntradayData = async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = 15 } = req.query;

    if (!symbol) {
      return res.status(400).json({ success: false, error: "Symbol is required" });
    }

    const rawData = await getIntradayData(symbol, interval);

    if (!rawData || !rawData.candles) {
      return res.status(500).json({ success: false, error: "No intraday data available" });
    }

    const data = rawData.candles.map((candle) => ({
      time: new Date(candle.datetime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));

    const config = {
      length1: 2,
      length2: 2,
      avelength1: 2,
      avelength2: 3,
      avelength3: 5,
      avelength4: 7,
      avelength5: 9,
    };

    const dataWithStudies = calculateHLCStudy(data, config);

    res.json({ success: true, symbol, interval, data: dataWithStudies });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
};

module.exports = { fetchIntradayData };