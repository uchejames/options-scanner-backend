// backend/services/stage4Engine.js
const { create, all } = require('mathjs');
const math = create(all);

// Configure mathjs to avoid dangerous functions
math.import({
  import: () => { throw new Error('import is disabled'); },
  createUnit: () => { throw new Error('createUnit is disabled'); }
}, { override: true });

// ---------- Utilities: parse TOS-like script to extract plot expressions ----------
/**
 * extractPlotExpressions
 * - Parses TOS/ThinkScript-like text and extracts RHS of `plot <name> = <expr>;` lines.
 * - Returns object: { plots: [{name, exprRaw}], defs: {...} }
 */
function extractPlotExpressions(scriptText, inputs = {}) {
  if (!scriptText || typeof scriptText !== 'string') return { plots: [], defs: {} };
  const plots = [];
  const defs = {};
  
  // remove SetDefaultColor, comments and trailing semicolons handling
  let cleaned = scriptText
    .replace(/\/\/.*$/gm, '')          // remove // comments
    .replace(/\/\*[\s\S]*?\*\//g, '')  // remove /* ... */ comments
    .replace(/\r\n/g, '\n');

  // ✅ FIX: Convert boolean operators EARLY (before substitution)
  cleaned = cleaned.replace(/\band\b/gi, ' && ');
  cleaned = cleaned.replace(/\bor\b/gi, ' || ');

  // Extract input declarations and use default values
  const inputRegex = /input\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let inputMatch;
  while ((inputMatch = inputRegex.exec(cleaned)) !== null) {
    const inputName = inputMatch[1];
    const inputValue = inputMatch[2].trim();
    // Use provided input or default value
    inputs[inputName] = inputs[inputName] || inputValue;
  }
  
  // Replace input references with their values
  Object.keys(inputs).forEach(inputName => {
    const regex = new RegExp(`\\b${inputName}\\b`, 'g');
    cleaned = cleaned.replace(regex, inputs[inputName]);
  });

  // Extract def declarations
  const defRegex = /def\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let defMatch;
  while ((defMatch = defRegex.exec(cleaned)) !== null) {
    defs[defMatch[1]] = defMatch[2].trim();
  }

  // ✅ FIX #2: Pre-process Highest/Lowest with expressions into temp defs
  let defCounter = 0;
  cleaned = cleaned.replace(/Highest\(\s*\(([^)]+)\)\s*,\s*(\d+)\s*\)/gi, (match, expr, period) => {
    const tempDef = `_tempHighest${defCounter++}`;
    defs[tempDef] = expr;
    return `Highest(${tempDef}, ${period})`;
  });

  cleaned = cleaned.replace(/Lowest\(\s*\(([^)]+)\)\s*,\s*(\d+)\s*\)/gi, (match, expr, period) => {
    const tempDef = `_tempLowest${defCounter++}`;
    defs[tempDef] = expr;
    return `Lowest(${tempDef}, ${period})`;
  });

  // regex: find "plot NAME = <anything until ;>"
  const plotRegex = /plot\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let m;
  while ((m = plotRegex.exec(cleaned)) !== null) {
    const name = m[1];
    let exprRaw = m[2].trim();
    
    // Substitute def variables in expression
    Object.keys(defs).forEach(defName => {
      const regex = new RegExp(`\\b${defName}\\b`, 'g');
      exprRaw = exprRaw.replace(regex, `(${defs[defName]})`);
    });
    
    if (exprRaw) plots.push({ name, exprRaw });
  }
  
  return { plots, defs };
}

// ---------- Normalize TOS-like expressions to mathjs-friendly forms ----------
function normalizeFormula(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let s = raw;

  // common TOS functions -> map to our sma helper
  // SimpleMovingAvg(x, n) => sma(x, n)
  s = s.replace(/SimpleMovingAvg\s*\(/gi, 'sma(');
  s = s.replace(/Average\s*\(/gi, 'sma('); // sometimes 'Average'
  
  // Add support for TOS built-in functions
  s = s.replace(/Highest\s*\(/gi, 'highest(');
  s = s.replace(/Lowest\s*\(/gi, 'lowest(');
  
  // Quote def variable names in highest/lowest calls
  // Pattern: highest(varName, n) where varName is a single word
  s = s.replace(/highest\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/gi, (match, varName) => {
    // Check if it's already quoted or is a series name
    if (['open', 'high', 'low', 'close', 'volume', 'oi', 'delta', 'gamma', 'theo', 'mark', 'ask', 'bid'].includes(varName.toLowerCase())) {
      return `highest("${varName}", `;
    }
    // It's likely a def variable name
    return `highest("${varName}", `;
  });
  
  s = s.replace(/lowest\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/gi, (match, varName) => {
    // Check if it's already quoted or is a series name
    if (['open', 'high', 'low', 'close', 'volume', 'oi', 'delta', 'gamma', 'theo', 'mark', 'ask', 'bid'].includes(varName.toLowerCase())) {
      return `lowest("${varName}", `;
    }
    // It's likely a def variable name
    return `lowest("${varName}", `;
  });
  
  s = s.replace(/Max\s*\(/gi, 'max(');
  s = s.replace(/Min\s*\(/gi, 'min(');

  // transform e.g. low[2] -> off("low",2)
  s = s.replace(/(\b(?:open|high|low|close|volume|oi|delta|gamma|theo|mark|ask|bid))\s*\[\s*(\d+)\s*\]/gi,
    (_, name, n) => `off("${name}", ${n})`
  );

  // transform sma(close,5,2) or sma(close,5) -> sma("close",5,2) or sma("close",5)
  s = s.replace(/sma\(\s*(\b(?:open|high|low|close|volume|oi|delta|gamma|theo|mark|ask|bid))\s*,\s*(\d+)(?:\s*,\s*(\d+)\s*)?\)/gi,
    (_, name, len, off) => {
      if (off) return `sma("${name}", ${len}, ${off})`;
      return `sma("${name}", ${len})`;
    }
  );

  // Replace references like (low + close) / 2 – ok for mathjs
  // Remove TOS style function calls we don't support as-is (like SetDefaultColor)
  s = s.replace(/SetDefaultColor\([^)]*\)/gi, '');
  s = s.replace(/SetPaintingStrategy\([^)]*\)/gi, '');
  s = s.replace(/declare\s+[A-Za-z0-9_()\s]*/gi, '');
  
  // Remove TOS-specific plot styling
  s = s.replace(/\.SetPaintingStrategy\([^)]*\)/gi, '');
  s = s.replace(/\.SetLineWeight\([^)]*\)/gi, '');
  s = s.replace(/\.SetDefaultColor\([^)]*\)/gi, '');
  
  // Remove AddLabel statements
  s = s.replace(/AddLabel\([^)]*\)/gi, '');
  
  // Trim whitespace
  s = s.trim();
  return s;
}

// ---------- Compile a normalized formula string into a mathjs node ----------
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

// ---------- Build series helpers for mathjs evaluation ----------
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

      // off(name, offset)
      off: function(name, offset = 0) {
        const arr = series[name];
        if (!arr) return 0;
        const idx = i - Number(offset);
        return getAt(arr, idx);
      },

      // sma(name, length, offset)
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

      // highest(seriesName or expression or defName, length) - lookback over series
      highest: function(expr, length = 1) {
        // Check if it's a def variable first
        if (typeof expr === 'string' && defSeries[expr]) {
          const arr = defSeries[expr];
          const vals = [];
          for (let k = 0; k < length; k++) {
            const idx = i - k;
            if (idx < 0) break;
            vals.push(getAt(arr, idx));
          }
          return vals.length > 0 ? Math.max(...vals) : 0;
        }
        // If expr is a string (series name), get the array
        if (typeof expr === 'string' && series[expr]) {
          const arr = series[expr];
          const vals = [];
          for (let k = 0; k < length; k++) {
            const idx = i - k;
            if (idx < 0) break;
            vals.push(getAt(arr, idx));
          }
          return vals.length > 0 ? Math.max(...vals) : 0;
        }
        // If expr is a number (already evaluated), can't do historical lookback
        return typeof expr === 'number' ? expr : 0;
      },

      // lowest(seriesName or expression or defName, length) - lookback over series
      lowest: function(expr, length = 1) {
        // Check if it's a def variable first
        if (typeof expr === 'string' && defSeries[expr]) {
          const arr = defSeries[expr];
          const vals = [];
          for (let k = 0; k < length; k++) {
            const idx = i - k;
            if (idx < 0) break;
            vals.push(getAt(arr, idx));
          }
          return vals.length > 0 ? Math.min(...vals) : 0;
        }
        // If expr is a string (series name), get the array
        if (typeof expr === 'string' && series[expr]) {
          const arr = series[expr];
          const vals = [];
          for (let k = 0; k < length; k++) {
            const idx = i - k;
            if (idx < 0) break;
            vals.push(getAt(arr, idx));
          }
          return vals.length > 0 ? Math.min(...vals) : 0;
        }
        // If expr is a number, return as-is
        return typeof expr === 'number' ? expr : 0;
      }
    };
  };

  return { ctxForIndex };
}

/**
 * ✅ FIX #4: Build cached series for complex def expressions with dependency resolution
 * This allows Highest(def_expr, n) to work properly
 */
function buildDefSeries(candles, defs) {
  if (!defs || Object.keys(defs).length === 0) return {};
  
  const defValues = {};
  const { ctxForIndex } = buildSeries(candles);
  
  // Sort defs by dependency order (simple: multiple passes)
  const defNames = Object.keys(defs);
  const evaluated = new Set();
  
  // Try to evaluate all defs, max 10 passes for dependency resolution
  for (let pass = 0; pass < 10; pass++) {
    let progress = false;
    
    for (const defName of defNames) {
      if (evaluated.has(defName)) continue;
      
      const defExpr = defs[defName];
      
      // Check if this def depends on unevaluated defs
      const dependencies = defNames.filter(d => 
        d !== defName && 
        !evaluated.has(d) && 
        new RegExp(`\\b${d}\\b`).test(defExpr)
      );
      
      if (dependencies.length > 0) continue; // Skip for now
      
      // Try to evaluate this def
      const normalized = normalizeFormula(defExpr);
      let compiled = null;
      
      try {
        compiled = math.parse(normalized);
      } catch (err) {
        console.error(`Failed to compile def ${defName}:`, err.message);
        evaluated.add(defName); // Mark as done to avoid infinite loop
        continue;
      }
      
      if (!compiled) {
        evaluated.add(defName);
        continue;
      }
      
      // ✅ FIX #3: Evaluate at each candle with proper context
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
        
        // ✅ FIX: Add already-evaluated defs to scope
        Object.keys(defValues).forEach(d => {
          scope[d] = defValues[d][idx] || 0;
        });
        
        try {
          const v = compiled.evaluate(scope);
          return isFinite(Number(v)) ? Number(v) : 0;
        } catch (err) {
          console.error(`Def ${defName} eval error at idx ${idx}:`, err.message);
          return 0;
        }
      });
      
      defValues[defName] = values;
      evaluated.add(defName);
      progress = true;
    }
    
    if (!progress) break; // No more defs can be evaluated
  }
  
  // Warn about unevaluated defs
  const unevaluated = defNames.filter(d => !evaluated.has(d));
  if (unevaluated.length > 0) {
    console.warn('Could not evaluate defs (circular dependency?):', unevaluated);
  }
  
  return defValues;
}

// ---------- Evaluate a set of formulas on one candle series ----------
// formulas: array of formula strings (mathjs-compatible after normalization)
// returns { labels: [...numbers|null], compiledCount }
function evaluateFormulasOnCandles(candles, formulas = [], defs = {}) {
  const defSeries = buildDefSeries(candles || [], defs);
  const { ctxForIndex } = buildSeries(candles || []);
  const compiled = (Array.isArray(formulas) ? formulas : []).map(f => compileFormula(f));
  const lastIndex = (candles && candles.length) ? candles.length - 1 : -1;

  if (lastIndex < 0) {
    // return same-length array of nulls
    return { labels: compiled.map(() => null), compiledCount: compiled.length };
  }

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

  // ✅ Add def values at last candle to scope
  Object.keys(defSeries).forEach(defName => {
    scope[defName] = defSeries[defName][lastIndex] || 0;
  });

  const labels = compiled.map((node, i) => {
    if (!node) return null;
    try {
      const v = node.evaluate(scope);
      
      // ✅ FIX #6: Convert booleans to 0/1 for display
      if (typeof v === 'boolean') return v ? 1 : 0;
      
      const num = Number(v);
      return isFinite(num) ? num : null;
    } catch (err) {
      console.error('Eval error formula idx', i, err.message);
      return null;
    }
  });

  return { labels, compiledCount: compiled.length };
}

// ---------- Evaluate multiple rows (symbols). Each row must include `candles` array ----------
/**
 * evaluateRows(rows, studyScriptsFlat)
 * - rows: [{ symbol, candles: [...] , ... }, ...]
 * - studyScriptsFlat: array of formula strings (flat order e.g. study1_label1, study1_label2, ... up to 25)
 * If studyScriptsFlat is empty or missing, engine will instead accept studyScriptsRaw: { study1: 'script text', ... }
 * and attempt to extract plots from those scripts (in plot order).
 *
 * Returns: array of results [{ symbol, labels: [...], study1: val, ..., studyN: val }, ...]
 */
function evaluateRows(rows = [], studyScriptsFlat = [], studyScriptsRaw = {}) {
  // If studyScriptsFlat empty but studyScriptsRaw provided, extract formulas from raw scripts
  let formulas = Array.isArray(studyScriptsFlat) ? [...studyScriptsFlat] : [];
  if ((!formulas || formulas.length === 0) && studyScriptsRaw && typeof studyScriptsRaw === 'object') {
    // attempt extraction in study1..study5 order, taking plot expressions in each script
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

  // fallback: ensure formulas array length <=25
  if (!Array.isArray(formulas)) formulas = [];
  if (formulas.length > 25) formulas = formulas.slice(0, 25);

  // Evaluate each row
  const out = rows.map((row) => {
    const candles = Array.isArray(row.candles) ? row.candles : (row.candlesRaw || []);
    
    // For evaluateRows, we need to collect all defs from all scripts
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
    // Build per-study fields study1..studyN where N = labels.length
    const result = { symbol: row.symbol, labels: labels.slice() };
    labels.forEach((v, idx) => {
      const key = `study${idx + 1}`; // study1..study25
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