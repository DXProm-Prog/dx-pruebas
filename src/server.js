require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { load, save, generateCode, generateId, getGroupsForUser, ensureProfile } = require("./store");
const { computeTrimmedMean, suggestedMinPercent } = require("./trimmedMean");
const { tallyOptions, determineWinner, runInstantRunoff } = require("./tally");
const { toCsv } = require("./csv");
const { notifyNewJoinRequest, notifyGroupCreated, notifyMemberJoined, notifyResultsToMembers, notifyProposalWinner } = require("./email");
const { computeStageResult } = require("./flowEngine");
const { TEMPLATES } = require("./templates");

// Si una sola consulta a la base de datos falla (ej. un problema pasajero
// de red o de configuración), que se quede solo en ESA petición y no
// tumbe el servidor entero para todos los demás grupos y usuarios.
process.on("unhandledRejection", (err) => {
  console.error("Error no manejado (el servidor sigue corriendo):", err);
});

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Grupos ----------

app.post("/api/groups", async (req, res) => {
  const { name, adminName, adminEmail, requireApproval, secretResponses, userId } = req.body;
  if (!name || !adminName) {
    return res.status(400).json({ error: "Faltan campos: name, adminName" });
  }

  const db = await load(req.params.code);
  const code = generateCode();
  const adminId = generateId();

  if (userId) await ensureProfile(userId, adminName);

  db.groups[code] = {
    code,
    name,
    admin: { id: adminId, name: adminName, email: adminEmail || null },
    requireApproval: requireApproval !== false,
    secretResponses: secretResponses !== false,
    members: [{ id: adminId, name: adminName, approved: true, email: adminEmail || null, userId: userId || null }],
    questions: [],
    responses: [],
    results: [],
    flows: [],
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

// Todos los grupos de una persona con cuenta (para "Mis grupos").
app.get("/api/my-groups", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Falta userId" });
  try {
    const groups = await getGroupsForUser(userId);
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/groups/:code", async (req, res) => {
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  let changed = false;
  (group.flows || []).forEach((flow) => {
    if (flow.licitacion && checkLicitacionTimers(flow.licitacion, flow.config || {})) changed = true;
  });
  if (changed) await save(db);

  res.json(group);
});

app.post("/api/groups/:code/join", async (req, res) => {
  const { name, email, userId } = req.body;
  if (!name) return res.status(400).json({ error: "Falta el campo: name" });

  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const memberId = generateId();
  const autoApprove = group.requireApproval === false;
  if (userId) await ensureProfile(userId, name);
  group.members.push({ id: memberId, name, email: email || null, approved: autoApprove, userId: userId || null });
  await save(db);

  res.json({ memberId, status: autoApprove ? "aprobado" : "pendiente de aprobación" });

  if (email) {
    notifyMemberJoined({
      memberEmail: email,
      memberName: name,
      groupName: group.name,
      code: group.code,
      frontendUrl: process.env.FRONTEND_URL,
    }).catch((err) => console.error("Error de correo (bienvenida miembro):", err.message));
  }

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
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  const member = group.members.find((m) => m.id === req.params.memberId);
  if (!member) return res.status(404).json({ error: "Miembro no encontrado" });
  member.approved = true;
  await save(db);
  res.json(member);
});

app.post("/api/groups/:code/members/:memberId/reject", async (req, res) => {
  const db = await load(req.params.code);
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

function buildResultSummary(question, result) {
  if (result.type === "promedio") {
    return `"${question.text}"\nDecisión colectiva: ${result.average.toFixed(2)} (${result.n} propuestas, se recortaron ${result.trimmedCount} de cada extremo).`;
  }
  if (result.winner) {
    return `"${question.text}"\nGanó: ${result.winner}`;
  }
  return `"${question.text}"\nTodavía no hay un ganador claro.`;
}

function closeIfExpired(group, question) {
  if (question.majorityRule === "segunda_vuelta") return false;
  if (question.closed) return false;
  if (!question.closesAt) return false;
  if (new Date(question.closesAt) > new Date()) return false;
  question.closed = true;
  question.finalResult = computeResultForQuestion(group, question);
  group.results.push({ questionId: question.id, timestamp: new Date().toISOString(), ...question.finalResult });
  notifyResultsToMembers({
    group,
    questionText: question.text,
    summaryText: buildResultSummary(question, question.finalResult),
    frontendUrl: process.env.FRONTEND_URL,
    subjectPrefix: "Ya hay resultado",
  }).catch((err) => console.error("Error de correo (resultado):", err.message));
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

  if (question.finished) {
    notifyResultsToMembers({
      group,
      questionText: question.text,
      summaryText: `"${question.text}"\nGanó: ${question.winner}`,
      frontendUrl: process.env.FRONTEND_URL,
      subjectPrefix: "Ya hay resultado",
    }).catch((err) => console.error("Error de correo (resultado):", err.message));
  }
}

function closeRoundIfExpired(question) {
  if (question.finished) return false;
  if (!question.roundClosesAt) return false;
  return new Date(question.roundClosesAt) <= new Date();
}

// Cierra la ronda de desempate de una pregunta de "rankeado" (se activa
// cuando el voto ranqueado automático termina en empate).
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

  if (tb.finished) {
    notifyResultsToMembers({
      group,
      questionText: question.text,
      summaryText: `"${question.text}"\nGanó: ${tb.winner}`,
      frontendUrl: process.env.FRONTEND_URL,
      subjectPrefix: "Ya hay resultado",
    }).catch((err) => console.error("Error de correo (resultado):", err.message));
  }
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

  const db = await load(req.params.code);
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

  const db = await load(req.params.code);
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
  const db = await load(req.params.code);
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
  const db = await load(req.params.code);
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
        notifyResultsToMembers({
          group,
          questionText: question.text,
          summaryText: `"${question.text}"\nHubo un empate entre: ${out.tiedOptions.join(", ")}. Se necesita una ronda de desempate — entra a votar de nuevo.`,
          frontendUrl: process.env.FRONTEND_URL,
          subjectPrefix: "Se necesita un desempate",
        }).catch((err) => console.error("Error de correo (desempate):", err.message));
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

// ---------- Flujos (Cuotas, Presupuesto, etc) ----------

// Arranca el sistema de propuestas y votación ("licitación") de un
// flujo de presupuesto, usando las categorías ya decididas en su etapa
// "budget". Cada categoría empieza en "collecting" (recibiendo
// propuestas). No es una etapa más del flujo — vive aparte, en
// flow.licitacion, porque varias categorías avanzan de forma
// independiente entre sí.
function initLicitacion(flow) {
  const budgetStage = [...flow.stages].reverse().find((s) => s.key === "budget");
  const categories = budgetStage ? Object.keys(budgetStage.result.categories) : [];
  const categoryState = {};
  categories.forEach((cat) => {
    categoryState[cat] = {
      status: "collecting",
      winner: null,
      round: 1,
      closesAt: null,
      monthlyBudget: budgetStage.result.categories[cat].amount ?? null,
    };
  });
  return {
    proposals: [],
    votes: [],
    categories: categoryState,
    // config.tieRoundMinutes / config.reopenEmptyMinutes: cuánto dura la
    // ventana de tiempo de una ronda de desempate, o de la reapertura de
    // una categoría vacía. Si no se configura, el administrador cierra a
    // mano cuando decida.
  };
}

// Cierra la recolección de propuestas de UNA categoría específica (sirve
// tanto para la primera recolección, como para una ronda de desempate,
// como para la reapertura de una categoría vacía). Si sigue sin
// propuestas después de haber agotado sus 3 intentos, se marca
// "empty_closed" en definitiva.
function closeCategoryCollecting(licitacion, cat) {
  const state = licitacion.categories[cat];
  const hasProposals = licitacion.proposals.some((p) => p.category === cat);
  if (hasProposals) {
    state.status = "voting";
  } else {
    state.status = state.round >= 3 ? "empty_closed" : "empty";
  }
  state.closesAt = null;
}

// Cierra la recolección inicial de TODAS las categorías a la vez (lo que
// se usa la primera vez que se abren propuestas).
function closeLicitacionCollecting(licitacion) {
  Object.keys(licitacion.categories).forEach((cat) => {
    if (licitacion.categories[cat].status === "collecting") closeCategoryCollecting(licitacion, cat);
  });
}

// Cuenta los votos de la ronda actual de una categoría y decide si hay
// ganador o empate.
function tallyCategory(licitacion, cat) {
  const state = licitacion.categories[cat];
  const votesHere = licitacion.votes.filter((v) => v.category === cat && v.round === state.round);
  const counts = {};
  licitacion.proposals.filter((p) => p.category === cat).forEach((p) => (counts[p.id] = 0));
  votesHere.forEach((v) => {
    if (counts[v.proposalId] !== undefined) counts[v.proposalId] += 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { sorted, totalVotes: votesHere.length };
}

// Cierra la votación de todas las categorías que estén en "voting" en
// este momento (sirve tanto para la primera ronda, como para las rondas
// de desempate que se hayan ido reabriendo). Si una categoría empata, se
// reabre sola para una ronda extra (con las propuestas que ya había,
// editable/ampliable solo en esa ronda extra), con la ventana de tiempo
// configurada — hasta un máximo de 3 rondas en total; si sigue empatada
// después de la tercera, se deja como empate definitivo (sin ganador).
// La reapertura de categorías VACÍAS no pasa aquí automáticamente — el
// administrador la dispara aparte, una vez que ya no quede nada más
// pendiente.
function closeLicitacionVoting(licitacion, config) {
  const winners = []; // { category, proposal }
  Object.entries(licitacion.categories).forEach(([cat, state]) => {
    if (state.status !== "voting") return;
    const { sorted } = tallyCategory(licitacion, cat);
    const topCount = sorted.length ? sorted[0][1] : 0;
    const tiedTop = sorted.filter(([, c]) => c === topCount);
    if (topCount > 0 && tiedTop.length === 1) {
      state.status = "resolved";
      state.winner = tiedTop[0][0];
      winners.push({ category: cat, proposal: licitacion.proposals.find((p) => p.id === tiedTop[0][0]) });
    } else if (state.round < 3) {
      // Empate: se reabre esta categoría sola, con una ventana de tiempo
      // para editar propuestas existentes o agregar nuevas.
      state.status = "collecting";
      state.round += 1;
      state.closesAt = config.tieRoundMinutes ? minutesFromNow(config.tieRoundMinutes) : null;
    } else {
      // Ya se usaron las 3 rondas y sigue empatada: se deja así.
      state.status = "tie_final";
    }
  });
  return winners;
}

// El administrador dispara esto a propósito (no es automático) cuando
// ya no queda ninguna categoría recolectando o votando entre las que sí
// tuvieron propuestas: le da una oportunidad más a cada categoría que se
// quedó vacía, hasta un máximo de 3 intentos en total.
function reopenEmptyCategories(licitacion, config) {
  const states = Object.values(licitacion.categories);
  const stillActive = states.some((s) => s.status === "collecting" || s.status === "voting");
  if (stillActive) return { reopened: [] };

  const stillEmpty = Object.entries(licitacion.categories).filter(([, s]) => s.status === "empty" && s.round < 3);
  stillEmpty.forEach(([cat, s]) => {
    s.status = "collecting";
    s.round += 1;
    s.closesAt = config.reopenEmptyMinutes ? minutesFromNow(config.reopenEmptyMinutes) : null;
  });
  return { reopened: stillEmpty.map(([cat]) => cat) };
}

// Revisa si alguna categoría con ventana de tiempo ya se venció, y si es
// así la cierra sola (igual que si el admin la hubiera cerrado a mano).
function checkLicitacionTimers(licitacion, config) {
  let changed = false;
  Object.keys(licitacion.categories).forEach((cat) => {
    const state = licitacion.categories[cat];
    if (state.status === "collecting" && state.closesAt && new Date(state.closesAt) <= new Date()) {
      closeCategoryCollecting(licitacion, cat);
      changed = true;
    }
  });
  return changed;
}

function licitacionAllDone(licitacion) {
  return Object.values(licitacion.categories).every((s) => ["resolved", "empty_closed", "tie_final"].includes(s.status));
}

// Si este flujo de presupuesto viene encadenado de un flujo de cuotas ya
// terminado (Asociaciones), y ese flujo de cuotas calculó cuánto se
// recauda (porque el admin puso número de miembros), el presupuesto
// total se calcula solo: lo recaudado en cuotas + el monto extra que el
// admin haya puesto (ahorros, otros ingresos). Si no hay flujo de cuotas
// encadenado con ese cálculo, se usa el "totalBudget" que el admin haya
// escrito a mano (comportamiento normal de Presupuesto suelto).
function getEffectiveFlowConfig(group, flow) {
  const config = { ...flow.config };
  if (flow.template === "presupuesto" && flow.chainedFromFlowId) {
    const cuotasFlow = (group.flows || []).find((f) => f.id === flow.chainedFromFlowId);
    if (cuotasFlow) {
      const finalStage = [...cuotasFlow.stages].reverse().find((s) => s.key === "quotas" || s.key === "singleQuota");
      if (finalStage && finalStage.result.totalCollected) {
        config.cuotasTotal = finalStage.result.totalCollected;
        config.totalBudget = Math.round((finalStage.result.totalCollected + (config.extraAmount || 0)) * 100) / 100;
      }
    }
  }
  return config;
}

function summarizeStage(s) {
  if (s.type === "promedio") {
    let line = `${s.text}\n→ ${s.result.average.toFixed(2)}`;
    if (s.result.totalCollected !== undefined) {
      line += ` (${s.result.memberCount} miembros × ${s.result.average.toFixed(2)} = $${s.result.totalCollected} recaudados)`;
    }
    return line;
  }
  if (s.type === "mayoria") {
    return `${s.text}\n→ ${s.result.winner || "sin ganador"}`;
  }
  if (s.type === "recoleccion_abierta") {
    return `${s.text}\n→ propuestas: ${s.result.pool.map((p) => `${p.text} (${p.count})`).join(", ")}`;
  }
  if (s.type === "ranking_multiganador") {
    return `${s.text}\n→ elegidas: ${s.result.winners.join(", ")}`;
  }
  if (s.type === "promedio_por_categoria") {
    const lines = Object.entries(s.result.categories).map(([cat, r]) => `  - ${cat}: ${r.average.toFixed(2)}${r.collected !== undefined ? ` (${r.memberCount} miembros = $${r.collected})` : ""}`);
    let text = `${s.text}\n${lines.join("\n")}`;
    if (s.result.totalCollected) text += `\n  TOTAL RECAUDADO: $${s.result.totalCollected}`;
    return text;
  }
  if (s.type === "seleccion_multiple") {
    const lines = s.result.tally.map((t) => `  - ${t.option}: ${t.percent}%`);
    return `${s.text}\n${lines.join("\n")}`;
  }
  if (s.type === "porcentaje_por_categoria") {
    const lines = Object.entries(s.result.categories).map(([cat, r]) => `  - ${cat}: ${r.normalizedPercent}%${r.amount !== undefined ? ` ($${r.amount})` : ""}`);
    return `${s.text}\n${lines.join("\n")}`;
  }
  return s.text;
}

const TEMPLATE_LABELS = { cuotas: "Cuotas participativas", presupuesto: "Presupuesto participativo" };

// El administrador inicia un flujo nuevo (ej. "cuotas").
app.post("/api/groups/:code/flows", async (req, res) => {
  const { template, memberId, chainNext } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  if (group.admin.id !== memberId) return res.status(403).json({ error: "Solo el administrador puede iniciar un flujo" });
  if (!TEMPLATES[template]) return res.status(400).json({ error: "Plantilla desconocida" });

  if (!group.flows) group.flows = [];
  const alreadyActive = group.flows.find((f) => f.template === template && f.status === "active");
  if (alreadyActive) return res.status(400).json({ error: "Ya hay un flujo de este tipo en curso" });

  const flow = {
    id: generateId(),
    template,
    status: "active",
    config: { ...(TEMPLATES[template].defaultConfig || {}) },
    currentStage: { ...TEMPLATES[template].getInitialStage(TEMPLATES[template].defaultConfig || {}), instanceIndex: 0 },
    stages: [],
    chainNext: chainNext || null,
    createdAt: new Date().toISOString(),
  };
  group.flows.push(flow);
  await save(db);
  res.json(flow);
});

app.get("/api/groups/:code/flows/:flowId", async (req, res) => {
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow) return res.status(404).json({ error: "Flujo no encontrado" });

  let liveCount = 0;
  if (flow.status === "active") {
    liveCount = group.responses.filter((r) => r.flowId === flow.id && r.stageInstanceIndex === flow.currentStage.instanceIndex).length;
  }
  res.json({ ...flow, liveCount });
});

// El administrador ajusta la configuración del flujo (ej. % mínimo de
// apoyo para que sobreviva una categoría, % de recorte en las cuotas).
// Solo afecta a las etapas que TODAVÍA no se han calculado.
app.post("/api/groups/:code/flows/:flowId/config", async (req, res) => {
  const { memberId, config } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  if (group.admin.id !== memberId) return res.status(403).json({ error: "Solo el administrador puede cambiar la configuración" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow) return res.status(404).json({ error: "Flujo no encontrado" });
  if (flow.status !== "active") return res.status(400).json({ error: "Este flujo ya terminó" });

  flow.config = { ...flow.config, ...config };
  await save(db);
  res.json(flow);
});

// El administrador confirma que ya terminó de configurar la etapa
// actual (ej. número de miembros por categoría) y la abre para que
// todos puedan responder.
app.post("/api/groups/:code/flows/:flowId/responses", async (req, res) => {
  const { memberId, value } = req.body;
  if (!memberId || value === undefined) return res.status(400).json({ error: "Faltan campos: memberId, value" });

  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const member = group.members.find((m) => m.id === memberId && m.approved);
  if (!member) return res.status(403).json({ error: "Miembro no encontrado o no aprobado" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow) return res.status(404).json({ error: "Flujo no encontrado" });
  if (flow.status !== "active") return res.status(403).json({ error: "Este flujo ya terminó" });

  const stage = flow.currentStage;
  if (stage.type === "conteo_miembros" && group.admin.id !== memberId) {
    return res.status(403).json({ error: "Solo el administrador responde esta etapa" });
  }
  let storedValue;

  if (stage.type === "promedio") {
    const num = Number(value);
    if (isNaN(num)) return res.status(400).json({ error: "value debe ser un número" });
    storedValue = num;
  } else if (stage.type === "mayoria") {
    if (!stage.config.options.includes(value)) return res.status(400).json({ error: "value debe ser una opción válida" });
    storedValue = value;
  } else if (stage.type === "recoleccion_abierta") {
    const arr = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean).slice(0, stage.config.maxItemsPerPerson);
    if (arr.length === 0) return res.status(400).json({ error: "Escribe al menos una propuesta" });
    storedValue = arr;
  } else if (stage.type === "ranking_multiganador") {
    const arr = Array.isArray(value) ? value : [value];
    const valid = arr.every((v) => stage.config.options.includes(v)) && new Set(arr).size === arr.length;
    if (!valid || arr.length === 0) return res.status(400).json({ error: "value debe ser un orden de opciones válidas, sin repetir" });
    storedValue = arr;
  } else if (stage.type === "promedio_por_categoria") {
    if (typeof value !== "object" || Array.isArray(value) || value === null) {
      return res.status(400).json({ error: "value debe ser un objeto {categoria: número}" });
    }
    const cleaned = {};
    stage.config.categories.forEach((cat) => {
      const n = Number(value[cat]);
      if (!isNaN(n)) cleaned[cat] = n;
    });
    if (Object.keys(cleaned).length === 0) return res.status(400).json({ error: "Propón al menos una cuota" });
    storedValue = cleaned;
  } else if (stage.type === "seleccion_multiple") {
    const arr = Array.isArray(value) ? value : [value];
    const clean = [...new Set(arr.map((v) => String(v).trim()).filter(Boolean))];
    if (clean.length === 0) return res.status(400).json({ error: "Elige o agrega al menos una categoría" });
    storedValue = clean;
  } else if (stage.type === "porcentaje_por_categoria") {
    if (typeof value !== "object" || Array.isArray(value) || value === null) {
      return res.status(400).json({ error: "value debe ser un objeto {categoria: número}" });
    }
    const cleaned = {};
    stage.config.categories.forEach((cat) => {
      const n = Number(value[cat]);
      if (!isNaN(n)) cleaned[cat] = n;
    });
    if (Object.keys(cleaned).length === 0) return res.status(400).json({ error: "Asigna al menos un %" });
    storedValue = cleaned;
  } else if (stage.type === "conteo_miembros") {
    // value puede venir vacío ({}) si el administrador decidió omitir
    // este paso — es válido, simplemente no se calculará recaudación.
    if (typeof value !== "object" || Array.isArray(value) || value === null) {
      return res.status(400).json({ error: "value debe ser un objeto {categoria: número}" });
    }
    const cleaned = {};
    Object.entries(value).forEach(([k, v]) => {
      const n = Number(v);
      if (!isNaN(n) && n > 0) cleaned[k] = n;
    });
    storedValue = cleaned;
  } else {
    return res.status(400).json({ error: "Tipo de etapa desconocido" });
  }

  group.responses.push({
    id: generateId(),
    flowId: flow.id,
    stageKey: stage.key,
    stageInstanceIndex: stage.instanceIndex,
    memberId: member.id,
    memberName: member.name,
    value: storedValue,
    timestamp: new Date().toISOString(),
  });
  await save(db);
  res.json({ status: "guardado" });
});

// El administrador cierra la etapa actual del flujo: calcula el
// resultado, y avanza a la siguiente etapa (o termina el flujo).
app.post("/api/groups/:code/flows/:flowId/close-stage", async (req, res) => {
  const { memberId } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  if (group.admin.id !== memberId) return res.status(403).json({ error: "Solo el administrador puede cerrar la etapa" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow) return res.status(404).json({ error: "Flujo no encontrado" });
  if (flow.status !== "active") return res.status(400).json({ error: "Este flujo ya terminó" });

  const stage = flow.currentStage;
  const responses = group.responses.filter((r) => r.flowId === flow.id && r.stageInstanceIndex === stage.instanceIndex);
  const effectiveConfig = getEffectiveFlowConfig(group, flow);
  const result = computeStageResult(stage, responses, effectiveConfig);
  flow.stages.push({ ...stage, result, closedAt: new Date().toISOString() });

  // Si esta etapa era la de "número de miembros", lo que haya puesto el
  // administrador (o nada, si lo omitió) queda guardado en la
  // configuración del flujo, para que las siguientes etapas lo usen.
  if (stage.type === "conteo_miembros") {
    flow.config.memberCounts = { ...flow.config.memberCounts, ...result.memberCounts };
  }

  const nextStage = TEMPLATES[flow.template].getNextStage(flow.stages, getEffectiveFlowConfig(group, flow));
  if (nextStage) {
    flow.currentStage = { ...nextStage, instanceIndex: flow.stages.length };
  } else if (stage.key === "openBids" && result.winner === "Sí") {
    flow.currentStage = null;
    flow.licitacion = initLicitacion(flow);
  } else {
    flow.status = "finished";
    flow.currentStage = null;

    if (flow.chainNext && TEMPLATES[flow.chainNext]) {
      const nextTemplate = flow.chainNext;
      group.flows.push({
        id: generateId(),
        template: nextTemplate,
        status: "active",
        config: { ...(TEMPLATES[nextTemplate].defaultConfig || {}) },
        currentStage: { ...TEMPLATES[nextTemplate].getInitialStage(TEMPLATES[nextTemplate].defaultConfig || {}), instanceIndex: 0 },
        stages: [],
        chainNext: null,
        chainedFromFlowId: flow.template === "cuotas" ? flow.id : null,
        createdAt: new Date().toISOString(),
      });
    }
  }

  await save(db);

  if (flow.status === "finished") {
    const summary = flow.stages.map(summarizeStage).join("\n\n");
    notifyResultsToMembers({
      group,
      questionText: TEMPLATE_LABELS[flow.template] || flow.template,
      summaryText: summary,
      frontendUrl: process.env.FRONTEND_URL,
      subjectPrefix: "Resultado final",
    }).catch((err) => console.error("Error de correo (flujo):", err.message));
  }

  res.json(flow);
});

// Un miembro manda una propuesta para una categoría (puede mandar
// varias, no solo una).
app.post("/api/groups/:code/flows/:flowId/proposals", async (req, res) => {
  const { memberId, category, name, costType, costAmount, description, links } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const member = group.members.find((m) => m.id === memberId && m.approved);
  if (!member) return res.status(403).json({ error: "Miembro no encontrado o no aprobado" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow || !flow.licitacion) return res.status(404).json({ error: "No hay proceso de propuestas activo" });

  const catState = flow.licitacion.categories[category];
  if (!catState) return res.status(400).json({ error: "Categoría inválida" });
  if (checkLicitacionTimers(flow.licitacion, flow.config || {})) await save(db);
  if (catState.status !== "collecting") return res.status(403).json({ error: "La recepción de propuestas para esta categoría ya cerró" });

  if (!name || !String(name).trim()) return res.status(400).json({ error: "Falta el nombre de la propuesta" });
  const cost = Number(costAmount);
  if (isNaN(cost) || cost <= 0) return res.status(400).json({ error: "El costo debe ser un número mayor a 0" });
  if (!["mensual", "total"].includes(costType)) return res.status(400).json({ error: "costType debe ser 'mensual' o 'total'" });

  const monthlyBudget = catState.monthlyBudget;
  let monthsNeeded = null;
  if (costType === "mensual" && monthlyBudget && cost > monthlyBudget) {
    return res.status(400).json({ error: `El costo mensual no puede pasar de lo asignado a esta categoría (${monthlyBudget}/mes)` });
  }
  if (costType === "total" && monthlyBudget) {
    monthsNeeded = cost > monthlyBudget ? Math.ceil(cost / monthlyBudget) : 1;
  }

  const proposal = {
    id: generateId(),
    category,
    memberId: member.id,
    memberName: member.name,
    memberEmail: member.email || null,
    name: String(name).trim(),
    costType,
    costAmount: cost,
    monthlyBudget,
    monthsNeeded,
    description: description ? String(description).trim() : "",
    links: Array.isArray(links) ? links.map((l) => String(l).trim()).filter(Boolean) : [],
    timestamp: new Date().toISOString(),
  };
  flow.licitacion.proposals.push(proposal);
  await save(db);
  res.json(proposal);
});

// El autor de una propuesta ya enviada la puede editar, mientras la
// categoría siga en recolección (por ejemplo, durante una ronda de
// desempate, para mejorar su propuesta antes de que se vuelva a votar).
app.post("/api/groups/:code/flows/:flowId/proposals/:proposalId/edit", async (req, res) => {
  const { memberId, name, costType, costAmount, description, links } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow || !flow.licitacion) return res.status(404).json({ error: "No hay proceso de propuestas activo" });

  const proposal = flow.licitacion.proposals.find((p) => p.id === req.params.proposalId);
  if (!proposal) return res.status(404).json({ error: "Propuesta no encontrada" });
  if (proposal.memberId !== memberId) return res.status(403).json({ error: "Solo quien mandó la propuesta la puede editar" });

  const catState = flow.licitacion.categories[proposal.category];
  if (checkLicitacionTimers(flow.licitacion, flow.config || {})) await save(db);
  if (!catState || catState.status !== "collecting") {
    return res.status(403).json({ error: "Esta categoría ya no está recibiendo/editando propuestas" });
  }

  if (name && String(name).trim()) proposal.name = String(name).trim();
  if (description !== undefined) proposal.description = String(description).trim();
  if (Array.isArray(links)) proposal.links = links.map((l) => String(l).trim()).filter(Boolean);
  if (costType && costAmount !== undefined) {
    const cost = Number(costAmount);
    if (!isNaN(cost) && cost > 0 && ["mensual", "total"].includes(costType)) {
      const monthlyBudget = catState.monthlyBudget;
      if (costType === "mensual" && monthlyBudget && cost > monthlyBudget) {
        return res.status(400).json({ error: `El costo mensual no puede pasar de lo asignado a esta categoría (${monthlyBudget}/mes)` });
      }
      proposal.costType = costType;
      proposal.costAmount = cost;
      proposal.monthsNeeded = costType === "total" && monthlyBudget && cost > monthlyBudget ? Math.ceil(cost / monthlyBudget) : costType === "total" ? 1 : null;
    }
  }
  proposal.editedAt = new Date().toISOString();

  await save(db);
  res.json(proposal);
});

// El administrador cierra la recolección de propuestas y se abre la
// votación.
app.post("/api/groups/:code/flows/:flowId/close-collecting", async (req, res) => {
  const { memberId, category } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  if (group.admin.id !== memberId) return res.status(403).json({ error: "Solo el administrador puede cerrar esta etapa" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow || !flow.licitacion) return res.status(404).json({ error: "No hay proceso de propuestas activo" });

  if (category) {
    const catState = flow.licitacion.categories[category];
    if (!catState) return res.status(400).json({ error: "Categoría inválida" });
    if (catState.status !== "collecting") return res.status(400).json({ error: "Esta categoría no está recibiendo propuestas" });
    closeCategoryCollecting(flow.licitacion, category);
  } else {
    closeLicitacionCollecting(flow.licitacion);
  }
  await save(db);
  res.json(flow);
});

// El administrador reabre a propósito las categorías que se quedaron
// vacías, una vez que ya no queda nada más pendiente entre las que sí
// tuvieron propuestas (hasta un máximo de 3 intentos por categoría).
app.post("/api/groups/:code/flows/:flowId/reopen-empty", async (req, res) => {
  const { memberId } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  if (group.admin.id !== memberId) return res.status(403).json({ error: "Solo el administrador puede reabrir categorías" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow || !flow.licitacion) return res.status(404).json({ error: "No hay proceso de propuestas activo" });

  const { reopened } = reopenEmptyCategories(flow.licitacion, flow.config || {});
  if (reopened.length === 0) {
    return res.status(400).json({ error: "No hay categorías vacías para reabrir en este momento" });
  }
  await save(db);
  res.json(flow);
});

// Un miembro vota por una propuesta dentro de una categoría (una vez
// por categoría).
app.post("/api/groups/:code/flows/:flowId/bid-vote", async (req, res) => {
  const { memberId, category, proposalId } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const member = group.members.find((m) => m.id === memberId && m.approved);
  if (!member) return res.status(403).json({ error: "Miembro no encontrado o no aprobado" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow || !flow.licitacion) return res.status(404).json({ error: "No hay proceso de propuestas activo" });
  const licitacion = flow.licitacion;

  const catState = licitacion.categories[category];
  if (checkLicitacionTimers(licitacion, flow.config || {})) await save(db);
  if (!catState || catState.status !== "voting") return res.status(400).json({ error: "Esta categoría no está en votación" });
  if (!licitacion.proposals.find((p) => p.id === proposalId && p.category === category)) {
    return res.status(400).json({ error: "Propuesta inválida para esta categoría" });
  }

  const already = licitacion.votes.find((v) => v.category === category && v.memberId === memberId && v.round === catState.round);
  if (already) return res.status(403).json({ error: "Ya votaste en esta categoría" });

  licitacion.votes.push({ category, proposalId, memberId, round: catState.round, timestamp: new Date().toISOString() });
  await save(db);
  res.json({ status: "guardado" });
});

// El administrador cierra la votación: se calculan los ganadores por
// categoría, y se avisa a todos (y en especial a quien haya ganado).
app.post("/api/groups/:code/flows/:flowId/close-voting", async (req, res) => {
  const { memberId } = req.body;
  const db = await load(req.params.code);
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  if (group.admin.id !== memberId) return res.status(403).json({ error: "Solo el administrador puede cerrar esta etapa" });

  const flow = (group.flows || []).find((f) => f.id === req.params.flowId);
  if (!flow || !flow.licitacion) return res.status(404).json({ error: "No hay proceso de propuestas activo" });
  const hasVoting = Object.values(flow.licitacion.categories).some((s) => s.status === "voting");
  if (!hasVoting) return res.status(400).json({ error: "No hay ninguna categoría en votación en este momento" });

  const winners = closeLicitacionVoting(flow.licitacion, flow.config || {});
  await save(db);

  const summaryLines = Object.entries(flow.licitacion.categories).map(([cat, s]) => {
    if (s.status === "resolved") {
      const p = flow.licitacion.proposals.find((pp) => pp.id === s.winner);
      return `${cat}: ganó "${p ? p.name : "?"}"`;
    }
    if (s.status === "collecting" && s.round > 1) return `${cat}: empate — se abrió una ronda extra para desempatar`;
    if (s.status === "empty" || s.status === "empty_closed") return `${cat}: sin propuestas`;
    return `${cat}: en curso`;
  });
  notifyResultsToMembers({
    group,
    questionText: "Resultado de propuestas del presupuesto",
    summaryText: summaryLines.join("\n"),
    frontendUrl: process.env.FRONTEND_URL,
    subjectPrefix: "Resultado de propuestas",
  }).catch((err) => console.error("Error de correo (propuestas):", err.message));

  winners.forEach(({ category, proposal }) => {
    if (!proposal || !proposal.memberEmail) return;
    notifyProposalWinner({
      memberEmail: proposal.memberEmail,
      memberName: proposal.memberName,
      groupName: group.name,
      category,
      proposalName: proposal.name,
      code: group.code,
      frontendUrl: process.env.FRONTEND_URL,
    }).catch((err) => console.error("Error de correo (ganador):", err.message));
  });

  res.json(flow);
});



// ---------- Exportar ----------

app.get("/api/groups/:code/export/respuestas.csv", async (req, res) => {
  const db = await load(req.params.code);
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
  const db = await load(req.params.code);
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
