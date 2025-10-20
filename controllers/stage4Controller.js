// backend/controllers/stage4Controller.js
const { evaluateFormulasOnCandles, setStudyConfig } = require('../services/stage4Engine');
const { getIntradayData, getMultipleIntradayData } = require('../services/intradayService');

/**
 * Save formulas + thresholds
 * (You can store them globally or per user if needed)
 */
const saveConfig = async (req, res) => {
  try {
    const { formulas, thresholds, buffer } = req.body || {};
    setStudyConfig({ formulas, thresholds, buffer });
    return res.json({ success: true, message: 'Config saved successfully' });
  } catch (err) {
    console.error('stage4 saveConfig error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Get intraday candles + evaluated labels for one underlying (used for chart previews)
 */
const getLabelsForUnderlying = async (req, res) => {
  try {
    const { symbol } = req.params;
    const interval = Number(req.query.interval || 15);
    if (!symbol) return res.status(400).json({ success: false, error: 'Symbol required' });

    const raw = await getIntradayData(symbol, interval);
    const candles = (raw?.candles || []).map(c => ({
      time: c.datetime || c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      oi: c.oi,
      delta: c.delta,
      gamma: c.gamma,
      theo: c.theo
    }));

    const { labels, thresholds, buffer } = evaluateFormulasOnCandles(candles);
    return res.json({ success: true, symbol, interval, candles, labels, thresholds, buffer });
  } catch (err) {
    console.error('getLabelsForUnderlying error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * MAIN: Stage 4 Scan
 * Accepts Stage 3 rows (each row representing an option)
 * Runs all 5 study formulas against each underlying's intraday data
 */
const scanStage3Rows = async (req, res) => {
  try {
    const { rows = [], interval = 15, studies = {} } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ success: false, error: 'rows required' });

    // 🔹 Group rows by underlying
    const byUnderlying = {};
    rows.forEach(r => {
      const u =
        r.sourceSymbol ||
        r.underlying ||
        r.symbol?.slice(0, r.symbol.length - 15) ||
        r.ticker ||
        r.baseSymbol;
      const key = (u || 'UNKNOWN').toUpperCase();
      if (!byUnderlying[key]) byUnderlying[key] = [];
      byUnderlying[key].push(r);
    });

    const underlyings = Object.keys(byUnderlying);
    if (underlyings.length === 0)
      return res.status(400).json({ success: false, error: 'No valid underlyings found' });

    // 🔹 Fetch intraday data for all underlyings
    const multi = await getMultipleIntradayData(underlyings, interval);

    const resultRows = [];

    for (const item of multi) {
      const u = item.symbol.toUpperCase();
      const rawData = item.data;
      const candles = (rawData?.candles || []).map(c => ({
        time: c.datetime || c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        oi: c.oi,
        delta: c.delta,
        gamma: c.gamma,
        theo: c.theo
      }));

      // 🔹 Evaluate all 5 studies (each with 5 labels)
      const studyLabels = {};
      for (let i = 1; i <= 5; i++) {
        const studyKey = `study${i}`;
        const cfg = studies[studyKey] || {};
        const formulas = Array.isArray(cfg.formulas) ? cfg.formulas : Array(5).fill('0');
        const thresholds = Array.isArray(cfg.thresholds)
          ? cfg.thresholds
          : Array(5).fill({ min: null, max: null });
        const buffer = typeof cfg.buffer === 'number' ? cfg.buffer : 0;

        // Apply study config dynamically
        setStudyConfig({ formulas, thresholds, buffer });

        const { labels, thresholds: thrSet, buffer: buf } = evaluateFormulasOnCandles(candles);

        // 🔸 Prepare label objects with evaluation status
        const labelObjects = (labels || []).map((v, j) => {
          const thr = thrSet?.[j] || { min: null, max: null };
          let status = 'unknown';
          if (v == null) status = 'unknown';
          else if (thr.min != null && v < thr.min) status = 'below';
          else if (thr.max != null && v > thr.max + (buf || 0)) status = 'farAbove';
          else if (thr.max != null && v > thr.max) status = 'above';
          else status = 'within';
          return { value: v, min: thr.min, max: thr.max, status };
        });

        studyLabels[studyKey] = labelObjects;
      }

      // 🔹 Attach study labels to each related row
      const rowsForU =
        byUnderlying[u] ||
        byUnderlying[u.replace('.', '')] ||
        byUnderlying[
          Object.keys(byUnderlying).find(k => k.includes(u)) || ''
        ] ||
        [];

      for (const r of rowsForU) {
        resultRows.push({ ...r, labels: studyLabels, underlying: u });
      }
    }

    return res.json({ success: true, rows: resultRows });
  } catch (err) {
    console.error('❌ scanStage3Rows error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  saveConfig,
  getLabelsForUnderlying,
  scanStage3Rows
};
