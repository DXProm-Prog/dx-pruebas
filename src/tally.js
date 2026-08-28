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
    const tiedWithTop = sorted.filter((t) => t.count === top.count);
    return tiedWithTop.length > 1 ? null : top.option;
  }

  return (top.count / totalVoters) * 100 > threshold ? top.option : null;
}

// Voto ranqueado (instant-runoff): cada boleta es un array de opciones en
// orden de preferencia (rankings parciales permitidos). Elimina la menos
// votada en cada ronda y reparte esos votos a la siguiente preferencia.
// IMPORTANTE: si al final quedan 2 (o más) opciones EMPATADAS sin que
// nadie llegue a mayoría, NO se declara ganador — se devuelve
// `tiedOptions` para que el caller abra una ronda de desempate real.
function runInstantRunoff(options, ballots) {
  let remaining = [...options];
  const rounds = [];
  let winner = null;
  let tiedOptions = null;

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

    if (hasMajority) {
      winner = sorted[0].option;
      rounds.push({ tally, eliminated: null, winner });
      break;
    }

    if (remaining.length <= 2) {
      const topCount = sorted[0].count;
      const tied = sorted.filter((t) => t.count === topCount).map((t) => t.option);
      if (tied.length > 1) {
        tiedOptions = tied;
        rounds.push({ tally, eliminated: null, winner: null, tie: true });
      } else {
        winner = sorted[0].option;
        rounds.push({ tally, eliminated: null, winner });
      }
      break;
    }

    const eliminated = sorted[sorted.length - 1].option;
    rounds.push({ tally, eliminated, winner: null });
    remaining = remaining.filter((o) => o !== eliminated);
  }

  return { rounds, winner, tiedOptions, totalVoters: ballots.length };
}

module.exports = { tallyOptions, determineWinner, runInstantRunoff };
