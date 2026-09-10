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

    // Presupuesto participativo
    "presupuesto.gastosFijos.chained": "Desglosa los gastos fijos del presupuesto (si no hay gastos fijos, deja la lista vacía y continúa).",
    "presupuesto.gastosFijos.standalone": "Desglosa los gastos fijos del presupuesto (si no hay, deja la lista vacía). Ingresar el presupuesto disponible es opcional — si lo pones, se usa para calcular a cuánto equivale cada % más adelante.",
    "presupuesto.categories": "Propón categorías de gasto para el presupuesto (una por recuadro).",
    "presupuesto.fusionarCategorias": "¿Hay rubros propuestos que en realidad son el mismo? Márquenlos juntos si creen que sí.",
    "presupuesto.selection": "Elige las categorías que te importan (puedes elegir varias). Se descartan las que no lleguen al {threshold}% de apoyo.",
    "presupuesto.budget": "Asigna el % de {label} que crees justo para cada rubro (si la suma pasa de 100%, se ajusta sola). Los gastos fijos ya vienen con su % de referencia, pero los puedes mover.",
    "presupuesto.openBids": "¿Quieren abrir el proceso de propuestas para hacer uso del presupuesto de cada categoría?",

    // Selección de responsables
    "responsabilidades.openRoles": "¿Quieren asignar puestos y responsabilidades por sorteo?",
    "responsabilidades.openRoles.explanation": "En vez de que el facilitador asigne los puestos a mano, la app elige al azar entre los candidatos, de forma segura e imposible de manipular. Nadie repite el mismo puesto dos veces seguidas, ni tiene dos puestos en el mismo periodo.\n\nEsto solo se activa si más del 50% del grupo vota que sí. Si no se llega a esa mayoría, el grupo sigue como está, sin puestos asignados.",
    "responsabilidades.proponerPuestos": "Propongan los puestos o responsabilidades que debería tener este grupo — ya tienen algunos sugeridos, pueden editarlos o agregar más.",
    "responsabilidades.fusionarPuestos": "¿Hay puestos propuestos que en realidad son el mismo? Márquenlos juntos si creen que sí.",
    "responsabilidades.votarPuestos": "Elijan los puestos que crean que este grupo debería tener (pueden elegir varios). Se descartan los que no lleguen al {threshold}% de apoyo.",
    "responsabilidades.frequencyVote": "¿Reparten los puestos una sola vez, o arman un calendario rotativo (12 meses)?",
    "responsabilidades.frequencyVote.explanation": "Calendario rotativo: se sortea de una sola vez un calendario completo (12 meses) que dice quién tiene cada puesto, mes por mes. Cada quien va saliendo del sorteo conforme le toca un puesto, hasta que todos hayan ocupado alguno — ahí se vuelve a incluir a todos y se sigue repartiendo.\n\nUna sola vez: se sortea una sola vez por puesto (sin calendario), y esa persona se queda de forma indefinida.",
    "responsabilidades.configurarCandidatos": "Lista de candidatos para el sorteo — se llena automáticamente con los miembros del grupo.",
    "responsabilidades.approvalVote": "¿Aprueban esta lista de candidatos para el sorteo de puestos? {names}",
    "responsabilidades.realizarSorteo": "Todo listo — el facilitador puede realizar el sorteo cuando quiera.",
    "responsabilidades.ajustarCandidatos": "No se aprobó la lista — selecciona a quién quitarías, y propón nuevos candidatos si quieres.",
    "responsabilidades.fusionarCandidatos": "Revisa la lista final: si dos nombres son en realidad la misma persona (por una errata o apodo), fusiónalos en uno solo.",
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

    // Participatory budget
    "presupuesto.gastosFijos.chained": "Break down the budget's fixed expenses (if there are none, leave the list empty and continue).",
    "presupuesto.gastosFijos.standalone": "Break down the budget's fixed expenses (if there are none, leave the list empty). Entering the available budget is optional — if you do, it's used to calculate what each % is worth further along.",
    "presupuesto.categories": "Propose spending categories for the budget (one per box).",
    "presupuesto.fusionarCategorias": "Are there any proposed categories that are actually the same? Mark them together if you think so.",
    "presupuesto.selection": "Choose the categories that matter to you (you can pick several). Categories that don't reach {threshold}% support are discarded.",
    "presupuesto.budget": "Assign the % of {label} you think is fair for each item (if the total goes over 100%, it adjusts itself). Fixed expenses already come with their reference %, but you can move them.",
    "presupuesto.openBids": "Do you want to open a proposal process for how each category's budget gets used?",

    // Selecting who's responsible
    "responsabilidades.openRoles": "Do you want to assign roles and responsibilities by lottery?",
    "responsabilidades.openRoles.explanation": "Instead of the facilitator assigning roles by hand, the app picks at random among the candidates, securely and impossible to manipulate. No one repeats the same role twice in a row, or holds two roles in the same period.\n\nThis only activates if more than 50% of the group votes yes. If that majority isn't reached, the group stays as is, with no roles assigned.",
    "responsabilidades.proponerPuestos": "Propose the roles or responsibilities this group should have — some suggestions are already there, which you can edit or add to.",
    "responsabilidades.fusionarPuestos": "Are there any proposed roles that are actually the same? Mark them together if you think so.",
    "responsabilidades.votarPuestos": "Choose the roles you think this group should have (you can pick several). Roles that don't reach {threshold}% support are discarded.",
    "responsabilidades.frequencyVote": "Do you want to assign roles just once, or set up a rotating 12-month schedule?",
    "responsabilidades.frequencyVote.explanation": "Rotating schedule: a full 12-month calendar is drawn at once, saying who holds each role, month by month. Each person drops out of the drawing once they've been assigned a role, until everyone has held one — then everyone's back in the pool and it keeps going.\n\nJust once: each role is drawn once (no calendar), and that person stays indefinitely.",
    "responsabilidades.configurarCandidatos": "Candidate list for the drawing — automatically filled in with the group's members.",
    "responsabilidades.approvalVote": "Do you approve this list of candidates for the role drawing? {names}",
    "responsabilidades.realizarSorteo": "All set — the facilitator can run the drawing whenever ready.",
    "responsabilidades.ajustarCandidatos": "The list wasn't approved — select who you'd remove, and propose new candidates if you'd like.",
    "responsabilidades.fusionarCandidatos": "Review the final list: if two names are actually the same person (a typo or nickname), merge them into one.",
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
