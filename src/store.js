// Guarda TODO (grupos, miembros, preguntas, respuestas, flujos) en
// Supabase (Postgres) — un grupo por fila, en vez de todo junto en un
// solo bloque de datos como antes con Upstash. Esto evita que cada
// consulta se vuelva más lenta entre más grupos existan.
//
// Diseño híbrido: las tablas "groups" y "members" son relacionales de
// verdad (para que una persona pueda tener varios grupos). Todo lo
// demás (preguntas, flujos) se guarda tal cual en una columna JSON
// ("data"), con la misma forma que ya usa el resto del código en
// memoria — así casi no se tocó la lógica que ya funciona, solo
// cambió dónde se lee y se guarda.

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Faltan las variables de entorno SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. Agrégalas en Render → Environment."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Reconstruye un grupo completo, con la misma forma que el resto del
// código ya espera en memoria, a partir de sus filas en Supabase.
async function loadGroupByCode(code) {
  if (!code) return null;

  const { data: groupRow, error: groupErr } = await supabase.from("groups").select("*").eq("code", code).maybeSingle();
  if (groupErr) throw new Error(`Supabase (grupo): ${groupErr.message}`);
  if (!groupRow) return null;

  const [memberRes, questionRes, flowRes] = await Promise.all([
    supabase.from("members").select("*").eq("group_id", groupRow.id),
    supabase.from("questions").select("*").eq("group_id", groupRow.id),
    supabase.from("flows").select("*").eq("group_id", groupRow.id),
  ]);
  if (memberRes.error) throw new Error(`Supabase (miembros): ${memberRes.error.message}`);
  if (questionRes.error) throw new Error(`Supabase (preguntas): ${questionRes.error.message}`);
  if (flowRes.error) throw new Error(`Supabase (flujos): ${flowRes.error.message}`);

  const memberRows = memberRes.data || [];
  const questionRows = questionRes.data || [];
  const flowRows = flowRes.data || [];

  const questionIds = questionRows.map((q) => q.id);
  const flowIds = flowRows.map((f) => f.id);

  const [qResponseRes, fResponseRes] = await Promise.all([
    questionIds.length
      ? supabase.from("question_responses").select("*").in("question_id", questionIds)
      : Promise.resolve({ data: [], error: null }),
    flowIds.length
      ? supabase.from("flow_responses").select("*").in("flow_id", flowIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (qResponseRes.error) throw new Error(`Supabase (respuestas de preguntas): ${qResponseRes.error.message}`);
  if (fResponseRes.error) throw new Error(`Supabase (respuestas de flujos): ${fResponseRes.error.message}`);

  const members = memberRows.map((m) => ({
    id: m.id,
    name: m.name,
    approved: m.approved,
    email: m.email || null,
    userId: m.user_id || null,
  }));
  const adminRow = memberRows.find((m) => m.is_admin);

  const questions = questionRows.map((q) => ({ ...q.data, id: q.id }));
  const flows = flowRows.map((f) => ({ ...f.data, id: f.id }));

  const questionResponses = (qResponseRes.data || []).map((r) => ({
    id: r.id,
    questionId: r.question_id,
    memberId: r.member_id,
    ...r.data,
  }));
  const flowResponses = (fResponseRes.data || []).map((r) => ({
    id: r.id,
    flowId: r.flow_id,
    memberId: r.member_id,
    ...r.data,
  }));

  return {
    _dbId: groupRow.id,
    code: groupRow.code,
    name: groupRow.name,
    admin: adminRow ? { id: adminRow.id, name: adminRow.name, email: adminRow.email || null } : null,
    requireApproval: groupRow.require_approval,
    secretResponses: groupRow.secret_responses,
    members,
    questions,
    responses: [...questionResponses, ...flowResponses],
    results: [],
    flows,
  };
}

// Guarda un grupo completo de vuelta en Supabase: crea o actualiza su
// fila, y hace upsert (crear o actualizar) de miembros, preguntas,
// flujos y respuestas. Los miembros que ya no estén en la lista (por
// ejemplo, alguien rechazado) se borran de verdad; preguntas, flujos y
// respuestas nunca se borran, solo se agregan o actualizan.
async function saveGroup(group) {
  let groupId = group._dbId;

  if (!groupId) {
    const { data, error } = await supabase
      .from("groups")
      .insert({
        code: group.code,
        name: group.name,
        require_approval: group.requireApproval,
        secret_responses: group.secretResponses,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Supabase (crear grupo): ${error.message}`);
    groupId = data.id;
    group._dbId = groupId;
  } else {
    const { error } = await supabase
      .from("groups")
      .update({
        name: group.name,
        require_approval: group.requireApproval,
        secret_responses: group.secretResponses,
      })
      .eq("id", groupId);
    if (error) throw new Error(`Supabase (actualizar grupo): ${error.message}`);
  }

  if (group.members.length > 0) {
    const memberRows = group.members.map((m) => ({
      id: m.id,
      group_id: groupId,
      user_id: m.userId || null,
      name: m.name,
      is_admin: Boolean(group.admin && m.id === group.admin.id),
      approved: m.approved,
      email: m.email || null,
    }));
    const { error } = await supabase.from("members").upsert(memberRows);
    if (error) throw new Error(`Supabase (guardar miembros): ${error.message}`);
  }

  // Borrar a quien ya no esté en la lista actual (ej. alguien rechazado).
  const { data: existingMembers, error: existingErr } = await supabase.from("members").select("id").eq("group_id", groupId);
  if (existingErr) throw new Error(`Supabase (revisar miembros): ${existingErr.message}`);
  const currentMemberIds = new Set(group.members.map((m) => m.id));
  const toDelete = (existingMembers || []).map((m) => m.id).filter((id) => !currentMemberIds.has(id));
  if (toDelete.length > 0) {
    const { error } = await supabase.from("members").delete().in("id", toDelete);
    if (error) throw new Error(`Supabase (quitar miembros): ${error.message}`);
  }

  if (group.questions.length > 0) {
    const rows = group.questions.map((q) => {
      const { id, ...rest } = q;
      return { id, group_id: groupId, data: rest };
    });
    const { error } = await supabase.from("questions").upsert(rows);
    if (error) throw new Error(`Supabase (guardar preguntas): ${error.message}`);
  }

  const questionResponses = group.responses.filter((r) => r.questionId);
  if (questionResponses.length > 0) {
    const rows = questionResponses.map((r) => {
      const { id, questionId, memberId, ...rest } = r;
      return { id, question_id: questionId, member_id: memberId, data: rest };
    });
    const { error } = await supabase.from("question_responses").upsert(rows);
    if (error) throw new Error(`Supabase (guardar respuestas): ${error.message}`);
  }

  if (group.flows.length > 0) {
    const rows = group.flows.map((f) => {
      const { id, ...rest } = f;
      return { id, group_id: groupId, data: rest };
    });
    const { error } = await supabase.from("flows").upsert(rows);
    if (error) throw new Error(`Supabase (guardar flujos): ${error.message}`);
  }

  const flowResponses = group.responses.filter((r) => r.flowId);
  if (flowResponses.length > 0) {
    const rows = flowResponses.map((r) => {
      const { id, flowId, memberId, ...rest } = r;
      return { id, flow_id: flowId, member_id: memberId, data: rest };
    });
    const { error } = await supabase.from("flow_responses").upsert(rows);
    if (error) throw new Error(`Supabase (guardar respuestas de flujo): ${error.message}`);
  }
}

// Para la pantalla "Mis grupos": todos los grupos donde esta persona
// (con cuenta) participa o administra.
async function getGroupsForUser(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from("members")
    .select("id, is_admin, approved, groups(code, name)")
    .eq("user_id", userId);
  if (error) throw new Error(`Supabase (mis grupos): ${error.message}`);
  return (data || [])
    .filter((m) => m.groups)
    .map((m) => ({
      code: m.groups.code,
      name: m.groups.name,
      memberId: m.id,
      isAdmin: m.is_admin,
      approved: m.approved,
    }));
}

// ---------- Compatibilidad con el resto del código ----------
//
// Todo el código existente llama a load(code) / save(db), donde "db"
// es { groups: { [code]: group } } — igual que cuando todo vivía junto
// en Upstash, pero ahora cada load() solo trae al grupo que le interesa.

async function load(code) {
  const group = await loadGroupByCode(code);
  return { groups: group ? { [code]: group } : {} };
}

async function save(db) {
  const codes = Object.keys(db.groups);
  for (const code of codes) {
    await saveGroup(db.groups[code]);
  }
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function generateId() {
  return crypto.randomUUID();
}

module.exports = { load, save, generateCode, generateId, getGroupsForUser };
