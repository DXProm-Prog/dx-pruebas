// Guarda TODO localmente en un archivo JSON: grupos, miembros, preguntas,
// respuestas y resultados. Ya no depende de Google Sheets — el archivo
// data.json es la única fuente de verdad.

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data.json");

function load() {
  if (!fs.existsSync(DB_PATH)) return { groups: {} };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = { load, save, generateCode, generateId };
