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
 * - Returns array of objects: { name, exprRaw }
 */
function extractPlotExpressions(scriptText) {
  if (!scriptText || typeof scriptText !== 'string') return [];
  const plots = [];
  // remove SetDefaultColor, comments and trailing semicolons handling
  const cleaned = scriptText
    .replace(/\/\/.*$/gm, '')          // remove // comments
    .replace(/\/\*[\s\S]*?\*\//g, '')  // remove /* ... */ comments
    .replace(/\r\n/g, '\n');

  // regex: find "plot NAME = <anything until ;>"
  const plotRegex = /plot\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi;
  let m;
  while ((m = plotRegex.exec(cleaned)) !== null) {
    const name = m[1];
    const exprRaw = m[2].trim();
    if (exprRaw) plots.push({ name, exprRaw });
  }
  return plots;
}

// ---------- Normalize TOS-like expressions to mathjs-friendly forms ----------
function normalizeFormula(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let s = raw;

  // common TOS functions -> map to our sma helper
  // SimpleMovingAvg(x, n) => sma(x, n)
  s = s.replace(/SimpleMovingAvg\s*\(/gi, 'sma(');
  s = s.replace(/Average\s*\(/gi, 'sma('); // sometimes 'Average'

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

  // Replace references like (low + close) / 2  — ok for mathjs
  // Remove TOS style function calls we don't support as-is (like SetDefaultColor)
  s = s.replace(/SetDefaultColor\([^)]*\)/gi, '');
  s = s.replace(/SetPaintingStrategy\([^)]*\)/gi, '');
  s = s.replace(/declare\s+[A-Za-z0-9_()\s]*/gi, '');

  // Replace double pipes or long boolean operators not used; keep expression simple
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

  const ctxForIndex = (i) => {
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
      }
    };
  };

  return { ctxForIndex };
}

// ---------- Evaluate a set of formulas on one candle series ----------
// formulas: array of formula strings (mathjs-compatible after normalization)
// returns { labels: [...numbers|null], compiledCount }
function evaluateFormulasOnCandles(candles, formulas = []) {
  const { ctxForIndex } = buildSeries(candles || []);
  const compiled = (Array.isArray(formulas) ? formulas : []).map(f => compileFormula(f));
  const lastIndex = (candles && candles.length) ? candles.length - 1 : -1;

  if (lastIndex < 0) {
    // return same-length array of nulls
    return { labels: compiled.map(() => null), compiledCount: compiled.length };
  }

  const ctx = ctxForIndex(lastIndex);
  const scope = {
    ...ctx,
    off: ctx.off,
    sma: ctx.sma,
    abs: Math.abs,
    min: Math.min,
    max: Math.max,
    log: Math.log
  };

  const labels = compiled.map((node, i) => {
    if (!node) return null;
    try {
      const v = node.evaluate(scope);
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
      const plots = extractPlotExpressions(script).map(p => p.exprRaw);
      for (const p of plots) {
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
    const { labels } = evaluateFormulasOnCandles(candles, formulas);
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
