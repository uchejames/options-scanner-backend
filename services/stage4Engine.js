// backend/services/stage4Engine.js
const { create, all } = require('mathjs');
const math = create(all);

// Configure mathjs to avoid dangerous functions
math.import({
  // prevent access to dangerous things
  import: () => { throw new Error('import is disabled'); },
  createUnit: () => { throw new Error('createUnit is disabled'); },
  evaluate: math.evaluate,
  parse: math.parse
}, { override: true });

let currentConfig = {
  formulas: [
    '0','0','0','0','0'
  ],
  thresholds: [
    { min: -25, max: -20 },
    { min: -20, max: -15 },
    { min: -15, max: -10 },
    { min: -10, max: -5 },
    { min: -8,  max: -3 }
  ],
  buffer: 0 // optional buffer for dark-orange
};

function setStudyConfig({ formulas, thresholds, buffer }) {
  if (Array.isArray(formulas) && formulas.length === 5) currentConfig.formulas = formulas;
  if (Array.isArray(thresholds) && thresholds.length === 5) currentConfig.thresholds = thresholds;
  if (typeof buffer === 'number') currentConfig.buffer = buffer;
}

// helper: build series object from candles
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
  };

  const getAt = (arr, idx) => (idx >= 0 && idx < arr.length ? arr[idx] : 0);

  const ctxForIndex = (i) => {
    return {
      // current bar fields
      open: series.open[i],
      high: series.high[i],
      low: series.low[i],
      close: series.close[i],
      volume: series.volume[i],
      oi: series.oi[i],
      delta: series.delta[i],
      gamma: series.gamma[i],
      theo: series.theo[i],

      // helper functions for formulas
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
      }
    };
  };

  return { ctxForIndex };
}

// normalize TOS-like syntax to mathjs expressions
function normalizeFormula(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw;

  // transform e.g. close[2] -> off("close",2)
  s = s.replace(/(\b(?:open|high|low|close|volume|oi|delta|gamma|theo))\s*\[\s*(\d+)\s*\]/gi,
    (_, name, n) => `off("${name}", ${n})`
  );

  // transform sma(close,5) -> sma("close",5)
  s = s.replace(/sma\(\s*(\b(?:open|high|low|close|volume|oi|delta|gamma|theo))\s*,\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/gi,
    (_, name, len, off) => {
      if (off) return `sma("${name}", ${len}, ${off})`;
      return `sma("${name}", ${len})`;
    }
  );

  // allow basic math and functions only — mathjs parse will handle safety
  return s;
}

function compileFormula(str) {
  const normalized = normalizeFormula(str);
  if (!normalized.trim()) return null;
  try {
    return math.parse(normalized);
  } catch (err) {
    console.error('Formula compile error:', err.message, 'for:', str);
    return null;
  }
}

function evaluateFormulasOnCandles(candles) {
  const { ctxForIndex } = buildSeries(candles);
  const compiled = currentConfig.formulas.map(f => compileFormula(f));
  const lastIndex = candles.length - 1;
  if (lastIndex < 0) {
    return { labels: [null,null,null,null,null], thresholds: currentConfig.thresholds };
  }
  const ctx = ctxForIndex(lastIndex);

  const scope = {
    // spread ctx keys into scope for mathjs evaluate (the parse nodes will look up these names)
    ...ctx,
    // bind functions explicitly so mathjs can call them
    off: ctx.off,
    sma: ctx.sma,
    // Math helpers
    abs: Math.abs,
    min: Math.min,
    max: Math.max,
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

  return { labels, thresholds: currentConfig.thresholds, buffer: currentConfig.buffer };
}

module.exports = {
  setStudyConfig,
  evaluateFormulasOnCandles
};
