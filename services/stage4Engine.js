// backend/services/stage4Engine.js
// BULLETPROOF TOS Formula Engine - NO LIMITATIONS VERSION
const { create, all } = require('mathjs');
const math = create(all);

// Configure mathjs safely
math.import({
  import: () => { throw new Error('import is disabled'); },
  createUnit: () => { throw new Error('createUnit is disabled'); }
}, { override: true });

/**
 * Parse TOS script and extract plots, defs, and inputs
 */
function extractPlotExpressions(scriptText, userInputs = {}) {
  if (!scriptText || typeof scriptText !== 'string') {
    return { plots: [], defs: {}, inputs: {} };
  }
  
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
 * Smart argument parser that handles nested parentheses and functions
 */
function parseArguments(argsStr) {
  const args = [];
  let depth = 0;
  let current = '';
  
  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];
    
    if (char === '(' || char === '[') {
      depth++;
      current += char;
    } else if (char === ')' || char === ']') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  if (current.trim()) {
    args.push(current.trim());
  }
  
  return args;
}

/**
 * Recursively find and mark all aggregation function calls
 */
function findAggregationCalls(expr) {
  const calls = [];
  const regex = /(_sma_|_highest_|_lowest_)\s*\(/g;
  let match;
  
  while ((match = regex.exec(expr)) !== null) {
    const funcName = match[1];
    const startPos = match.index;
    const openParenPos = match.index + match[0].length - 1;
    
    // Find matching closing paren
    let depth = 1;
    let endPos = openParenPos + 1;
    
    while (depth > 0 && endPos < expr.length) {
      if (expr[endPos] === '(') depth++;
      else if (expr[endPos] === ')') depth--;
      endPos++;
    }
    
    if (depth === 0) {
      const argsStr = expr.substring(openParenPos + 1, endPos - 1);
      const fullCall = expr.substring(startPos, endPos);
      calls.push({
        funcName,
        startPos,
        endPos,
        fullCall,
        argsStr
      });
    }
  }
  
  return calls;
}

/**
 * Normalize TOS formula to mathjs-compatible format
 */
function normalizeFormula(raw, allDefs = {}) {
  if (!raw || typeof raw !== 'string') return '';

  let s = raw;

  // TOS function name normalization (case-insensitive)
  s = s.replace(/SimpleMovingAvg\s*\(/gi, '_sma_(');
  s = s.replace(/simplemovingavg\s*\(/gi, '_sma_(');
  s = s.replace(/Average\s*\(/gi, '_sma_(');
  
  s = s.replace(/Highest\s*\(/gi, '_highest_(');
  s = s.replace(/highest\s*\(/gi, '_highest_(');
  
  s = s.replace(/Lowest\s*\(/gi, '_lowest_(');
  s = s.replace(/lowest\s*\(/gi, '_lowest_(');
  
  s = s.replace(/Max\s*\(/gi, 'max(');
  s = s.replace(/Min\s*\(/gi, 'min(');

  // Handle series references with offsets: low[2] -> _off_("low", 2)
  s = s.replace(/\b(open|high|low|close|volume|oi|delta|gamma|theo|mark|ask|bid)\s*\[\s*(\d+)\s*\]/gi,
    (_, name, offset) => `_off_("${name.toLowerCase()}", ${offset})`
  );

  // Replace def variable references with their expressions (inline expansion)
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
 * Create basic evaluation context (for non-aggregation expressions)
 */
function createBasicContext(candles, candleIndex, defSeries = {}) {
  const { series, getAt } = buildSeries(candles);
  const i = candleIndex;

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
  
  // Add def series values at this candle
  Object.keys(defSeries).forEach(defName => {
    ctx[defName] = getAt(defSeries[defName], i);
  });
  
  return ctx;
}

/**
 * Evaluate a simple expression (no aggregations) across all candles
 */
function evaluateSimpleExpression(expr, candles, defSeries = {}) {
  const values = [];
  
  try {
    const parsed = math.parse(expr);
    
    for (let i = 0; i < candles.length; i++) {
      const ctx = createBasicContext(candles, i, defSeries);
      const result = parsed.evaluate(ctx);
      const num = Number(result);
      values.push(isFinite(num) ? num : 0);
    }
  } catch (err) {
    console.error(`Error evaluating simple expression "${expr}":`, err.message);
    return candles.map(() => 0);
  }
  
  return values;
}

/**
 * Apply aggregation function to a time series
 */
function applyAggregation(funcName, inputSeries, length, candles) {
  const result = [];
  const len = Math.max(1, Math.floor(Number(length)));
  
  for (let i = 0; i < candles.length; i++) {
    const vals = [];
    
    for (let k = 0; k < len; k++) {
      const idx = i - k;
      if (idx >= 0 && idx < inputSeries.length) {
        vals.push(inputSeries[idx]);
      }
    }
    
    if (vals.length === 0) {
      result.push(0);
      continue;
    }
    
    if (funcName === '_sma_') {
      const sum = vals.reduce((a, b) => a + b, 0);
      result.push(sum / vals.length);
    } else if (funcName === '_highest_') {
      result.push(Math.max(...vals));
    } else if (funcName === '_lowest_') {
      result.push(Math.min(...vals));
    } else {
      result.push(0);
    }
  }
  
  return result;
}

/**
 * Recursively evaluate formula with nested aggregations
 * This handles cases like: SimpleMovingAvg(SimpleMovingAvg(close, 5), 10)
 */
function evaluateFormulaRecursive(expr, candles, allDefs = {}, defSeries = {}, cache = new Map()) {
  // Check cache first
  if (cache.has(expr)) {
    return cache.get(expr);
  }
  
  // Normalize the expression
  const normalized = normalizeFormula(expr, allDefs);
  
  // Find all aggregation calls in this expression
  const aggCalls = findAggregationCalls(normalized);
  
  if (aggCalls.length === 0) {
    // No aggregations - evaluate as simple expression
    const result = evaluateSimpleExpression(normalized, candles, defSeries);
    cache.set(expr, result);
    return result;
  }
  
  // Process aggregations from innermost to outermost
  // Sort by position (later positions are processed first to avoid index shifting)
  aggCalls.sort((a, b) => b.startPos - a.startPos);
  
  let workingExpr = normalized;
  const tempSeries = new Map();
  let tempCounter = 0;
  
  // Replace each aggregation call with a temporary placeholder
  for (const call of aggCalls) {
    const { funcName, fullCall, argsStr } = call;
    
    // Parse arguments
    const args = parseArguments(argsStr);
    
    if (args.length < 2) {
      console.error(`Aggregation function ${funcName} requires at least 2 arguments`);
      continue;
    }
    
    const inputExpr = args[0];
    const lengthExpr = args[1];
    
    // Evaluate the length parameter (should be a constant)
    let length = 20; // default
    try {
      const lengthCtx = {
        abs: Math.abs, min: Math.min, max: Math.max,
        log: Math.log, sqrt: Math.sqrt, pow: Math.pow
      };
      length = Number(math.evaluate(lengthExpr, lengthCtx));
    } catch (err) {
      console.error(`Error evaluating length parameter: ${lengthExpr}`);
    }
    
    // Recursively evaluate the input expression (handles nested aggregations)
    const inputSeries = evaluateFormulaRecursive(inputExpr, candles, allDefs, defSeries, cache);
    
    // Apply the aggregation
    const resultSeries = applyAggregation(funcName, inputSeries, length, candles);
    
    // Create a temporary variable name and store the series
    const tempVar = `__temp${tempCounter++}__`;
    tempSeries.set(tempVar, resultSeries);
    
    // Replace the full call with the temp variable
    workingExpr = workingExpr.replace(fullCall, tempVar);
  }
  
  // Now evaluate the working expression with all temp series
  const values = [];
  
  try {
    const parsed = math.parse(workingExpr);
    
    for (let i = 0; i < candles.length; i++) {
      const ctx = createBasicContext(candles, i, defSeries);
      
      // Add temp series values at this candle
      tempSeries.forEach((series, varName) => {
        ctx[varName] = series[i] || 0;
      });
      
      const result = parsed.evaluate(ctx);
      const num = Number(result);
      values.push(isFinite(num) ? num : 0);
    }
  } catch (err) {
    console.error(`Error evaluating expression with temps:`, err.message);
    return candles.map(() => 0);
  }
  
  cache.set(expr, values);
  return values;
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
        // Evaluate this def across all candles using recursive evaluator
        const values = evaluateFormulaRecursive(defExpr, candles, defs, defSeries);
        defSeries[defName] = values;
        evaluated.add(defName);
        progress = true;
        
        const lastVal = values[values.length - 1];
        const displayVal = Math.abs(lastVal) < 0.01 ? lastVal.toExponential(4) : lastVal.toFixed(6);
        console.log(`✅ Evaluated def: ${defName} (${values.length} values, last: ${displayVal})`);
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
      const resultSeries = evaluateFormulaRecursive(formulaStr, candles, defs, defSeries);
      
      // Return the last value
      const lastValue = resultSeries[resultSeries.length - 1];
      
      if (typeof lastValue === 'boolean') {
        return lastValue ? 1 : 0;
      }
      
      const num = Number(lastValue);
      if (isFinite(num)) {
        const displayVal = Math.abs(num) < 0.01 ? num.toExponential(4) : num.toFixed(6);
        console.log(`✅ Formula ${idx + 1} result: ${displayVal}`);
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
          const { defs } = extractPlotExpressions(script);
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