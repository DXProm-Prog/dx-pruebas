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

const crypto = require("crypto");
const { computeTrimmedMean } = require("./trimmedMean");
const { tallyOptions, determineWinner } = require("./tally");

// Revuelve una lista al azar de forma segura (no usa Math.random, que es
// predecible) — usado para el sorteo de puestos y responsabilidades.
function secureShuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Sortea los puestos entre los candidatos, ya sea una sola vez, o como
// un calendario rotativo de 12 meses.
//
// Regla del calendario rotativo: cada PUESTO tiene su propia bolsa de
// candidatos — nadie repite un puesto en particular hasta que todos
// los integrantes ya lo hayan ocupado al menos una vez. Cuando la
// bolsa de un puesto se vacía, se vuelve a llenar con todos los
// candidatos antes de seguir repartiendo. Además, dentro de un mismo
// mes se evita (cuando es posible) que una misma persona quede en dos
// puestos a la vez — si no hay más remedio (pocos candidatos, muchos
// puestos), se acepta la repetición ese mes.
function drawResponsabilidades(roles, candidates, frequency) {
  if (roles.length === 0 || candidates.length === 0) {
    throw new Error("Se necesitan puestos y candidatos para poder sortear");
  }

  if (frequency === "once") {
    const pool = secureShuffle(candidates);
    const assignment = {};
    roles.forEach((role) => {
      if (pool.length === 0) return;
      assignment[role.id] = pool.pop();
    });
    return { frequency: "once", assignment };
  }

  const poolsByRole = {};
  roles.forEach((role) => {
    poolsByRole[role.id] = secureShuffle(candidates);
  });

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const assignment = {};
    const takenThisMonth = new Set();
    roles.forEach((role) => {
      if (poolsByRole[role.id].length === 0) {
        poolsByRole[role.id] = secureShuffle(candidates);
      }
      // Busca, desde el final de la bolsa de ESTE puesto, a la primera
      // persona que todavía no haya quedado en otro puesto este mismo
      // mes — si todas ya salieron este mes (más puestos que
      // candidatos), simplemente se acepta la repetición.
      let idx = poolsByRole[role.id].length - 1;
      while (idx > 0 && takenThisMonth.has(poolsByRole[role.id][idx])) {
        idx--;
      }
      const person = poolsByRole[role.id].splice(idx, 1)[0];
      assignment[role.id] = person;
      takenThisMonth.add(person);
    });
    months.push({ month: m, assignment });
  }
  return { frequency: "monthly", months };
}

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
    winners: ranked.filter((r) => r.score > 0).slice(0, winnersCount).map((r) => r.option),
  };
}

// Calcula el resultado de la etapa ACTUAL de un flujo, según su tipo.
// `responses` ya viene filtrado: solo las respuestas de esta etapa.
function computeStageResult(stage, responses, flowConfig = {}) {
  const values = responses.map((r) => r.value);

  if (stage.type === "promedio") {
    const result = computeTrimmedMean(values, stage.config.trimPercent || 0);
    const output = { type: "promedio", ...result };
    // Solo la etapa de "cuota única" usa número de miembros (la etapa
    // "count", que también es tipo promedio, no aplica aquí).
    if (stage.key === "singleQuota") {
      const memberCount = flowConfig.memberCounts && flowConfig.memberCounts.single;
      if (memberCount) {
        output.memberCount = memberCount;
        output.totalCollected = Math.round(result.average * memberCount * 100) / 100;
      }
    }
    return output;
  }

  if (stage.type === "mayoria") {
    const { tally, totalVoters } = tallyOptions(stage.config.options, values);
    const winner = determineWinner(tally, totalVoters, stage.config.majorityRule, stage.config.qualifiedPct);
    return { type: "mayoria", tally, totalVoters, winner };
  }

  // Igual que "promedio", pero cada respuesta trae un número POR
  // CATEGORÍA (ej. { "Residentes": 620, "Locales comerciales": 1450 }),
  // y cada categoría se promedia por separado (con su propio recorte).
  // Si el administrador dio el número de miembros por categoría, también
  // se calcula cuánto se recaudaría de cada una, y el total general.
  if (stage.type === "promedio_por_categoria") {
    const categories = {};
    let totalCollected = 0;
    let hasMemberCounts = false;
    stage.config.categories.forEach((cat) => {
      const catValues = responses
        .map((r) => r.value && r.value[cat])
        .filter((v) => typeof v === "number" && !isNaN(v));
      categories[cat] = computeTrimmedMean(catValues, stage.config.trimPercent || 0);
      const memberCount = flowConfig.memberCounts && flowConfig.memberCounts[cat];
      if (memberCount) {
        hasMemberCounts = true;
        categories[cat].memberCount = memberCount;
        categories[cat].collected = Math.round(categories[cat].average * memberCount * 100) / 100;
        totalCollected += categories[cat].collected;
      }
    });
    return {
      type: "promedio_por_categoria",
      categories,
      totalCollected: hasMemberCounts ? Math.round(totalCollected * 100) / 100 : null,
    };
  }

  // Etapa de una sola respuesta (la del administrador): número de
  // miembros por categoría, o vacío si decidió omitirla.
  if (stage.type === "conteo_miembros") {
    const memberCounts = values.length ? values[values.length - 1] : {};
    return { type: "conteo_miembros", memberCounts, skipped: Object.keys(memberCounts).length === 0 };
  }

  if (stage.type === "recoleccion_abierta") {
    const pool = poolOpenText(values);
    return { type: "recoleccion_abierta", pool, totalResponses: responses.length };
  }

  // Cada miembro elige varias opciones (checkboxes) de una lista fija —
  // y también puede agregar categorías nuevas que no estaban ahí.
  // Se calcula qué % de la gente eligió (o agregó) cada una.
  if (stage.type === "seleccion_multiple") {
    const counts = {};
    stage.config.options.forEach((o) => (counts[o] = 0));
    values.forEach((arr) => {
      (Array.isArray(arr) ? arr : [arr]).forEach((raw) => {
        const o = String(raw).trim();
        if (!o) return;
        counts[o] = (counts[o] || 0) + 1;
      });
    });
    const totalVoters = values.length;
    const tally = Object.keys(counts)
      .map((o) => ({
        option: o,
        count: counts[o],
        percent: totalVoters > 0 ? Math.round((counts[o] / totalVoters) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count);
    return { type: "seleccion_multiple", tally, totalVoters };
  }

  // Cada miembro propone qué % del presupuesto le daría a cada
  // categoría. Se promedia cada categoría por separado, y si la suma de
  // los promedios pasa de 100%, se normaliza proporcionalmente para que
  // quede en 100% exacto.
  if (stage.type === "porcentaje_por_categoria") {
    const raw = {};
    const individualValues = {};
    stage.config.categories.forEach((cat) => {
      const vals = responses.map((r) => r.value && r.value[cat]).filter((v) => typeof v === "number" && !isNaN(v));
      individualValues[cat] = vals;
      raw[cat] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    });
    const sum = Object.values(raw).reduce((a, b) => a + b, 0);
    const totalBudget = stage.config.totalBudget || flowConfig.totalBudget || null;
    const categories = {};
    stage.config.categories.forEach((cat) => {
      const normalizedPercent = sum > 100 && sum > 0 ? Math.round(((raw[cat] / sum) * 100) * 10) / 10 : Math.round(raw[cat] * 10) / 10;
      categories[cat] = { rawAverage: Math.round(raw[cat] * 10) / 10, normalizedPercent, values: individualValues[cat] };
      if (totalBudget) {
        categories[cat].amount = Math.round((normalizedPercent / 100) * totalBudget * 100) / 100;
      }
    });
    return { type: "porcentaje_por_categoria", categories, rawSum: Math.round(sum * 10) / 10, wasNormalized: sum > 100, totalBudget };
  }

  if (stage.type === "ranking_multiganador") {
    const out = rankingMultiWinner(stage.config.options, values, stage.config.winnersCount || 1);
    return { type: "ranking_multiganador", ...out };
  }

  // Etapas de una sola respuesta (del facilitador): la lista final de
  // puestos, o la lista final de candidatos para el sorteo.
  if (stage.type === "configurar_puestos") {
    const roles = values.length ? values[values.length - 1].roles : [];
    return { type: "configurar_puestos", roles };
  }
  if (stage.type === "configurar_candidatos") {
    const candidates = values.length ? values[values.length - 1].candidates : [];
    return { type: "configurar_candidatos", candidates };
  }

  // Cada miembro propone un monto (no un %) para cada puesto — se
  // promedia cada puesto por separado. Si el flujo tiene un límite de
  // desigualdad activo (flowConfig.limitTimes), y el promedio final lo
  // rompe, se recorta hacia abajo el sueldo más alto (nunca se sube el
  // más bajo) hasta que la proporción quede dentro del límite.
  if (stage.type === "monto_por_puesto") {
    const trimPercent = stage.config.trimPercent ?? 10;
    const trimmed = {};
    stage.config.roles.forEach((role) => {
      const vals = responses.map((r) => r.value && r.value[role.id]).filter((v) => typeof v === "number" && !isNaN(v));
      trimmed[role.id] = computeTrimmedMean(vals, trimPercent);
    });
    const puestos = {};
    const limitTimes = stage.config.limitTimes || null;
    let wasAdjusted = false;
    if (limitTimes) {
      const minAvg = Math.min(...Object.values(trimmed).map((t) => t.average).filter((v) => v > 0));
      const allowedMax = minAvg * limitTimes;
      stage.config.roles.forEach((role) => {
        const original = Math.round(trimmed[role.id].average * 100) / 100;
        if (trimmed[role.id].average > allowedMax) {
          puestos[role.id] = { amount: Math.round(allowedMax * 100) / 100, original, adjusted: true, detail: trimmed[role.id] };
          wasAdjusted = true;
        } else {
          puestos[role.id] = { amount: original, original, adjusted: false, detail: trimmed[role.id] };
        }
      });
    } else {
      stage.config.roles.forEach((role) => {
        const amount = Math.round(trimmed[role.id].average * 100) / 100;
        puestos[role.id] = { amount, original: amount, adjusted: false, detail: trimmed[role.id] };
      });
    }
    return { type: "monto_por_puesto", puestos, limitTimes, wasAdjusted, trimPercent };
  }

  // Etapa de una sola respuesta (del facilitador): ingresos de la
  // cooperativa y desglose de sus gastos fijos.
  if (stage.type === "gastos_fijos") {
    const last = values.length ? values[values.length - 1] : { ingresos: 0, gastos: [] };
    return { type: "gastos_fijos", ingresos: last.ingresos || 0, gastos: last.gastos || [] };
  }

  // Cada miembro puede subir o bajar cada gasto fijo — se promedia cada
  // uno por separado (sin límite superior; el flujo solo avisa si
  // alguien lo baja, no lo impide).
  if (stage.type === "ajustar_gastos_fijos") {
    const gastos = stage.config.gastos.map((g) => {
      const vals = responses.map((r) => r.value && r.value[g.nombre]).filter((v) => typeof v === "number" && !isNaN(v));
      const amount = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : g.monto;
      return { nombre: g.nombre, montoOriginal: g.monto, montoFinal: amount };
    });
    const totalFinal = gastos.reduce((s, g) => s + g.montoFinal, 0);
    return { type: "ajustar_gastos_fijos", gastos, totalFinal: Math.round(totalFinal * 100) / 100 };
  }

  // Cuando el grupo rechazó la lista de candidatos: cada quien propone
  // a quién quitar (de la lista actual) y a quién agregar (nombres
  // nuevos). Un candidato se quita si más del 50% lo marcó para
  // eliminar; un nombre nuevo se agrega si más del 50% lo propuso.
  if (stage.type === "ajustar_candidatos") {
    const totalResponses = responses.length || 1;
    const removeCounts = {};
    const addCounts = {};
    const addDisplay = {};
    responses.forEach((r) => {
      const val = r.value || {};
      (val.remove || []).forEach((name) => {
        const key = String(name).trim();
        if (key) removeCounts[key] = (removeCounts[key] || 0) + 1;
      });
      (val.add || []).forEach((name) => {
        const trimmed = String(name).trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        addCounts[key] = (addCounts[key] || 0) + 1;
        if (!addDisplay[key]) addDisplay[key] = trimmed;
      });
    });
    const removed = stage.config.candidates.filter((c) => (removeCounts[c] || 0) / totalResponses > 0.5);
    const added = Object.keys(addCounts)
      .filter((key) => addCounts[key] / totalResponses > 0.5)
      .map((key) => addDisplay[key]);
    const finalCandidates = [...stage.config.candidates.filter((c) => !removed.includes(c)), ...added];
    return { type: "ajustar_candidatos", finalCandidates, removed, added };
  }

  // El facilitador revisa la lista y puede fusionar nombres que en
  // realidad son la misma persona (ej. "Ana García" y "Ana G."). El
  // nombre que se ve primero es el que el facilitador marcó como
  // correcto; los demás aparecen entre paréntesis.
  if (stage.type === "fusionar_candidatos") {
    const mergeGroups = values.length ? values[values.length - 1] : [];
    const mergedNames = new Set();
    mergeGroups.forEach((g) => {
      mergedNames.add(g.primary);
      (g.aliases || []).forEach((a) => mergedNames.add(a));
    });
    const untouched = stage.config.candidates.filter((c) => !mergedNames.has(c));
    const candidates = [
      ...mergeGroups.map((g) => (g.aliases && g.aliases.length ? `${g.primary} (${g.aliases.join(", ")})` : g.primary)),
      ...untouched,
    ];
    return { type: "fusionar_candidatos", candidates, mergeGroups };
  }

  // Cada quien propone qué rubros cree que son en realidad el mismo
  // (puede marcar varios grupos). Un par de rubros se fusiona si más
  // del 50% de quienes respondieron los marcó como el mismo — y si A
  // se fusiona con B, y B con C, los tres quedan juntos (unión
  // transitiva), aunque nadie haya marcado A y C directamente.
  if (stage.type === "fusionar_categorias") {
    const categories = stage.config.categories;
    const totalResponses = responses.length || 1;
    const pairCounts = {};
    const pairKey = (a, b) => [a, b].sort().join("|||");

    responses.forEach((r) => {
      const groups = Array.isArray(r.value) ? r.value : [];
      groups.forEach((group) => {
        if (!Array.isArray(group)) return;
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const key = pairKey(group[i], group[j]);
            pairCounts[key] = (pairCounts[key] || 0) + 1;
          }
        }
      });
    });

    const parent = {};
    categories.forEach((c) => (parent[c] = c));
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    Object.entries(pairCounts).forEach(([key, count]) => {
      if (count / totalResponses > 0.5) {
        const [a, b] = key.split("|||");
        if (categories.includes(a) && categories.includes(b)) union(a, b);
      }
    });

    const groupsMap = {};
    categories.forEach((c) => {
      const root = find(c);
      if (!groupsMap[root]) groupsMap[root] = [];
      groupsMap[root].push(c);
    });

    const mergedGroups = [];
    const finalCategories = [];
    Object.values(groupsMap).forEach((names) => {
      if (names.length > 1) {
        const primary = names[0];
        const aliases = names.slice(1);
        mergedGroups.push({ primary, aliases });
        finalCategories.push(`${primary} (${aliases.join(", ")})`);
      } else {
        finalCategories.push(names[0]);
      }
    });

    return { type: "fusionar_categorias", finalCategories, mergedGroups };
  }

  throw new Error(`Tipo de etapa desconocido: ${stage.type}`);
}

module.exports = { poolOpenText, rankingMultiWinner, computeStageResult, drawResponsabilidades };
