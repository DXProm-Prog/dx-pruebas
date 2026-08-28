// Motor genérico para "flujos" de varias etapas encadenadas (a diferencia
// de las preguntas normales, que son independientes entre sí). Una etapa
// puede depender del resultado de la etapa anterior — por ejemplo,
// cuántos recuadros de texto libre mostrar, o cuáles opciones rankear.
//
// Este archivo solo tiene las piezas GENÉRICAS y reutilizables:
//  - cómo se calcula el resultado de cada TIPO de etapa.
//  - dos tipos de etapa nuevos que las preguntas normales no tienen:
//    "recoleccion_abierta" (texto libre agrupado) y "ranking_multiganador"
//    (voto por ranking que elige VARIOS ganadores, no solo uno).
//
// La lógica de "qué etapa sigue" para cada plantilla (Cuotas, Presupuesto)
// vive en archivos aparte (ver templates/cuotas.js en la Fase C2), no aquí.

const { computeTrimmedMean } = require("./trimmedMean");
const { tallyOptions, determineWinner } = require("./tally");

// Agrupa respuestas de texto libre (cada miembro puede enviar varias
// propuestas) y cuenta cuántas veces se repitió cada una, ignorando
// mayúsculas/minúsculas y espacios de más.
function poolOpenText(responseLists) {
  const counts = {};
  const displayText = {};

  responseLists.forEach((list) => {
    list.forEach((raw) => {
      const trimmed = String(raw).trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
      if (!displayText[key]) displayText[key] = trimmed;
    });
  });

  return Object.keys(counts)
    .map((key) => ({ text: displayText[key], count: counts[key] }))
    .sort((a, b) => b.count - a.count);
}

// Vota por ranking para elegir VARIOS ganadores a la vez (a diferencia
// del voto ranqueado normal, que elige solo uno). Usa conteo Borda: la
// primera preferencia de cada boleta vale más puntos que la segunda, y
// así sucesivamente. Se eligen las `winnersCount` opciones con más
// puntos en total.
function rankingMultiWinner(options, ballots, winnersCount) {
  const scores = {};
  options.forEach((o) => (scores[o] = 0));

  ballots.forEach((ballot) => {
    ballot.forEach((opt, idx) => {
      if (scores[opt] !== undefined) {
        scores[opt] += ballot.length - idx;
      }
    });
  });

  const ranked = options
    .map((o) => ({ option: o, score: scores[o] }))
    .sort((a, b) => b.score - a.score);

  return {
    ranked,
    winners: ranked.slice(0, winnersCount).map((r) => r.option),
  };
}

// Calcula el resultado de la etapa ACTUAL de un flujo, según su tipo.
// `responses` ya viene filtrado: solo las respuestas de esta etapa.
function computeStageResult(stage, responses) {
  const values = responses.map((r) => r.value);

  if (stage.type === "promedio") {
    const result = computeTrimmedMean(values, stage.config.trimPercent || 0);
    return { type: "promedio", ...result };
  }

  if (stage.type === "mayoria") {
    const { tally, totalVoters } = tallyOptions(stage.config.options, values);
    const winner = determineWinner(tally, totalVoters, stage.config.majorityRule, stage.config.qualifiedPct);
    return { type: "mayoria", tally, totalVoters, winner };
  }

  // Igual que "promedio", pero cada respuesta trae un número POR
  // CATEGORÍA (ej. { "Residentes": 620, "Locales comerciales": 1450 }),
  // y cada categoría se promedia por separado (con su propio recorte).
  if (stage.type === "promedio_por_categoria") {
    const categories = {};
    stage.config.categories.forEach((cat) => {
      const catValues = responses
        .map((r) => r.value && r.value[cat])
        .filter((v) => typeof v === "number" && !isNaN(v));
      categories[cat] = computeTrimmedMean(catValues, stage.config.trimPercent || 0);
    });
    return { type: "promedio_por_categoria", categories };
  }

  if (stage.type === "recoleccion_abierta") {
    const pool = poolOpenText(values);
    return { type: "recoleccion_abierta", pool };
  }

  if (stage.type === "ranking_multiganador") {
    const out = rankingMultiWinner(stage.config.options, values, stage.config.winnersCount || 1);
    return { type: "ranking_multiganador", ...out };
  }

  throw new Error(`Tipo de etapa desconocido: ${stage.type}`);
}

module.exports = { poolOpenText, rankingMultiWinner, computeStageResult };
