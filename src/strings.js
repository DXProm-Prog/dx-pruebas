// Sistema de idiomas del backend. En vez de tener el texto de cada
// etapa "quemado" en español dentro de templates.js, se guarda aquí
// por clave, en cada idioma que soportemos — y templates.js pide el
// texto correcto con t(clave, idioma, variables).
//
// Cómo agregar una etapa nueva a este sistema:
//   1. Agrega la clave en STRINGS.es Y en STRINGS.en (si falta en un
//      idioma, t() cae de regreso al español, nunca deja un hueco).
//   2. Si el texto tiene partes que cambian (un número, un nombre),
//      pon un marcador como {threshold} o {name}, y pásalo en el
//      tercer argumento de t(): t("clave", lang, { threshold: 10 }).
//
// El idioma de un grupo se decide UNA SOLA VEZ, al crearlo (igual que
// su nombre, o si oculta los nombres de quién propuso qué) — todas las
// etapas de todos sus flujos usan ese mismo idioma después.

const STRINGS = {
  es: {
    // Cuotas participativas
    "cuotas.count": "¿Cuántos tipos de cuota debe haber? (todos pagan igual, o distintos grupos de personas pagan diferente)",
    "cuotas.memberSetup.single": "¿Cuántos miembros van a pagar la cuota? (opcional, solo para ver cuánto se recauda — el administrador puede omitir este paso)",
    "cuotas.names": "Propón nombres para las {count} categorías de cuota que se necesitan (una por recuadro).",
    "cuotas.fusionarCategorias": "¿Hay categorías propuestas que en realidad son la misma? Márquenlas juntas si creen que sí.",
    "cuotas.ranking": "Ordena estas categorías propuestas según tu preferencia (toca en orden: 1ª, 2ª…). Se descartaron las que no llegaron al {threshold}% de apoyo.",
    "cuotas.memberSetup.categories": "¿Cuántos miembros hay en cada categoría? (opcional, solo para ver cuánto se recauda — el administrador puede omitir este paso)",
    "cuotas.singleQuota": "¿Cuánto debe ser la cuota?",
    "cuotas.quotas": "Propón la cuota que crees justa para cada categoría.",
    "approval": "¿Apruebas el resultado colectivo de {label}?",
    "approval.label.cuotas": "las cuotas",
    "approval.label.presupuesto": "el presupuesto",
    "approval.label.presupuestoCooperativa": "el presupuesto de la cooperativa",
  },
  en: {
    // Participatory dues
    "cuotas.count": "How many types of dues should there be? (everyone pays the same, or different groups of people pay differently)",
    "cuotas.memberSetup.single": "How many members will pay the dues? (optional, just to see how much gets collected — the admin can skip this step)",
    "cuotas.names": "Propose names for the {count} dues categories needed (one per box).",
    "cuotas.fusionarCategorias": "Are there any proposed categories that are actually the same? Mark them together if you think so.",
    "cuotas.ranking": "Rank these proposed categories by your preference (tap in order: 1st, 2nd…). Categories that didn't reach {threshold}% support were discarded.",
    "cuotas.memberSetup.categories": "How many members are in each category? (optional, just to see how much gets collected — the admin can skip this step)",
    "cuotas.singleQuota": "How much should the dues be?",
    "cuotas.quotas": "Propose the amount you think is fair for each category.",
    "approval": "Do you approve the collective result of {label}?",
    "approval.label.cuotas": "the dues",
    "approval.label.presupuesto": "the budget",
    "approval.label.presupuestoCooperativa": "the cooperative's budget",
  },
};

function t(key, lang, vars = {}) {
  const dict = STRINGS[lang] || STRINGS.es;
  let str = dict[key] || STRINGS.es[key] || key;
  Object.entries(vars).forEach(([k, v]) => {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  });
  return str;
}

module.exports = { t, STRINGS };
