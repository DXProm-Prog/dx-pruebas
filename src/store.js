// Guarda TODO (grupos, miembros, preguntas, respuestas y resultados).
//
// En producción (Render) usa Upstash Redis vía su API HTTPS, porque el
// disco de Render es "efímero": se borra cada vez que el servicio se
// reinicia o se duerme por inactividad, y con eso se perdían los grupos.
//
// Si no hay credenciales de Upstash configuradas (por ejemplo, cuando
// corres el servidor en tu propia computadora), sigue usando un archivo
// local data.json como respaldo, para no complicar las pruebas locales.

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data.json");
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DB_KEY = "democracia-por-promedio-data";

const usingUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function load() {
  if (usingUpstash) {
    const res = await fetch(`${UPSTASH_URL}/get/${DB_KEY}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Upstash respondió ${res.status} al leer los datos`);
    const data = await res.json();
    if (!data.result) return { groups: {} };
    return JSON.parse(data.result);
  }

  if (!fs.existsSync(DB_PATH)) return { groups: {} };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

async function save(data) {
  if (usingUpstash) {
    const res = await fetch(`${UPSTASH_URL}/set/${DB_KEY}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Upstash respondió ${res.status} al guardar los datos`);
    return;
  }

  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = { load, save, generateCode, generateId, usingUpstash };
