// Mismo motor de cálculo que el prototipo de frontend: promedio con
// recorte de extremos ("democracia por promedio").

function suggestedMinPercent(n) {
  if (n < 3) return 0;
  return Math.ceil(100 / n);
}

// values: array de números. trimPercent: el % que el administrador eligió
// (se respeta tal cual, incluso si no recorta a nadie).
function computeTrimmedMean(values, trimPercent) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const trimCount = Math.floor((n * trimPercent) / 100);
  const safeTrim = n - 2 * trimCount > 0 ? trimCount : Math.max(Math.floor((n - 1) / 2), 0);
  const kept = safeTrim > 0 ? sorted.slice(safeTrim, n - safeTrim) : sorted;
  const sum = kept.reduce((a, b) => a + b, 0);
  const average = kept.length ? sum / kept.length : 0;

  return {
    n,
    sorted,
    trimmedCount: safeTrim,
    kept,
    sum,
    average,
  };
}

module.exports = { suggestedMinPercent, computeTrimmedMean };
