// backend/controllers/stage4Controller.js
const { setStudyConfig, evaluateFormulasOnCandles } = require('../services/stage4Engine');
const { getIntradayData, getMultipleIntradayData } = require('../services/intradayService');

// Save formulas + thresholds
const saveConfig = async (req, res) => {
  try {
    const { formulas, thresholds, buffer } = req.body || {};
    setStudyConfig({ formulas, thresholds, buffer });
    return res.json({ success: true });
  } catch (err) {
    console.error('stage4 saveConfig error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Get candles + labels for one underlying (chart)
const getLabelsForUnderlying = async (req, res) => {
  try {
    const { symbol } = req.params;
    const interval = Number(req.query.interval || 15);
    if (!symbol) return res.status(400).json({ success: false, error: 'Symbol required' });

    const raw = await getIntradayData(symbol, interval);
    const candles = (raw?.candles || []).map(c => ({
      time: c.datetime || c.time,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      oi: c.oi, delta: c.delta, gamma: c.gamma, theo: c.theo
    }));

    const { labels, thresholds, buffer } = evaluateFormulasOnCandles(candles);

    return res.json({ success: true, symbol, interval, candles, labels, thresholds, buffer });
  } catch (err) {
    console.error('getLabelsForUnderlying error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Scan: accept Stage-3 option rows (or array of underlyings)
// Request body: { rows: [...optionRows], interval: 15 } 
const scanStage3Rows = async (req, res) => {
  try {
    const { rows, interval = 15 } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ success: false, error: 'rows required' });

    // group rows by underlying
    const byUnderlying = {};
    rows.forEach(r => {
      const u = r.sourceSymbol || r.underlying || r.symbol?.slice(0, r.symbol.length - 15) || r.ticker || r.baseSymbol;
      const key = (u || 'UNKNOWN').toUpperCase();
      byUnderlying[key] = byUnderlying[key] || [];
      byUnderlying[key].push(r);
    });

    const underlyings = Object.keys(byUnderlying);
    // fetch intraday for all underlyings
    const multi = await getMultipleIntradayData(underlyings, interval);

    // map results -> labels then attach to rows
    const resultRows = [];
    for (const item of multi) {
      const u = item.symbol.toUpperCase();
      const rawData = item.data;
      const candles = (rawData?.candles || []).map(c => ({
        time: c.datetime || c.time,
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        oi: c.oi, delta: c.delta, gamma: c.gamma, theo: c.theo
      }));

      const { labels, thresholds, buffer } = evaluateFormulasOnCandles(candles);
      const labelObjects = (labels || []).map((v, i) => {
        const thr = thresholds?.[i] || { min: null, max: null };
        let status = 'unknown';
        if (v == null) status = 'unknown';
        else if (thr.min != null && v < thr.min) status = 'below';
        else if (thr.max != null && v > thr.max + (buffer || 0)) status = 'farAbove';
        else if (thr.max != null && v > thr.max) status = 'above';
        else status = 'within';
        return { value: v, min: thr.min, max: thr.max, status };
      });

      const rowsForU = byUnderlying[u] || byUnderlying[u.replace('.','')] || byUnderlying[Object.keys(byUnderlying).find(k=>k.includes(u))] || [];
      for (const r of rowsForU) {
        resultRows.push({ ...r, labels: labelObjects, underlying: u });
      }
    }

    return res.json({ success: true, rows: resultRows });
  } catch (err) {
    console.error('scanStage3Rows error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { saveConfig, getLabelsForUnderlying, scanStage3Rows };
