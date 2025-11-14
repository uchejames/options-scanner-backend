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
 * ✅ FIXED: Fetches intraday data for option symbols, then evaluates for each option
 */
const scanStage3Rows = async (req, res) => {
  try {
    const { rows = [], interval = 15, studies = {} } = req.body || {};
    
    console.log('🔥 Stage 4 Scan Request:', {
      rowCount: rows.length,
      interval,
      studyKeys: Object.keys(studies)
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'rows required' });
    }

    // 🔹 Extract unique OPTION symbols
    const symbolMap = new Map(); // symbol -> [rows]
    for (const row of rows) {
      const optionSymbol = row.symbol?.toUpperCase().trim();
      if (!optionSymbol) {
        console.warn(`⚠️ Row missing symbol:`, row);
        continue;
      }
      if (!symbolMap.has(optionSymbol)) {
        symbolMap.set(optionSymbol, []);
      }
      symbolMap.get(optionSymbol).push(row);
    }

    const optionSymbols = Array.from(symbolMap.keys());

    if (optionSymbols.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No valid option symbols found.' 
      });
    }

    console.log(`📊 Grouped ${rows.length} options into ${optionSymbols.length} unique symbols`);

    // 🔹 Fetch intraday data for ALL option symbols
    console.log(`📡 Fetching intraday data (${interval}m interval)...`);
    const multi = await getMultipleIntradayData(optionSymbols, interval);

    // Store candles by option symbol
    const candlesBySymbol = {};

    for (const item of multi) {
      const optionSymbol = item.symbol.toUpperCase();
      
      if (item.error) {
        console.error(`❌ Failed to fetch intraday data for ${optionSymbol}:`, item.error);
        continue;
      }

      const rawData = item.data;
      if (!rawData || !rawData.candles) {
        console.error(`❌ No candles in response for ${optionSymbol}`);
        continue;
      }

      const candles = rawData.candles.map(c => ({
        time: c.datetime || c.time,
        open: Number(c.open) || 0,
        high: Number(c.high) || 0,
        low: Number(c.low) || 0,
        close: Number(c.close) || 0,
        volume: Number(c.volume) || 0,
        oi: Number(c.oi) || 0,
        delta: Number(c.delta) || 0,
        gamma: Number(c.gamma) || 0,
        theo: Number(c.theo) || 0
      }));

      if (candles.length > 0) {
        candlesBySymbol[optionSymbol] = candles;
        console.log(`✅ Loaded ${candles.length} candles for ${optionSymbol}`);
      } else {
        console.warn(`⚠️ Empty candles array for ${optionSymbol}`);
      }
    }

    if (Object.keys(candlesBySymbol).length === 0) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch intraday data for any option symbols. Check Schwab API connection.'
      });
    }

    const resultRows = [];
    const errors = [];

    // ✅ Process each option row individually
    for (const row of rows) {
      const optionSymbol = (row.symbol || '').toUpperCase();
      
      if (!optionSymbol) {
        console.warn(`⚠️ Row missing symbol:`, row);
        errors.push({ row, error: 'Missing symbol' });
        continue;
      }

      const candles = candlesBySymbol[optionSymbol];
      
      if (!candles || candles.length === 0) {
        console.warn(`⚠️ No candles available for ${optionSymbol}`);
        errors.push({ symbol: optionSymbol, error: 'No intraday data available' });
        
        // Still add the row but with null study values
        const emptyLabels = {};
        for (let i = 1; i <= 25; i++) {
          emptyLabels[`study${i}`] = null;
        }
        resultRows.push({ ...row, ...emptyLabels });
        continue;
      }

      console.log(`\n🎯 Processing ${optionSymbol}: ${candles.length} candles`);

      // 🔹 Evaluate all 5 studies for THIS specific option
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

          if (plotFormulas.length === 0) {
            console.warn(`⚠️ No plot expressions found in study ${i}`);
            studyLabels[studyKey] = Array(5).fill(null).map(() => ({ 
              value: null, 
              status: 'empty' 
            }));
            continue;
          }

          // ✅ CRITICAL: Evaluate formulas for THIS OPTION'S candles
          const { labels } = evaluateFormulasOnCandles(candles, plotFormulas, defs);

          console.log(`  📊 Study ${i} for ${optionSymbol}:`, labels.slice(0, 5).map(v => 
            v === null ? 'null' : (Math.abs(v) < 0.01 ? v.toExponential(3) : v.toFixed(4))
          ));

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
          console.error(`❌ Error evaluating study ${i} for ${optionSymbol}:`, err.message);
          studyLabels[studyKey] = Array(5).fill(null).map(() => ({ 
            value: null, 
            status: 'error' 
          }));
        }
      }

      // 🔹 Flatten study labels into study1-study25 fields for THIS row
      const flattenedLabels = {};
      let labelIndex = 1;
      
      for (let s = 1; s <= 5; s++) {
        const studyKey = `study${s}`;
        const studyData = studyLabels[studyKey] || [];
        
        for (let l = 0; l < 5; l++) {
          const labelData = studyData[l] || { value: null, status: 'unknown' };
          const fieldKey = `study${labelIndex}`;
          flattenedLabels[fieldKey] = (labelData.value === null ? null : Number(labelData.value));
          labelIndex++;
        }
      }
      
      resultRows.push({ 
        ...row, 
        ...flattenedLabels, // study1, study2, ..., study25
        studyLabels, // Also keep nested structure for debugging
      });
    }

    console.log(`✅ Stage 4 scan complete: ${resultRows.length} rows processed`);

    if (errors.length > 0) {
      console.warn('⚠️ Some symbols had errors:', errors);
    }

    return res.json({ 
      success: true, 
      rows: resultRows,
      errors: errors.length > 0 ? errors : undefined,
      meta: {
        totalRows: rows.length,
        processedRows: resultRows.length,
        symbolsScanned: Object.keys(candlesBySymbol).length,
        errorCount: errors.length
      }
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