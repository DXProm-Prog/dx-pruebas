// Conteo de votos para preguntas de "mayoría" en todas sus variantes:
// simple, absoluta, calificada, voto ranqueado y segunda vuelta.

function tallyOptions(options, values) {
  const counts = {};
  options.forEach((opt) => (counts[opt] = 0));

  values.forEach((val) => {
    if (counts[val] !== undefined) counts[val] += 1;
  });

  const totalVoters = values.length;
  const tally = options.map((opt) => ({
    option: opt,
    count: counts[opt],
    percent: totalVoters > 0 ? Math.round((counts[opt] / totalVoters) * 1000) / 10 : 0,
  }));

  return { tally, totalVoters };
}

// rule: "simple" (gana la más votada), "absoluta" (+50%), "calificada"
// (+qualifiedPct%). Devuelve la opción ganadora, o null si no hay ganador
// claro (empate en simple, o nadie llega al umbral en absoluta/calificada).
function determineWinner(tally, totalVoters, rule, qualifiedPct) {
  if (totalVoters === 0) return null;
  const sorted = [...tally].sort((a, b) => b.count - a.count);
  const top = sorted[0];
  if (top.count === 0) return null;

  const threshold = rule === "absoluta" ? 50 : rule === "calificada" ? qualifiedPct : null;

  if (threshold === null) {
    // simple
    const tiedWithTop = sorted.filter((t) => t.count === top.count);
    return tiedWithTop.length > 1 ? null : top.option;
  }

  return (top.count / totalVoters) * 100 > threshold ? top.option : null;
}

// Voto ranqueado (instant-runoff): cada boleta es un array de opciones en
// orden de preferencia (pueden ser rankings parciales). Elimina la menos
// votada en cada ronda y reparte esos votos a la siguiente preferencia,
// hasta que alguien tenga más del 50%.
function runInstantRunoff(options, ballots) {
  let remaining = [...options];
  const rounds = [];
  let winner = null;

  while (true) {
    const counts = {};
    remaining.forEach((o) => (counts[o] = 0));

    ballots.forEach((ballot) => {
      const top = ballot.find((o) => remaining.includes(o));
      if (top) counts[top] += 1;
    });

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const tally = remaining.map((o) => ({
      option: o,
      count: counts[o],
      percent: total > 0 ? Math.round((counts[o] / total) * 1000) / 10 : 0,
    }));
    const sorted = [...tally].sort((a, b) => b.count - a.count);
    const hasMajority = total > 0 && sorted[0].count / total > 0.5;

    let eliminated = null;
    let roundWinner = null;
    if (hasMajority || remaining.length <= 2) {
      roundWinner = sorted[0].option;
      winner = roundWinner;
    } else {
      eliminated = sorted[sorted.length - 1].option;
    }

    rounds.push({ tally, eliminated, winner: roundWinner });
    if (winner) break;
    remaining = remaining.filter((o) => o !== eliminated);
  }

  return { rounds, winner, totalVoters: ballots.length };
}

module.exports = { tallyOptions, determineWinner, runInstantRunoff };
