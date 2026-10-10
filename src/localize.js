// Traduce "al vuelo" los textos de las etapas de un flujo al idioma de
// QUIEN LOS ESTÁ VIENDO. Cada etapa guarda, además de su texto, la clave
// (textKey) y las variables (textVars) con las que se armó; así una misma
// pregunta se puede mostrar en español a una persona y en inglés a otra,
// sin importar en qué idioma se creó el grupo.
//
// Los flujos viejos (creados antes de este cambio) no tienen textKey y se
// muestran tal cual, en el idioma del grupo.

const { t } = require("./strings");

// Las variables pueden traer otra clave anidada: { $t: "clave", vars: {...} }
function resolveVars(vars, lang) {
  const out = {};
  Object.entries(vars || {}).forEach(([name, value]) => {
    if (value && typeof value === "object" && typeof value.$t === "string") {
      out[name] = t(value.$t, lang, resolveVars(value.vars, lang));
    } else {
      out[name] = value;
    }
  });
  return out;
}

function localizeInPlace(node, lang) {
  if (Array.isArray(node)) {
    node.forEach((item) => localizeInPlace(item, lang));
    return;
  }
  if (!node || typeof node !== "object") return;

  if (typeof node.textKey === "string") {
    node.text = t(node.textKey, lang, resolveVars(node.textVars, lang));
  }
  if (node.config && typeof node.config === "object" && typeof node.config.explanationKey === "string") {
    node.config.explanation = t(node.config.explanationKey, lang, resolveVars(node.config.explanationVars, lang));
  }
  Object.keys(node).forEach((k) => {
    const v = node[k];
    if (v && typeof v === "object") localizeInPlace(v, lang);
  });
}

// Devuelve una COPIA traducida (nunca modifica lo que está guardado).
function localizeCopy(body, lang) {
  const copy = JSON.parse(JSON.stringify(body));
  localizeInPlace(copy, lang);
  return copy;
}

module.exports = { localizeCopy, resolveVars };
