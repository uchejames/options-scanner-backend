// backend/services/stage4Engine.js
// BULLETPROOF TOS Formula Engine - Handles Everything (FIXED)
const { create, all } = require('mathjs');
const math = create(all);

// Configure mathjs safely
math.import({
  import: () => { throw new Error('import is disabled'); },
  createUnit: () => { throw new Error('createUnit is disabled'); }
}, { override: true });

// Global temp def storage
let tempDefCounter = 0;

/**
 * Parse TOS script and extract plots, defs, and inputs
 */
function extractPlotExpressions(scriptText, userInputs = {}) {
  if (!scriptText || typeof scriptText !== 'string') {
    return { plots: [], defs: {}, inputs: {} };
  }
  
  tempDefCounter = 0; // Reset
  const plots = [];
  const defs = {};
  const inputs = {};
  
  // Clean script
  let script = scriptText
    .replace(/\/\/.*$/gm, '')          // Remove // comments
    .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove /* */ comments
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ');

  // Boolean operators (early conversion)
  script = script.replace(/\band\b/gi, ' && ');
  script = script.replace(/\bor\b/gi, ' || ');

  // Extract input declarations: input Length1 = 6;
  const inputRegex = /input\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let inputMatch;
  while ((inputMatch = inputRegex.exec(script)) !== null) {
    const name = inputMatch[1].trim();
    const value = inputMatch[2].trim();
    // Use user-provided value if available, otherwise use default
    inputs[name] = userInputs[name] !== undefined ? userInputs[name] : value;
  }
  
  // Replace input references throughout script
  Object.keys(inputs).forEach(inputName => {
    const regex = new RegExp(`\\b${inputName}\\b`, 'g');
    script = script.replace(regex, inputs[inputName]);
  });

  // Extract def declarations: def L = low;
  const defRegex = /def\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let defMatch;
  while ((defMatch = defRegex.exec(script)) !== null) {
    const name = defMatch[1].trim();
    const expr = defMatch[2].trim();
    defs[name] = expr;
  }

  // Extract plot declarations: plot LL = ...;
  const plotRegex = /plot\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let plotMatch;
  while ((plotMatch = plotRegex.exec(script)) !== null) {
    const name = plotMatch[1].trim();
    const expr = plotMatch[2].trim();
    plots.push({ name, exprRaw: expr });
  }
  
  console.log(`📋 Extracted: ${Object.keys(inputs).length} inputs, ${Object.keys(defs).length} defs, ${plots.length} plots`);
  
  return { plots, defs, inputs };
}

/**
 * Normalize TOS formula to mathjs-compatible format
 */
function normalizeFormula(raw, allDefs = {}) {
  if (!raw || typeof raw !== 'string') return '';

  let s = raw;

  // TOS function name normalization (case-insensitive)
  // Mark these specially so we can handle them later
  s = s.replace(/SimpleMovingAvg\s*\(/gi, '_sma_(');
  s = s.replace(/simplemovingavg\s*\(/gi, '_sma_(');
  s = s.replace(/Average\s*\(/gi, '_sma_(');
  
  s = s.replace(/Highest\s*\(/gi, '_highest_(');
  s = s.replace(/highest\s*\(/gi, '_highest_(');
  
  s = s.replace(/Lowest\s*\(/gi, '_lowest_(');
  s = s.replace(/lowest\s*\(/gi, '_lowest_(');
  
  s = s.replace(/Max\s*\(/gi, 'max(');
  s = s.replace(/max\s*\(/gi, 'max(');
  
  s = s.replace(/Min\s*\(/gi, 'min(');
  s = s.replace(/min\s*\(/gi, 'min(');

  // Handle series references with offsets: low[2] -> _off_("low", 2)
  s = s.replace(/\b(open|high|low|close|volume|oi|delta|gamma|theo|mark|ask|bid)\s*\[\s*(\d+)\s*\]/gi,
    (_, name, offset) => `_off_("${name.toLowerCase()}", ${offset})`
  );

  // Replace def variable references with their expressions (inline expansion)
  // Do this iteratively to handle nested defs
  let maxIterations = 20;
  let changed = true;
  while (changed && maxIterations-- > 0) {
    changed = false;
    Object.keys(allDefs).forEach(defName => {
      const regex = new RegExp(`\\b${defName}\\b`, 'g');
      if (regex.test(s)) {
        s = s.replace(regex, `(${allDefs[defName]})`);
        changed = true;
      }
    });
  }

  // Remove TOS styling commands
  s = s.replace(/\.SetDefaultColor\([^)]*\)/gi, '');
  s = s.replace(/\.SetPaintingStrategy\([^)]*\)/gi, '');
  s = s.replace(/\.SetLineWeight\([^)]*\)/gi, '');
  s = s.replace(/SetDefaultColor\([^)]*\)/gi, '');
  s = s.replace(/SetPaintingStrategy\([^)]*\)/gi, '');
  s = s.replace(/declare\s+[^;]*;/gi, '');
  s = s.replace(/AddLabel\([^)]*\)/gi, '');
  
  // Normalize case for standard series names
  s = s.replace(/\bLow\b/g, 'low');
  s = s.replace(/\bHigh\b/g, 'high');
  s = s.replace(/\bOpen\b/g, 'open');
  s = s.replace(/\bClose\b/g, 'close');
  s = s.replace(/\bVolume\b/g, 'volume');

  s = s.trim();
  return s;
}

/**
 * Check if expression contains aggregation functions
 */
function containsAggregation(expr) {
  return /_sma_|_highest_|_lowest_/.test(expr);
}

/**
 * Parse aggregation function calls
 */
function parseAggregationCall(expr) {
  const match = expr.match(/^(_sma_|_highest_|_lowest_)\((.*)\)$/);
  if (!match) return null;
  
  const funcName = match[1];
  const argsStr = match[2];
  
  // Parse arguments (simple approach - won't handle nested parens perfectly)
  const args = [];
  let depth = 0;
  let current = '';
  
  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current) args.push(current.trim());
  
  return { funcName, args };
}

/**
 * Build price series from candles
 */
function buildSeries(candles) {
  const series = {
    open: candles.map(c => Number(c.open) || 0),
    high: candles.map(c => Number(c.high) || 0),
    low: candles.map(c => Number(c.low) || 0),
    close: candles.map(c => Number(c.close) || 0),
    volume: candles.map(c => Number(c.volume) || 0),
    oi: candles.map(c => Number(c.oi) || 0),
    delta: candles.map(c => Number(c.delta) || 0),
    gamma: candles.map(c => Number(c.gamma) || 0),
    theo: candles.map(c => Number(c.theo) || 0),
    mark: candles.map(c => Number(c.mark) || 0),
    ask: candles.map(c => Number(c.ask) || 0),
    bid: candles.map(c => Number(c.bid) || 0)
  };

  const getAt = (arr, idx) => {
    if (!Array.isArray(arr)) return 0;
    if (idx < 0 || idx >= arr.length) return 0;
    const val = arr[idx];
    return (typeof val === 'number' && isFinite(val)) ? val : 0;
  };

  return { series, getAt };
}

/**
 * Evaluate expression across all candles to create a time series
 */
function evaluateExpressionSeries(expr, candles, defSeries = {}) {
  const { series, getAt } = buildSeries(candles);
  const values = [];
  
  for (let i = 0; i < candles.length; i++) {
    const ctx = {
      // Direct series access
      open: getAt(series.open, i),
      high: getAt(series.high, i),
      low: getAt(series.low, i),
      close: getAt(series.close, i),
      volume: getAt(series.volume, i),
      oi: getAt(series.oi, i),
      delta: getAt(series.delta, i),
      gamma: getAt(series.gamma, i),
      theo: getAt(series.theo, i),
      mark: getAt(series.mark, i),
      ask: getAt(series.ask, i),
      bid: getAt(series.bid, i),

      // Offset accessor
      _off_: function(seriesName, offset = 0) {
        const arr = series[seriesName];
        if (!arr) return 0;
        return getAt(arr, i - Number(offset));
      },

      // Math functions
      abs: Math.abs,
      min: Math.min,
      max: Math.max,
      log: Math.log,
      sqrt: Math.sqrt,
      pow: Math.pow,
      floor: Math.floor,
      ceil: Math.ceil,
      round: Math.round
    };
    
    // Add def series values
    Object.keys(defSeries).forEach(defName => {
      ctx[defName] = getAt(defSeries[defName], i);
    });
    
    try {
      const parsed = math.parse(expr);
      const result = parsed.evaluate(ctx);
      const num = Number(result);
      values.push(isFinite(num) ? num : 0);
    } catch (err) {
      console.error(`Error evaluating expression at candle ${i}:`, err.message);
      values.push(0);
    }
  }
  
  return values;
}

/**
 * Apply aggregation function to a time series
 */
function applyAggregation(funcName, inputSeries, length, candles) {
  const result = [];
  
  for (let i = 0; i < candles.length; i++) {
    const vals = [];
    
    if (funcName === '_sma_') {
      // Simple Moving Average
      for (let k = 0; k < length; k++) {
        const idx = i - k;
        if (idx >= 0 && idx < inputSeries.length) {
          vals.push(inputSeries[idx]);
        }
      }
      const sum = vals.reduce((a, b) => a + b, 0);
      result.push(vals.length > 0 ? sum / vals.length : 0);
      
    } else if (funcName === '_highest_') {
      // Highest value
      for (let k = 0; k < length; k++) {
        const idx = i - k;
        if (idx >= 0 && idx < inputSeries.length) {
          vals.push(inputSeries[idx]);
        }
      }
      result.push(vals.length > 0 ? Math.max(...vals) : 0);
      
    } else if (funcName === '_lowest_') {
      // Lowest value
      for (let k = 0; k < length; k++) {
        const idx = i - k;
        if (idx >= 0 && idx < inputSeries.length) {
          vals.push(inputSeries[idx]);
        }
      }
      result.push(vals.length > 0 ? Math.min(...vals) : 0);
    }
  }
  
  return result;
}

/**
 * Evaluate formula that may contain aggregations
 */
function evaluateFormulaWithAggregations(formula, candles, allDefs = {}, defSeries = {}) {
  const normalized = normalizeFormula(formula, allDefs);
  
  // Check if this is a simple aggregation call
  const aggCall = parseAggregationCall(normalized);
  
  if (aggCall && aggCall.args.length >= 2) {
    const { funcName, args } = aggCall;
    const inputExpr = args[0];
    const lengthExpr = args[1];
    
    // Check if input is a simple series name
    const seriesNames = ['open', 'high', 'low', 'close', 'volume', 'oi', 'delta', 'gamma', 'theo', 'mark', 'ask', 'bid'];
    const isSimpleSeries = seriesNames.includes(inputExpr.toLowerCase());
    
    // Evaluate length parameter
    const { series } = buildSeries(candles);
    const lengthCtx = {
      abs: Math.abs, min: Math.min, max: Math.max,
      log: Math.log, sqrt: Math.sqrt, pow: Math.pow
    };
    const lengthValue = Number(math.evaluate(lengthExpr, lengthCtx));
    
    let inputSeries;
    if (isSimpleSeries) {
      // Use the series directly
      inputSeries = series[inputExpr.toLowerCase()];
    } else {
      // Evaluate the expression across all candles first
      inputSeries = evaluateExpressionSeries(inputExpr, candles, defSeries);
    }
    
    // Apply aggregation function
    return applyAggregation(funcName, inputSeries, lengthValue, candles);
  }
  
  // If not an aggregation, evaluate normally
  return evaluateExpressionSeries(normalized, candles, defSeries);
}

/**
 * Evaluate all defs to create time series for each
 */
function buildDefSeries(candles, defs) {
  if (!defs || Object.keys(defs).length === 0) {
    return {};
  }

  const defNames = Object.keys(defs);
  const defSeries = {};
  const evaluated = new Set();
  
  console.log(`📊 Building def series for ${defNames.length} defs:`, defNames);

  // Multi-pass evaluation (handle dependencies)
  for (let pass = 0; pass < 20; pass++) {
    let progress = false;
    
    for (const defName of defNames) {
      if (evaluated.has(defName)) continue;
      
      const defExpr = defs[defName];
      
      // Check if this def depends on unevaluated defs
      const dependencies = defNames.filter(otherDef => 
        otherDef !== defName && 
        !evaluated.has(otherDef) && 
        new RegExp(`\\b${otherDef}\\b`).test(defExpr)
      );
      
      if (dependencies.length > 0) {
        continue; // Skip this def for now, dependencies not ready
      }
      
      try {
        // Evaluate this def across all candles
        const values = evaluateFormulaWithAggregations(defExpr, candles, defs, defSeries);
        defSeries[defName] = values;
        evaluated.add(defName);
        progress = true;
        console.log(`✅ Evaluated def: ${defName} (${values.length} values, last: ${values[values.length - 1]?.toFixed(6)})`);
      } catch (err) {
        console.error(`❌ Error evaluating def ${defName}:`, err.message);
      }
    }
    
    if (!progress) break;
  }
  
  const unevaluated = defNames.filter(d => !evaluated.has(d));
  if (unevaluated.length > 0) {
    console.warn(`⚠️  Could not evaluate ${unevaluated.length} defs:`, unevaluated);
  }
  
  return defSeries;
}

/**
 * Evaluate formulas on candle data
 */
function evaluateFormulasOnCandles(candles, formulas = [], defs = {}) {
  if (!candles || candles.length === 0) {
    console.warn('⚠️  No candles to evaluate');
    return { labels: formulas.map(() => null), compiledCount: formulas.length };
  }

  console.log(`🔬 Evaluating ${formulas.length} formulas on ${candles.length} candles`);
  
  // Build def time series first
  const defSeries = buildDefSeries(candles, defs);
  
  // Evaluate each plot formula
  const labels = formulas.map((formulaStr, idx) => {
    try {
      console.log(`\n📊 Evaluating formula ${idx + 1}: ${formulaStr}`);
      const resultSeries = evaluateFormulaWithAggregations(formulaStr, candles, defs, defSeries);
      
      // Return the last value
      const lastValue = resultSeries[resultSeries.length - 1];
      
      if (typeof lastValue === 'boolean') {
        return lastValue ? 1 : 0;
      }
      
      const num = Number(lastValue);
      if (isFinite(num)) {
        console.log(`✅ Formula ${idx + 1} result: ${num.toExponential(4)}`);
        return num;
      }
      
      console.warn(`⚠️  Formula ${idx + 1} returned non-finite: ${lastValue}`);
      return null;
    } catch (err) {
      console.error(`❌ Error evaluating formula ${idx + 1}:`, err.message);
      return null;
    }
  });

  return { labels, compiledCount: formulas.length };
}

/**
 * Evaluate rows (main entry point)
 */
function evaluateRows(rows = [], studyScriptsFlat = [], studyScriptsRaw = {}) {
  let formulas = Array.isArray(studyScriptsFlat) ? [...studyScriptsFlat] : [];
  
  // If no flat formulas, extract from raw scripts
  if ((!formulas || formulas.length === 0) && studyScriptsRaw && typeof studyScriptsRaw === 'object') {
    console.log('📜 Extracting formulas from raw scripts...');
    
    for (let s = 1; s <= 5; s++) {
      const key = `study${s}`;
      const script = studyScriptsRaw[key];
      if (!script) continue;
      
      const { plots } = extractPlotExpressions(script);
      for (const plot of plots) {
        formulas.push(plot.exprRaw);
        if (formulas.length >= 25) break;
      }
      if (formulas.length >= 25) break;
    }
  }

  if (!Array.isArray(formulas)) formulas = [];
  if (formulas.length > 25) formulas = formulas.slice(0, 25);

  console.log(`🚀 Processing ${rows.length} rows with ${formulas.length} formulas`);

  const results = rows.map((row, rowIdx) => {
    const candles = Array.isArray(row.candles) ? row.candles : (row.candlesRaw || []);
    
    if (candles.length === 0) {
      console.warn(`⚠️  Row ${rowIdx + 1} (${row.symbol}) has no candles`);
      return { symbol: row.symbol, labels: formulas.map(() => null) };
    }
    
    // Collect all defs from all scripts
    const allDefs = {};
    if (studyScriptsRaw && typeof studyScriptsRaw === 'object') {
      for (let s = 1; s <= 5; s++) {
        const key = `study${s}`;
        const script = studyScriptsRaw[key];
        if (script) {
          const { defs, inputs } = extractPlotExpressions(script);
          Object.assign(allDefs, defs);
        }
      }
    }
    
    const { labels } = evaluateFormulasOnCandles(candles, formulas, allDefs);
    
    const result = { symbol: row.symbol, labels: labels.slice() };
    labels.forEach((v, idx) => {
      result[`study${idx + 1}`] = (v === null ? null : Number(v));
    });
    
    return result;
  });

  return results;
}

module.exports = {
  extractPlotExpressions,
  normalizeFormula,
  evaluateFormulasOnCandles,
  evaluateRows
};