// backend/controllers/stage4Controller.js
const { evaluateFormulasOnCandles, extractPlotExpressions } = require('../services/stage4Engine');
const { getIntradayData, getMultipleIntradayData } = require('../services/intradayService');

/**
 * Save formulas + thresholds
 * ✅ DEPRECATED - kept for API compatibility but returns error
 */
const saveConfig = async (req, res) => {
  return res.status(501).json({ 
    success: false, 
    error: 'saveConfig endpoint deprecated - configuration now passed per-request' 
  });
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

    // Simple evaluation without thresholds for preview
    const { labels } = evaluateFormulasOnCandles(candles);
    return res.json({ success: true, symbol, interval, candles, labels });
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
    
    console.log('📥 Stage 4 Scan Request:', {
      rowCount: rows.length,
      interval,
      studyKeys: Object.keys(studies)
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'rows required' });
    }

    // 🔹 Group rows by underlying symbol
    const byUnderlying = {};
    rows.forEach(r => {
      // Extract underlying symbol from option symbol
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
    if (underlyings.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid underlyings found' });
    }

    console.log('📊 Grouped by underlyings:', underlyings);

    // 🔹 Fetch intraday data for all underlyings
    const multi = await getMultipleIntradayData(underlyings, interval);

    const resultRows = [];
    const errors = [];

    for (const item of multi) {
      const u = item.symbol.toUpperCase();
      
      if (item.error) {
        console.error(`❌ Failed to fetch intraday data for ${u}:`, item.error);
        errors.push({ symbol: u, error: item.error });
        continue;
      }

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

      if (candles.length === 0) {
        console.warn(`⚠️  No candles available for ${u}`);
        errors.push({ symbol: u, error: 'No intraday data available' });
        continue;
      }

      console.log(`✅ Processing ${u}: ${candles.length} candles`);

      // 🔹 Evaluate all 5 studies (each study has 1 formula that may output multiple plots)
      const studyLabels = {};
      
      for (let i = 1; i <= 5; i++) {
        const studyKey = `study${i}`;
        const cfg = studies[studyKey] || {};
        const formula = cfg.formula || '';
        const thresholds = Array.isArray(cfg.thresholds) ? cfg.thresholds : [];
        const inputs = cfg.inputs || {};

        if (!formula || formula.trim() === '') {
          // No formula provided, skip this study
          studyLabels[studyKey] = Array(5).fill(null).map(() => ({ 
            value: null, 
            status: 'empty' 
          }));
          continue;
        }

        try {
          // Extract plot expressions and defs from TOS script
          const { plots, defs } = extractPlotExpressions(formula, inputs);
          const plotFormulas = plots.map(p => p.exprRaw);

          console.log(`🔬 Study ${i} for ${u}:`, {
            plotCount: plots.length,
            defCount: Object.keys(defs).length,
            inputCount: Object.keys(inputs).length
          });

          // Evaluate formulas on candles
          const { labels } = evaluateFormulasOnCandles(candles, plotFormulas, defs);

          console.log(`📊 Study ${i} results for ${u}:`, labels.slice(0, 5));

          // Create label objects with threshold evaluation
          const labelObjects = labels.slice(0, 5).map((v, j) => {
            const thr = thresholds[j] || { min: null, max: null };
            let status = 'unknown';
            
            if (v === null || v === undefined) {
              status = 'unknown';
            } else {
              const hasMin = thr.min !== null && thr.min !== undefined;
              const hasMax = thr.max !== null && thr.max !== undefined;
              
              if (hasMin && v < thr.min) status = 'below';
              else if (hasMax && v > thr.max) status = 'above';
              else if (hasMin || hasMax) status = 'within';
              else status = 'noFilter';
            }
            
            return { value: v, min: thr.min, max: thr.max, status };
          });

          // Pad to 5 labels if needed
          while (labelObjects.length < 5) {
            labelObjects.push({ value: null, status: 'empty' });
          }

          studyLabels[studyKey] = labelObjects;

        } catch (err) {
          console.error(`❌ Error evaluating study ${i} for ${u}:`, err.message);
          studyLabels[studyKey] = Array(5).fill(null).map(() => ({ 
            value: null, 
            status: 'error' 
          }));
        }
      }

      // 🔹 Attach study labels to each related row
      const rowsForU = byUnderlying[u] || [];

      for (const r of rowsForU) {
        // Flatten study labels into study1-study25 fields
        const flattenedLabels = {};
        let labelIndex = 1;
        
        for (let s = 1; s <= 5; s++) {
          const studyKey = `study${s}`;
          const studyData = studyLabels[studyKey] || [];
          
          for (let l = 0; l < 5; l++) {
            const labelData = studyData[l] || { value: null, status: 'unknown' };
            const fieldKey = `study${labelIndex}`;
            flattenedLabels[fieldKey] = labelData.value; // Just the numeric value
            labelIndex++;
          }
        }
        
        resultRows.push({ 
          ...r, 
          ...flattenedLabels, // study1, study2, ..., study25 
          studyLabels, // Also keep nested structure for debugging
          underlying: u 
        });
      }
    }

    console.log(`✅ Stage 4 scan complete: ${resultRows.length} rows processed`);

    if (errors.length > 0) {
      console.warn('⚠️  Some symbols had errors:', errors);
    }

    return res.json({ 
      success: true, 
      rows: resultRows,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('❌ scanStage3Rows error:', err);
    return res.status(500).json({ 
      success: false, 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};

module.exports = {
  saveConfig,
  getLabelsForUnderlying,
  scanStage3Rows
};