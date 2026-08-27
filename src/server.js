require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { load, save, generateCode, generateId } = require("./store");
const { computeTrimmedMean, suggestedMinPercent } = require("./trimmedMean");
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

  const db = load();
  const code = generateCode();
  const adminId = generateId();

  db.groups[code] = {
    code,
    name,
    admin: { id: adminId, name: adminName, email: adminEmail || null },
    requireApproval: requireApproval !== false, // por defecto true
    secretResponses: secretResponses !== false, // por defecto true (propuestas secretas)
    members: [{ id: adminId, name: adminName, approved: true }],
    questions: [],
    responses: [], // { id, questionId, memberId, memberName, value, timestamp }
    results: [], // { questionId, timestamp, trimPercent, n, trimmedCount, average }
  };
  save(db);

  res.json({ code, adminId, group: db.groups[code] });

  // El correo se manda DESPUÉS de responder, en segundo plano: si el
  // envío falla o se traba, no debe impedir que el grupo se cree.
  notifyGroupCreated({
    adminEmail,
    groupName: name,
    code,
    frontendUrl: process.env.FRONTEND_URL,
  }).catch((err) => console.error("Error de correo (bienvenida):", err.message));
});

app.get("/api/groups/:code", (req, res) => {
  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });
  res.json(group);
});

app.post("/api/groups/:code/join", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Falta el campo: name" });

  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const memberId = generateId();
  const autoApprove = group.requireApproval === false;
  group.members.push({ id: memberId, name, approved: autoApprove });
  save(db);

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

app.post("/api/groups/:code/members/:memberId/approve", (req, res) => {
  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const member = group.members.find((m) => m.id === req.params.memberId);
  if (!member) return res.status(404).json({ error: "Miembro no encontrado" });

  member.approved = true;
  save(db);
  res.json(member);
});

// El administrador rechaza (elimina) una solicitud pendiente.
app.post("/api/groups/:code/members/:memberId/reject", (req, res) => {
  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const before = group.members.length;
  group.members = group.members.filter((m) => m.id !== req.params.memberId);
  if (group.members.length === before) {
    return res.status(404).json({ error: "Miembro no encontrado" });
  }

  save(db);
  res.json({ status: "rechazado" });
});

// ---------- Preguntas ----------

app.post("/api/groups/:code/questions", (req, res) => {
  const { text, trimPercent } = req.body;
  if (!text || trimPercent === undefined) {
    return res.status(400).json({ error: "Faltan campos: text, trimPercent" });
  }

  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const question = { id: generateId(), text, trimPercent: Number(trimPercent) };
  group.questions.push(question);
  save(db);

  res.json(question);
});

// Un miembro aprobado envía su propuesta numérica para una pregunta.
app.post("/api/groups/:code/questions/:questionId/responses", (req, res) => {
  const { memberId, value } = req.body;
  if (!memberId || value === undefined) {
    return res.status(400).json({ error: "Faltan campos: memberId, value" });
  }

  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const member = group.members.find((m) => m.id === memberId && m.approved);
  if (!member) return res.status(403).json({ error: "Miembro no encontrado o no aprobado" });

  const question = group.questions.find((q) => q.id === req.params.questionId);
  if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });

  group.responses.push({
    id: generateId(),
    questionId: question.id,
    memberId: member.id,
    memberName: member.name,
    value: Number(value),
    timestamp: new Date().toISOString(),
  });
  save(db);

  res.json({ status: "guardado" });
});

// Calcula el promedio recortado con las respuestas guardadas y lo registra
// en el historial de resultados del grupo.
app.get("/api/groups/:code/questions/:questionId/results", (req, res) => {
  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).json({ error: "Grupo no encontrado" });

  const question = group.questions.find((q) => q.id === req.params.questionId);
  if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });

  const relevantResponses = group.responses.filter((r) => r.questionId === question.id);
  const values = relevantResponses.map((r) => r.value);

  const result = computeTrimmedMean(values, question.trimPercent);

  // Solo se arma la lista con nombres si el grupo NO es secreto. Si es
  // secreto, el backend ni siquiera envía los nombres al navegador.
  let sortedWithNames = null;
  if (group.secretResponses === false) {
    sortedWithNames = [...relevantResponses]
      .sort((a, b) => a.value - b.value)
      .map((r) => ({ value: r.value, name: r.memberName }));
  }

  group.results.push({
    questionId: question.id,
    timestamp: new Date().toISOString(),
    trimPercent: question.trimPercent,
    n: result.n,
    trimmedCount: result.trimmedCount,
    average: result.average,
  });
  save(db);

  res.json({
    question,
    suggestedMinPercent: suggestedMinPercent(result.n),
    secretResponses: group.secretResponses !== false,
    sortedWithNames,
    ...result,
  });
});

// ---------- Exportar ----------

// Descarga todas las respuestas del grupo en un .csv (se abre en Excel,
// Numbers, Google Sheets, lo que sea). Abrir esta URL en el navegador ya
// descarga el archivo directamente.
app.get("/api/groups/:code/export/respuestas.csv", (req, res) => {
  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).send("Grupo no encontrado");

  const rows = [["fecha", "pregunta", "integrante", "valor"]];
  for (const r of group.responses) {
    const question = group.questions.find((q) => q.id === r.questionId);
    rows.push([r.timestamp, question ? question.text : r.questionId, r.memberName, r.value]);
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${group.name}-respuestas.csv"`);
  res.send(toCsv(rows));
});

// Descarga el historial de decisiones colectivas calculadas.
app.get("/api/groups/:code/export/resultados.csv", (req, res) => {
  const db = load();
  const group = db.groups[req.params.code];
  if (!group) return res.status(404).send("Grupo no encontrado");

  const rows = [
    ["fecha", "pregunta", "recortePorciento", "totalPropuestas", "recortadas", "decisionColectiva"],
  ];
  for (const r of group.results) {
    const question = group.questions.find((q) => q.id === r.questionId);
    rows.push([
      r.timestamp,
      question ? question.text : r.questionId,
      r.trimPercent,
      r.n,
      r.trimmedCount,
      r.average,
    ]);
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${group.name}-resultados.csv"`);
  res.send(toCsv(rows));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor de Democracia por Promedio escuchando en http://localhost:${PORT}`);
});
