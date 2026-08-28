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
    responses: [],
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
  if (group.members.length === before) return res.status(404).json({ error: "Miembro no encontrado" });
  await save(db);
  res.json({ status: "rechazado" });
});

// ---------- Preguntas ----------

function minutesFromNow(minutes) {
  if (!minutes || Number(minutes) <= 0) return null;
  return new Date(Date.now() + Number(minutes) * 60 * 1000).toISOString();
}

function computeResultForQuestion(group, question) {
  const relevant = group.responses.filter((r) => r.questionId === question.id && !r.tieBreakRound);

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

  const values = relevant.map((r) => r.value);
  const result = computeTrimmedMean(values, question.trimPercent);
  let sortedWithNames = null;
  if (group.secretResponses === false) {
    sortedWithNames = [...relevant].sort((a, b) => a.value - b.value).map((r) => ({ value: r.value, name: r.memberName }));
  }
  return { type: "promedio", suggestedMinPercent: suggestedMinPercent(result.n), sortedWithNames, ...result };
}

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

// Cierra la ronda actual de una pregunta de "segunda_vuelta". Elimina a
// TODAS las opciones sin votos o por debajo del % mínimo configurado
// (no un número fijo). Si al agotar las rondas asignadas hay un empate
// en el primer lugar, en vez de declarar ganador se abre una ronda extra
// SOLO con las opciones empatadas, repitiendo hasta que haya un ganador
// claro.
function closeCurrentRound(group, question) {
  const votes = group.responses
    .filter((r) => r.questionId === question.id && r.roundNum === question.currentRound)
    .map((r) => r.value);

  const { tally, totalVoters } = tallyOptions(question.currentOptions, votes);

  let survivors = tally.filter((t) => t.count > 0 && t.percent >= question.eliminationThresholdPercent).map((t) => t.option);
  if (survivors.length === 0) {
    // Si el umbral eliminaría a todos, nos quedamos con quien tenga más votos.
    const maxCount = Math.max(...tally.map((t) => t.count));
    survivors = tally.filter((t) => t.count === maxCount).map((t) => t.option);
  }
  const eliminated = question.currentOptions.filter((o) => !survivors.includes(o));

  question.completedRounds.push({
    roundNum: question.currentRound,
    tally,
    totalVoters,
    eliminated,
    tieBreak: Boolean(question.inTieBreak),
    timestamp: new Date().toISOString(),
  });

  const sortedDesc = [...tally].sort((a, b) => b.count - a.count);
  const topCount = sortedDesc[0].count;
  const tiedAtTop = sortedDesc.filter((t) => t.count === topCount).map((t) => t.option).filter((o) => survivors.includes(o));

  if (survivors.length === 1) {
    question.finished = true;
    question.winner = survivors[0];
    question.roundClosesAt = null;
    question.inTieBreak = false;
  } else if (!question.inTieBreak && question.currentRound < question.numRounds) {
    question.currentRound += 1;
    question.currentOptions = survivors;
    question.roundClosesAt = question.roundDurationMinutes ? minutesFromNow(question.roundDurationMinutes) : null;
  } else if (tiedAtTop.length > 1) {
    // Empate en el primer lugar: ronda extra solo con las empatadas.
    question.currentRound += 1;
    question.currentOptions = tiedAtTop;
    question.roundClosesAt = question.roundDurationMinutes ? minutesFromNow(question.roundDurationMinutes) : null;
    question.inTieBreak = true;
  } else {
    question.finished = true;
    question.winner = sortedDesc[0].option;
    question.roundClosesAt = null;
    question.inTieBreak = false;
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
  return new Date(question.roundClosesAt) <= new Date();
}

// Cierra la ronda de desempate de una pregunta de "rankeado" (se activa
// cuando el voto ranqueado automático termina en empate). Misma idea que
// segunda vuelta, pero sin eliminar por umbral: solo revisa si ya hay un
// ganador claro o si hay que abrir otra ronda de desempate.
function closeTieBreakRound(group, question) {
  const tb = question.tieBreak;
  const votes = group.responses
    .filter((r) => r.questionId === question.id && r.tieBreakRound === tb.currentRound)
    .map((r) => r.value);

  const { tally, totalVoters } = tallyOptions(tb.currentOptions, votes);
  const sortedDesc = [...tally].sort((a, b) => b.count - a.count);
  const topCount = sortedDesc[0].count;
  const tiedAtTop = sortedDesc.filter((t) => t.count === topCount).map((t) => t.option);

  tb.completedRounds.push({ roundNum: tb.currentRound, tally, totalVoters, timestamp: new Date().toISOString() });

  if (tiedAtTop.length === 1 && topCount > 0) {
    tb.finished = true;
    tb.winner = tiedAtTop[0];
    tb.roundClosesAt = null;
  } else {
    tb.currentRound += 1;
    tb.currentOptions = tiedAtTop.length > 1 ? tiedAtTop : tb.currentOptions;
    tb.roundClosesAt = null;
  }

  group.results.push({
    questionId: question.id,
    timestamp: new Date().toISOString(),
    type: "mayoria",
    majorityRule: "rankeado",
    tieBreakRound: tb.completedRounds[tb.completedRounds.length - 1],
    finished: tb.finished,
    winner: tb.winner || null,
  });
}

app.post("/api/groups/:code/questions", async (req, res) => {
  const {
    type, text, trimPercent, options, majorityRule, qualifiedPct,
    closesInMinutes, numRounds, eliminationThresholdPercent, roundDurationMinutes,
  } = req.body;

  if (!text || !type) return res.status(400).json({ error: "Faltan campos: text, type" });
  if (!["promedio", "mayoria"].includes(type)) return res.status(400).json({ error: "type debe ser 'promedio' o 'mayoria'" });
  if (type === "mayoria" && (!Array.isArray(options) || options.length < 2)) {
    return res.status(400).json({ error: "Las preguntas de mayoría necesitan al menos 2 opciones" });
  }
  if (type === "mayoria" && !["simple", "absoluta", "calificada", "rankeado", "segunda_vuelta"].includes(majorityRule)) {
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

    if (majorityRule === "calificada") question.qualifiedPct = Number(qualifiedPct) || 66;

    if (majorityRule === "segunda_vuelta") {
      question.numRounds = Number(numRounds) || 3;
      question.eliminationThresholdPercent = eliminationThresholdPercent !== undefined ? Number(eliminationThresholdPercent) : 10;
      question.roundDurationMinutes = roundDurationMinutes ? Number(roundDurationMinutes) : null;
      question.currentRound = 1;
      question.currentOptions = question.options.slice();
      question.completedRounds = [];
      question.finished = false;
      question.winner = null;
      question.inTieBreak = false;
      question.roundClosesAt = question.roundDurationMinutes ? minutesFromNow(question.roundDurationMinutes) : null;
    } else {
      question.closed = false;
      question.closesAt = minutesFromNow(closesInMinutes);
      if (majorityRule === "rankeado") question.tieBreak = null;
    }
  }

  group.questions.push(question);
  await save(db);
  res.json(question);
});

app.post("/api/groups/:code/questions/:questionId/responses", async (req, res) => {
  const { memberId, value } = req.body;
  if (!memberId || value === undefined) return res.status(400).json({ error: "Faltan campos: memberId, value" });

  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const member = group.members.find((m) => m.id === memberId && m.approved);
  if (!member) return res.status(403).json({ error: "Miembro no encontrado o no aprobado" });

  const question = group.questions.find((q) => q.id === req.params.questionId);
  if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });

  const responseRecord = { id: generateId(), questionId: question.id, memberId: member.id, memberName: member.name, timestamp: new Date().toISOString() };

  if (question.type === "mayoria" && question.majorityRule === "segunda_vuelta") {
    if (closeRoundIfExpired(question)) { closeCurrentRound(group, question); await save(db); }
    if (question.finished) return res.status(403).json({ error: "Esta pregunta ya terminó, no se aceptan más votos" });
    if (!question.currentOptions.includes(value)) return res.status(400).json({ error: "value debe ser una de las opciones de la ronda actual" });
    responseRecord.value = value;
    responseRecord.roundNum = question.currentRound;
  } else if (question.type === "mayoria" && question.majorityRule === "rankeado" && question.tieBreak && !question.tieBreak.finished) {
    const tb = question.tieBreak;
    if (tb.roundClosesAt && new Date(tb.roundClosesAt) <= new Date()) { closeTieBreakRound(group, question); await save(db); }
    if (question.tieBreak.finished) return res.status(403).json({ error: "Esta pregunta ya terminó, no se aceptan más votos" });
    if (!question.tieBreak.currentOptions.includes(value)) return res.status(400).json({ error: "value debe ser una de las opciones en desempate" });
    responseRecord.value = value;
    responseRecord.tieBreakRound = question.tieBreak.currentRound;
  } else if (question.type === "mayoria" && question.majorityRule === "rankeado") {
    if (closeIfExpired(group, question)) await save(db);
    if (question.closed) return res.status(403).json({ error: "Esta pregunta ya cerró, no se aceptan más votos" });
    const arr = Array.isArray(value) ? value : [value];
    const valid = arr.every((v) => question.options.includes(v)) && new Set(arr).size === arr.length;
    if (!valid || arr.length === 0) return res.status(400).json({ error: "value debe ser un orden de opciones válidas, sin repetir" });
    responseRecord.value = arr;
  } else if (question.type === "mayoria") {
    if (closeIfExpired(group, question)) await save(db);
    if (question.closed) return res.status(403).json({ error: "Esta pregunta ya cerró, no se aceptan más votos" });
    if (!question.options.includes(value)) return res.status(400).json({ error: "value debe ser una de las opciones de la pregunta" });
    responseRecord.value = value;
  } else {
    if (closeIfExpired(group, question)) await save(db);
    if (question.closed) return res.status(403).json({ error: "Esta pregunta ya cerró, no se aceptan más respuestas" });
    const num = Number(value);
    if (isNaN(num)) return res.status(400).json({ error: "value debe ser un número" });
    responseRecord.value = num;
  }

  group.responses.push(responseRecord);
  await save(db);
  res.json({ status: "guardado" });
});

// El administrador cierra manualmente la ronda actual (segunda vuelta) o
// la ronda de desempate (voto ranqueado empatado).
app.post("/api/groups/:code/questions/:questionId/close-round", async (req, res) => {
  const { memberId } = req.body;
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  if (group.admin.id !== memberId) return res.status(403).json({ error: "Solo el administrador puede cerrar la ronda" });

  const question = group.questions.find((q) => q.id === req.params.questionId);
  if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });

  if (question.majorityRule === "segunda_vuelta") {
    if (question.finished) return res.status(400).json({ error: "Esta pregunta ya terminó" });
    closeCurrentRound(group, question);
  } else if (question.majorityRule === "rankeado" && question.tieBreak && !question.tieBreak.finished) {
    closeTieBreakRound(group, question);
  } else {
    return res.status(400).json({ error: "Esta pregunta no tiene una ronda abierta para cerrar" });
  }

  await save(db);
  res.json(question);
});

app.get("/api/groups/:code/questions/:questionId/results", async (req, res) => {
  const db = await load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const question = group.questions.find((q) => q.id === req.params.questionId);
  if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });

  if (question.majorityRule === "segunda_vuelta") {
    if (closeRoundIfExpired(question)) { closeCurrentRound(group, question); await save(db); }
    const liveTally = question.finished
      ? null
      : tallyOptions(question.currentOptions, group.responses.filter((r) => r.questionId === question.id && r.roundNum === question.currentRound).map((r) => r.value)).tally;
    return res.json({
      question, type: "mayoria", majorityRule: "segunda_vuelta",
      finished: question.finished, winner: question.winner,
      currentRound: question.currentRound, currentOptions: question.currentOptions,
      completedRounds: question.completedRounds, liveTally, inTieBreak: question.inTieBreak,
    });
  }

  if (question.majorityRule === "rankeado") {
    if (!question.tieBreak) {
      const out = runInstantRunoff(question.options, group.responses.filter((r) => r.questionId === question.id && !r.tieBreakRound).map((r) => r.value));
      if (out.winner) {
        return res.json({ question, type: "mayoria", majorityRule: "rankeado", rounds: out.rounds, winner: out.winner, tieBreak: null });
      }
      if (out.tiedOptions) {
        question.tieBreak = { currentRound: 1, currentOptions: out.tiedOptions, completedRounds: [], finished: false, winner: null, roundClosesAt: null, originalRounds: out.rounds };
        await save(db);
      }
      return res.json({ question, type: "mayoria", majorityRule: "rankeado", rounds: out.rounds, winner: null, tieBreak: question.tieBreak });
    }
    if (question.tieBreak.roundClosesAt && new Date(question.tieBreak.roundClosesAt) <= new Date() && !question.tieBreak.finished) {
      closeTieBreakRound(group, question);
      await save(db);
    }
    const tb = question.tieBreak;
    const liveTally = tb.finished ? null : tallyOptions(tb.currentOptions, group.responses.filter((r) => r.questionId === question.id && r.tieBreakRound === tb.currentRound).map((r) => r.value)).tally;
    return res.json({ question, type: "mayoria", majorityRule: "rankeado", rounds: tb.originalRounds, winner: tb.finished ? tb.winner : null, tieBreak: { ...tb, liveTally } });
  }

  const justClosed = closeIfExpired(group, question);
  const result = question.closed ? question.finalResult : computeResultForQuestion(group, question);
  if (!question.closed) group.results.push({ questionId: question.id, timestamp: new Date().toISOString(), ...result });
  if (justClosed || !question.closed) await save(db);

  res.json({ question: { ...question, finalResult: undefined }, secretResponses: group.secretResponses !== false, ...result });
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
    else if (r.majorityRule === "rankeado") detalle = `${r.finished ? "GANADOR: " + r.winner : "sin ganador aún"}`;
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
