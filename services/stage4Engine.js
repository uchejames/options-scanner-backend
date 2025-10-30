// backend/services/stage4Engine.js
const { create, all } = require('mathjs');
const math = create(all);

// Configure mathjs to avoid dangerous functions
math.import({
  import: () => { throw new Error('import is disabled'); },
  createUnit: () => { throw new Error('createUnit is disabled'); }
}, { override: true });

/**
 * ✅ ENHANCED: Extract plot expressions with better def/plot handling
 */
function extractPlotExpressions(scriptText, inputs = {}) {
  if (!scriptText || typeof scriptText !== 'string') return { plots: [], defs: {} };
  
  const plots = [];
  const defs = {};
  
  let cleaned = scriptText
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\r\n/g, '\n');

  // Convert boolean operators early
  cleaned = cleaned.replace(/\band\b/gi, ' && ');
  cleaned = cleaned.replace(/\bor\b/gi, ' || ');

  // Extract and substitute input declarations
  const inputRegex = /input\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let inputMatch;
  while ((inputMatch = inputRegex.exec(cleaned)) !== null) {
    const inputName = inputMatch[1];
    const inputValue = inputMatch[2].trim();
    inputs[inputName] = inputs[inputName] || inputValue;
  }
  
  Object.keys(inputs).forEach(inputName => {
    const regex = new RegExp(`\\b${inputName}\\b`, 'g');
    cleaned = cleaned.replace(regex, inputs[inputName]);
  });

  // ✅ FIX #1: Extract ALL defs first (including plots as defs)
  // This allows plots to reference other plots
  const defRegex = /def\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let defMatch;
  while ((defMatch = defRegex.exec(cleaned)) !== null) {
    defs[defMatch[1]] = defMatch[2].trim();
  }

  // ✅ FIX #2: Extract plots and treat them as defs too
  const plotRegex = /plot\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let plotMatch;
  while ((plotMatch = plotRegex.exec(cleaned)) !== null) {
    const name = plotMatch[1];
    const exprRaw = plotMatch[2].trim();
    
    // Store plot as a def so other plots can reference it
    defs[name] = exprRaw;
    plots.push({ name, exprRaw });
  }

  return { plots, defs };
}

/**
 * ✅ ENHANCED: Normalize formula with better Highest/Lowest handling
 */
function normalizeFormula(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let s = raw;

  // Map TOS functions
  s = s.replace(/SimpleMovingAvg\s*\(/gi, 'sma(');
  s = s.replace(/Average\s*\(/gi, 'sma(');
  s = s.replace(/Highest\s*\(/gi, 'highest(');
  s = s.replace(/Lowest\s*\(/gi, 'lowest(');
  s = s.replace(/Max\s*\(/gi, 'max(');
  s = s.replace(/Min\s*\(/gi, 'min(');

  // Transform series[offset] notation
  s = s.replace(/(\b(?:open|high|low|close|volume|oi|delta|gamma|theo|mark|ask|bid))\s*\[\s*(\d+)\s*\]/gi,
    (_, name, n) => `off("${name}", ${n})`
  );

  // ✅ FIX: Quote series names in sma() calls
  s = s.replace(/sma\(\s*(\b(?:open|high|low|close|volume|oi|delta|gamma|theo|mark|ask|bid))\s*,\s*(\d+)(?:\s*,\s*(\d+)\s*)?\)/gi,
    (_, name, len, off) => {
      if (off) return `sma("${name}", ${len}, ${off})`;
      return `sma("${name}", ${len})`;
    }
  );

  // Remove TOS-specific styling
  s = s.replace(/SetDefaultColor\([^)]*\)/gi, '');
  s = s.replace(/SetPaintingStrategy\([^)]*\)/gi, '');
  s = s.replace(/declare\s+[A-Za-z0-9_()\s]*/gi, '');
  s = s.replace(/\.SetPaintingStrategy\([^)]*\)/gi, '');
  s = s.replace(/\.SetLineWeight\([^)]*\)/gi, '');
  s = s.replace(/\.SetDefaultColor\([^)]*\)/gi, '');
  s = s.replace(/AddLabel\([^)]*\)/gi, '');
  
  return s.trim();
}

function compileFormula(str) {
  const normalized = normalizeFormula(str);
  if (!normalized) return null;
  try {
    return math.parse(normalized);
  } catch (err) {
    console.error('Formula compile error:', err.message, 'for:', str);
    return null;
  }
}

/**
 * ✅ ENHANCED: Build series with smarter helpers
 */
function buildSeries(candles) {
  const series = {
    open: candles.map(c => c.open ?? 0),
    high: candles.map(c => c.high ?? 0),
    low: candles.map(c => c.low ?? 0),
    close: candles.map(c => c.close ?? 0),
    volume: candles.map(c => c.volume ?? 0),
    oi: candles.map(c => c.oi ?? 0),
    delta: candles.map(c => c.delta ?? 0),
    gamma: candles.map(c => c.gamma ?? 0),
    theo: candles.map(c => c.theo ?? 0),
    mark: candles.map(c => c.mark ?? 0),
    ask: candles.map(c => c.ask ?? 0),
    bid: candles.map(c => c.bid ?? 0)
  };

  const getAt = (arr, idx) => (idx >= 0 && idx < arr.length ? arr[idx] : 0);

  const ctxForIndex = (i, defSeries = {}) => {
    return {
      open: series.open[i],
      high: series.high[i],
      low: series.low[i],
      close: series.close[i],
      volume: series.volume[i],
      oi: series.oi[i],
      delta: series.delta[i],
      gamma: series.gamma[i],
      theo: series.theo[i],
      mark: series.mark[i],
      ask: series.ask[i],
      bid: series.bid[i],

      off: function(name, offset = 0) {
        const arr = series[name];
        if (!arr) return 0;
        const idx = i - Number(offset);
        return getAt(arr, idx);
      },

      sma: function(name, length = 1, offset = 0) {
        const arr = series[name];
        if (!arr) return 0;
        const vals = [];
        for (let k = 0; k < length; k++) {
          const idx = i - offset - k;
          if (idx < 0) break;
          vals.push(getAt(arr, idx));
        }
        if (vals.length === 0) return 0;
        return vals.reduce((a,b) => a + b, 0) / vals.length;
      },

      // ✅ FIXED: Enhanced highest() to handle def series properly
      highest: function(nameOrExpr, length = 1) {
        // If it's a def variable name, get its series
        if (typeof nameOrExpr === 'string' && defSeries[nameOrExpr]) {
          const arr = defSeries[nameOrExpr];
          const vals = [];
          for (let k = 0; k < length; k++) {
            const idx = i - k;
            if (idx < 0) break;
            vals.push(getAt(arr, idx));
          }
          return vals.length > 0 ? Math.max(...vals) : 0;
        }
        
        // If it's a raw series name
        if (typeof nameOrExpr === 'string' && series[nameOrExpr]) {
          const arr = series[nameOrExpr];
          const vals = [];
          for (let k = 0; k < length; k++) {
            const idx = i - k;
            if (idx < 0) break;
            vals.push(getAt(arr, idx));
          }
          return vals.length > 0 ? Math.max(...vals) : 0;
        }
        
        // If it's a number (shouldn't happen but handle gracefully)
        return typeof nameOrExpr === 'number' ? nameOrExpr : 0;
      },

      // ✅ FIXED: Enhanced lowest() to handle def series properly
      lowest: function(nameOrExpr, length = 1) {
        // If it's a def variable name, get its series
        if (typeof nameOrExpr === 'string' && defSeries[nameOrExpr]) {
          const arr = defSeries[nameOrExpr];
          const vals = [];
          for (let k = 0; k < length; k++) {
            const idx = i - k;
            if (idx < 0) break;
            vals.push(getAt(arr, idx));
          }
          return vals.length > 0 ? Math.min(...vals) : 0;
        }
        
        // If it's a raw series name
        if (typeof nameOrExpr === 'string' && series[nameOrExpr]) {
          const arr = series[nameOrExpr];
          const vals = [];
          for (let k = 0; k < length; k++) {
            const idx = i - k;
            if (idx < 0) break;
            vals.push(getAt(arr, idx));
          }
          return vals.length > 0 ? Math.min(...vals) : 0;
        }
        
        return typeof nameOrExpr === 'number' ? nameOrExpr : 0;
      }
    };
  };

  return { series, ctxForIndex };
}

/**
 * ✅ CRITICAL FIX: Build def series with proper dependency resolution
 * This is the key fix for your script - allows plots to reference other plots
 */
function buildDefSeries(candles, defs) {
  if (!defs || Object.keys(defs).length === 0) return {};
  
  const defValues = {};
  const { series, ctxForIndex } = buildSeries(candles);
  
  // Track evaluation order
  const defNames = Object.keys(defs);
  const evaluated = new Set();
  const evaluating = new Set(); // Track circular deps
  
  // Recursive evaluation with dependency resolution
  const evaluateDef = (defName) => {
    if (evaluated.has(defName)) return true;
    if (evaluating.has(defName)) {
      console.warn(`Circular dependency detected: ${defName}`);
      return false;
    }
    
    evaluating.add(defName);
    const defExpr = defs[defName];
    
    // Find dependencies in this expression
    const dependencies = defNames.filter(d => 
      d !== defName && 
      new RegExp(`\\b${d}\\b`).test(defExpr)
    );
    
    // Evaluate dependencies first
    for (const dep of dependencies) {
      if (!evaluateDef(dep)) {
        console.warn(`Failed to evaluate dependency ${dep} for ${defName}`);
      }
    }
    
    // Now evaluate this def
    const normalized = normalizeFormula(defExpr);
    let compiled = null;
    
    try {
      compiled = math.parse(normalized);
    } catch (err) {
      console.error(`Failed to compile def ${defName}:`, err.message);
      evaluating.delete(defName);
      evaluated.add(defName);
      return false;
    }
    
    if (!compiled) {
      evaluating.delete(defName);
      evaluated.add(defName);
      return false;
    }
    
    // Evaluate at each candle
    const values = candles.map((_, idx) => {
      const ctx = ctxForIndex(idx, defValues);
      const scope = {
        ...ctx,
        off: ctx.off,
        sma: ctx.sma,
        highest: ctx.highest,
        lowest: ctx.lowest,
        abs: Math.abs,
        min: Math.min,
        max: Math.max,
        log: Math.log,
        sqrt: Math.sqrt,
        pow: Math.pow
      };
      
      // Add all previously evaluated defs to scope
      Object.keys(defValues).forEach(d => {
        scope[d] = defValues[d][idx] || 0;
      });
      
      try {
        const v = compiled.evaluate(scope);
        return isFinite(Number(v)) ? Number(v) : 0;
      } catch (err) {
        // Don't spam console for every candle
        if (idx === 0) {
          console.error(`Def ${defName} eval error:`, err.message);
        }
        return 0;
      }
    });
    
    defValues[defName] = values;
    evaluating.delete(defName);
    evaluated.add(defName);
    return true;
  };
  
  // Evaluate all defs
  for (const defName of defNames) {
    evaluateDef(defName);
  }
  
  const unevaluated = defNames.filter(d => !evaluated.has(d));
  if (unevaluated.length > 0) {
    console.warn('Could not evaluate defs:', unevaluated);
  }
  
  return defValues;
}

/**
 * ✅ ENHANCED: Evaluate formulas on candles with full def support
 */
function evaluateFormulasOnCandles(candles, formulas = [], defs = {}) {
  if (!candles || candles.length === 0) {
    return { labels: (formulas || []).map(() => null), compiledCount: 0 };
  }

  const defSeries = buildDefSeries(candles, defs);
  const { ctxForIndex } = buildSeries(candles);
  const compiled = (Array.isArray(formulas) ? formulas : []).map(f => compileFormula(f));
  const lastIndex = candles.length - 1;

  const ctx = ctxForIndex(lastIndex, defSeries);
  const scope = {
    ...ctx,
    off: ctx.off,
    sma: ctx.sma,
    highest: ctx.highest,
    lowest: ctx.lowest,
    abs: Math.abs,
    min: Math.min,
    max: Math.max,
    log: Math.log,
    sqrt: Math.sqrt,
    pow: Math.pow
  };

  // Add all def values at last candle to scope
  Object.keys(defSeries).forEach(defName => {
    scope[defName] = defSeries[defName][lastIndex] || 0;
  });

  const labels = compiled.map((node, i) => {
    if (!node) return null;
    try {
      const v = node.evaluate(scope);
      
      // Convert booleans to 0/1
      if (typeof v === 'boolean') return v ? 1 : 0;
      
      const num = Number(v);
      return isFinite(num) ? num : null;
    } catch (err) {
      console.error(`Eval error formula idx ${i}:`, err.message);
      return null;
    }
  });

  return { labels, compiledCount: compiled.length };
}

/**
 * Evaluate multiple rows
 */
function evaluateRows(rows = [], studyScriptsFlat = [], studyScriptsRaw = {}) {
  let formulas = Array.isArray(studyScriptsFlat) ? [...studyScriptsFlat] : [];
  
  if ((!formulas || formulas.length === 0) && studyScriptsRaw && typeof studyScriptsRaw === 'object') {
    for (let s = 1; s <= 5; s++) {
      const key = `study${s}`;
      const script = studyScriptsRaw[key];
      if (!script) continue;
      const { plots } = extractPlotExpressions(script);
      const plotExprs = plots.map(p => p.exprRaw);
      for (const p of plotExprs) {
        formulas.push(p);
        if (formulas.length >= 25) break;
      }
      if (formulas.length >= 25) break;
    }
  }

  if (!Array.isArray(formulas)) formulas = [];
  if (formulas.length > 25) formulas = formulas.slice(0, 25);

  const out = rows.map((row) => {
    const candles = Array.isArray(row.candles) ? row.candles : (row.candlesRaw || []);
    
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
      const key = `study${idx + 1}`;
      result[key] = (v === null ? null : Number(v));
    });
    return result;
  });

  return out;
}

module.exports = {
  extractPlotExpressions,
  normalizeFormula,
  compileFormula,
  evaluateFormulasOnCandles,
  evaluateRows
};