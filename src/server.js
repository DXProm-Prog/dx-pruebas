require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { load, save, generateCode, generateId } = require("./store");
const { computeTrimmedMean, suggestedMinPercent } = require("./trimmedMean");
const { tallyOptions, determineWinner, runInstantRunoff } = require("./tally");
const { toCsv } = require("./csv");
const { notifyNewJoinRequest, notifyGroupCreated } = require("./email");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Grupos ----------

app.post("/api/groups", async (req, res) => {
  const { name, adminName, adminEmail, requireApproval, secretResponses } = req.body;
  if (!name || !adminName) {
    return res.status(400).json({ error: "Faltan campos: name, adminName" });
  }

  const db = await load();
  const code = generateCode();
  const adminId = generateId();

  db.groups[code] = {
    code,
    name,
    admin: { id: adminId, name: adminName, email: adminEmail || null },
    requireApproval: requireApproval !== false,
    secretResponses: secretResponses !== false,
    members: [{ id: adminId, name: adminName, approved: true }],
    questions: [],
    responses: [], // { id, questionId, memberId, memberName, value, roundNum?, timestamp }
    results: [],
  };
  await save(db);

  res.json({ code, adminId, group: db.groups[code] });

  notifyGroupCreated({
    adminEmail,
    groupName: name,
    code,
    frontendUrl: process.env.FRONTEND_URL,
  }).catch((err) => console.error("Error de correo (bienvenida):", err.message));
});

app.get("/api/groups/:code", async (req, res) => {
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  res.json(group);
});

app.post("/api/groups/:code/join", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Falta el campo: name" });

  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const memberId = generateId();
  const autoApprove = group.requireApproval === false;
  group.members.push({ id: memberId, name, approved: autoApprove });
  await save(db);

  res.json({ memberId, status: autoApprove ? "aprobado" : "pendiente de aprobación" });

  if (!autoApprove) {
    notifyNewJoinRequest({
      adminEmail: group.admin.email,
      groupName: group.name,
      applicantName: name,
      code: group.code,
      adminId: group.admin.id,
      frontendUrl: process.env.FRONTEND_URL,
    }).catch((err) => console.error("Error de correo (solicitud):", err.message));
  }
});

app.post("/api/groups/:code/members/:memberId/approve", async (req, res) => {
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const member = group.members.find((m) => m.id === req.params.memberId);
  if (!member) return res.status(404).json({ error: "Miembro no encontrado" });

  member.approved = true;
  await save(db);
  res.json(member);
});

app.post("/api/groups/:code/members/:memberId/reject", async (req, res) => {
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const before = group.members.length;
  group.members = group.members.filter((m) => m.id !== req.params.memberId);
  if (group.members.length === before) {
    return res.status(404).json({ error: "Miembro no encontrado" });
  }

  await save(db);
  res.json({ status: "rechazado" });
});

// ---------- Preguntas ----------
//
// type "promedio": numérica, se recorta y promedia.
// type "mayoria", con majorityRule:
//   - "simple":        gana la más votada.
//   - "absoluta":      necesita +50%.
//   - "calificada":    necesita +qualifiedPct% (definido por el admin).
//   - "rankeado":       cada quien ordena las opciones; la app calcula sola,
//                       por rondas de eliminación instantánea (IRV), quién gana.
//   - "segunda_vuelta": se vota una opción a la vez, por rondas. Al cerrar
//                       una ronda (por tiempo o por el admin) se eliminan
//                       las N menos votadas que se hayan configurado, y se
//                       vuelve a votar entre las que quedan.

function minutesFromNow(minutes) {
  if (!minutes || Number(minutes) <= 0) return null;
  return new Date(Date.now() + Number(minutes) * 60 * 1000).toISOString();
}

function computeResultForQuestion(group, question) {
  const relevant = group.responses.filter((r) => r.questionId === question.id);

  if (question.type === "mayoria" && question.majorityRule === "rankeado") {
    const ballots = relevant.map((r) => r.value);
    const out = runInstantRunoff(question.options, ballots);
    return { type: "mayoria", majorityRule: "rankeado", ...out };
  }

  if (question.type === "mayoria") {
    const values = relevant.map((r) => r.value);
    const { tally, totalVoters } = tallyOptions(question.options, values);
    const winner = determineWinner(tally, totalVoters, question.majorityRule, question.qualifiedPct);

    let tallyWithNames = null;
    if (group.secretResponses === false) {
      tallyWithNames = relevant.map((r) => ({ name: r.memberName, value: r.value }));
    }

    return { type: "mayoria", majorityRule: question.majorityRule, totalVoters, tally, winner, tallyWithNames };
  }

  // "promedio"
  const values = relevant.map((r) => r.value);
  const result = computeTrimmedMean(values, question.trimPercent);

  let sortedWithNames = null;
  if (group.secretResponses === false) {
    sortedWithNames = [...relevant]
      .sort((a, b) => a.value - b.value)
      .map((r) => ({ value: r.value, name: r.memberName }));
  }

  return {
    type: "promedio",
    suggestedMinPercent: suggestedMinPercent(result.n),
    sortedWithNames,
    ...result,
  };
}

// Cierra (si venció el tiempo) las preguntas normales de una sola etapa
// (promedio, simple, absoluta, calificada, rankeado).
function closeIfExpired(group, question) {
  if (question.majorityRule === "segunda_vuelta") return false;
  if (question.closed) return false;
  if (!question.closesAt) return false;
  if (new Date(question.closesAt) > new Date()) return false;

  question.closed = true;
  question.finalResult = computeResultForQuestion(group, question);
  group.results.push({ questionId: question.id, timestamp: new Date().toISOString(), ...question.finalResult });
  return true;
}

// Cierra la ronda actual de una pregunta de "segunda_vuelta": cuenta los
// votos de esa ronda, elimina las N menos votadas, y avanza a la
// siguiente ronda (o termina si ya no quedan suficientes opciones o se
// llegó al número máximo de rondas).
function closeCurrentRound(group, question) {
  const votes = group.responses
    .filter((r) => r.questionId === question.id && r.roundNum === question.currentRound)
    .map((r) => r.value);

  const { tally, totalVoters } = tallyOptions(question.currentOptions, votes);
  const sortedAsc = [...tally].sort((a, b) => a.count - b.count);
  const n = Math.min(question.elimPerRound, question.currentOptions.length - 1);
  const eliminated = sortedAsc.slice(0, n).map((t) => t.option);

  question.completedRounds.push({
    roundNum: question.currentRound,
    tally,
    totalVoters,
    eliminated,
    timestamp: new Date().toISOString(),
  });

  const remaining = question.currentOptions.filter((o) => !eliminated.includes(o));

  if (remaining.length <= 1 || question.currentRound >= question.numRounds) {
    question.finished = true;
    const sortedDesc = [...tally].sort((a, b) => b.count - a.count);
    question.winner = remaining.length === 1 ? remaining[0] : sortedDesc[0].option;
    question.roundClosesAt = null;
  } else {
    question.currentRound += 1;
    question.currentOptions = remaining;
    question.roundClosesAt = question.roundDurationMinutes ? minutesFromNow(question.roundDurationMinutes) : null;
  }

  group.results.push({
    questionId: question.id,
    timestamp: new Date().toISOString(),
    type: "mayoria",
    majorityRule: "segunda_vuelta",
    round: question.completedRounds[question.completedRounds.length - 1],
    finished: question.finished,
    winner: question.winner || null,
  });
}

function closeRoundIfExpired(question) {
  if (question.finished) return false;
  if (!question.roundClosesAt) return false;
  if (new Date(question.roundClosesAt) > new Date()) return false;
  return true; // el caller decide cuándo llamar a closeCurrentRound (necesita group)
}

app.post("/api/groups/:code/questions", async (req, res) => {
  const {
    type,
    text,
    trimPercent,
    options,
    majorityRule,
    qualifiedPct,
    closesInMinutes,
    numRounds,
    elimPerRound,
    roundDurationMinutes,
  } = req.body;

  if (!text || !type) {
    return res.status(400).json({ error: "Faltan campos: text, type" });
  }
  if (!["promedio", "mayoria"].includes(type)) {
    return res.status(400).json({ error: "type debe ser 'promedio' o 'mayoria'" });
  }
  if (type === "mayoria" && (!Array.isArray(options) || options.length < 2)) {
    return res.status(400).json({ error: "Las preguntas de mayoría necesitan al menos 2 opciones" });
  }
  if (
    type === "mayoria" &&
    !["simple", "absoluta", "calificada", "rankeado", "segunda_vuelta"].includes(majorityRule)
  ) {
    return res.status(400).json({ error: "majorityRule inválido" });
  }

  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const question = { id: generateId(), type, text };

  if (type === "promedio") {
    question.trimPercent = Number(trimPercent) || 0;
    question.closed = false;
    question.closesAt = minutesFromNow(closesInMinutes);
  } else {
    question.options = options.map((o) => String(o).trim()).filter(Boolean);
    question.majorityRule = majorityRule;

    if (majorityRule === "calificada") {
      question.qualifiedPct = Number(qualifiedPct) || 66;
    }

    if (majorityRule === "segunda_vuelta") {
      question.numRounds = Number(numRounds) || 3;
      question.elimPerRound = Number(elimPerRound) || 1;
      question.roundDurationMinutes = roundDurationMinutes ? Number(roundDurationMinutes) : null;
      question.currentRound = 1;
      question.currentOptions = question.options.slice();
      question.completedRounds = [];
      question.finished = false;
      question.winner = null;
      question.roundClosesAt = question.roundDurationMinutes ? minutesFromNow(question.roundDurationMinutes) : null;
    } else {
      question.closed = false;
      question.closesAt = minutesFromNow(closesInMinutes);
    }
  }

  group.questions.push(question);
  await save(db);

  res.json(question);
});

// Un miembro aprobado envía su propuesta/voto para una pregunta.
app.post("/api/groups/:code/questions/:questionId/responses", async (req, res) => {
  const { memberId, value } = req.body;
  if (!memberId || value === undefined) {
    return res.status(400).json({ error: "Faltan campos: memberId, value" });
  }

  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const member = group.members.find((m) => m.id === memberId && m.approved);
  if (!member) return res.status(403).json({ error: "Miembro no encontrado o no aprobado" });

  const question = group.questions.find((q) => q.id === req.params.questionId);
  if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });

  const responseRecord = {
    id: generateId(),
    questionId: question.id,
    memberId: member.id,
    memberName: member.name,
    timestamp: new Date().toISOString(),
  };

  if (question.type === "mayoria" && question.majorityRule === "segunda_vuelta") {
    if (closeRoundIfExpired(question)) {
      closeCurrentRound(group, question);
      await save(db);
    }
    if (question.finished) {
      return res.status(403).json({ error: "Esta pregunta ya terminó, no se aceptan más votos" });
    }
    if (!question.currentOptions.includes(value)) {
      return res.status(400).json({ error: "value debe ser una de las opciones de la ronda actual" });
    }
    responseRecord.value = value;
    responseRecord.roundNum = question.currentRound;
  } else if (question.type === "mayoria" && question.majorityRule === "rankeado") {
    if (closeIfExpired(group, question)) await save(db);
    if (question.closed) {
      return res.status(403).json({ error: "Esta pregunta ya cerró, no se aceptan más votos" });
    }
    const arr = Array.isArray(value) ? value : [value];
    const valid = arr.every((v) => question.options.includes(v)) && new Set(arr).size === arr.length;
    if (!valid || arr.length === 0) {
      return res.status(400).json({ error: "value debe ser un orden de una o más opciones válidas, sin repetir" });
    }
    responseRecord.value = arr;
  } else if (question.type === "mayoria") {
    if (closeIfExpired(group, question)) await save(db);
    if (question.closed) {
      return res.status(403).json({ error: "Esta pregunta ya cerró, no se aceptan más votos" });
    }
    if (!question.options.includes(value)) {
      return res.status(400).json({ error: "value debe ser una de las opciones de la pregunta" });
    }
    responseRecord.value = value;
  } else {
    if (closeIfExpired(group, question)) await save(db);
    if (question.closed) {
      return res.status(403).json({ error: "Esta pregunta ya cerró, no se aceptan más respuestas" });
    }
    const num = Number(value);
    if (isNaN(num)) return res.status(400).json({ error: "value debe ser un número" });
    responseRecord.value = num;
  }

  group.responses.push(responseRecord);
  await save(db);

  res.json({ status: "guardado" });
});

// El administrador cierra manualmente la ronda actual de una pregunta de
// segunda vuelta, para avanzar a la siguiente sin esperar el tiempo límite.
app.post("/api/groups/:code/questions/:questionId/close-round", async (req, res) => {
  const { memberId } = req.body;
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  if (group.admin.id !== memberId) return res.status(403).json({ error: "Solo el administrador puede cerrar la ronda" });

  const question = group.questions.find((q) => q.id === req.params.questionId);
  if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });
  if (question.majorityRule !== "segunda_vuelta") return res.status(400).json({ error: "Esta pregunta no usa rondas" });
  if (question.finished) return res.status(400).json({ error: "Esta pregunta ya terminó" });

  closeCurrentRound(group, question);
  await save(db);
  res.json(question);
});

// Calcula (o devuelve, si ya cerró) el resultado de una pregunta.
app.get("/api/groups/:code/questions/:questionId/results", async (req, res) => {
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const question = group.questions.find((q) => q.id === req.params.questionId);
  if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });

  if (question.majorityRule === "segunda_vuelta") {
    if (closeRoundIfExpired(question)) {
      closeCurrentRound(group, question);
      await save(db);
    }
    const liveTally = question.finished
      ? null
      : tallyOptions(
          question.currentOptions,
          group.responses
            .filter((r) => r.questionId === question.id && r.roundNum === question.currentRound)
            .map((r) => r.value)
        );
    return res.json({
      question,
      type: "mayoria",
      majorityRule: "segunda_vuelta",
      finished: question.finished,
      winner: question.winner,
      currentRound: question.currentRound,
      currentOptions: question.currentOptions,
      completedRounds: question.completedRounds,
      liveTally: liveTally ? liveTally.tally : null,
    });
  }

  const justClosed = closeIfExpired(group, question);
  const result = question.closed ? question.finalResult : computeResultForQuestion(group, question);

  if (!question.closed) {
    group.results.push({ questionId: question.id, timestamp: new Date().toISOString(), ...result });
  }
  if (justClosed || !question.closed) await save(db);

  res.json({
    question: { ...question, finalResult: undefined },
    secretResponses: group.secretResponses !== false,
    ...result,
  });
});

// ---------- Exportar ----------

app.get("/api/groups/:code/export/respuestas.csv", async (req, res) => {
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).send("Grupo no encontrado");

  const rows = [["fecha", "pregunta", "integrante", "valor"]];
  for (const r of group.responses) {
    const question = group.questions.find((q) => q.id === r.questionId);
    const valueText = Array.isArray(r.value) ? r.value.join(" > ") : r.value;
    rows.push([r.timestamp, question ? question.text : r.questionId, r.memberName, valueText]);
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${group.name}-respuestas.csv"`);
  res.send(toCsv(rows));
});

app.get("/api/groups/:code/export/resultados.csv", async (req, res) => {
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).send("Grupo no encontrado");

  const rows = [["fecha", "pregunta", "tipo", "detalle"]];
  for (const r of group.results) {
    const question = group.questions.find((q) => q.id === r.questionId);
    let detalle;
    if (r.type === "promedio") detalle = `decisión: ${r.average}`;
    else if (r.majorityRule === "segunda_vuelta") detalle = `ronda ${r.round.roundNum}, eliminadas: ${r.round.eliminated.join(", ")}${r.finished ? `, GANADOR: ${r.winner}` : ""}`;
    else if (r.majorityRule === "rankeado") detalle = `ganador: ${r.winner ?? "sin ganador"}`;
    else detalle = `ganador: ${r.winner ?? "sin ganador"} — ${JSON.stringify(r.tally)}`;
    rows.push([r.timestamp, question ? question.text : r.questionId, r.majorityRule || r.type, detalle]);
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${group.name}-resultados.csv"`);
  res.send(toCsv(rows));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor de Democracia por Promedio escuchando en http://localhost:${PORT}`);
});
