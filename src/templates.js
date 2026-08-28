// Registro de plantillas de flujo (Asociaciones, Municipios, etc). Cada
// plantilla define cómo es su primera etapa, y cómo decidir cuál sigue
// según lo que ya se cerró.

const CUOTAS_APPROVAL_STAGE = {
  key: "approval",
  type: "mayoria",
  text: "¿Apruebas el resultado colectivo de las cuotas?",
  config: { options: ["Sí", "No"], majorityRule: "simple" },
};

const cuotas = {
  getInitialStage() {
    return {
      key: "count",
      type: "promedio",
      text: "¿Cuántos tipos de cuota debe haber? (todos pagan igual, o distintos grupos de personas pagan diferente)",
      config: { trimPercent: 10 },
    };
  },

  // Decide la siguiente etapa dado el historial de etapas ya cerradas
  // (stages: [{key, type, text, config, result}]). Devuelve null cuando
  // el flujo ya terminó.
  getNextStage(stages) {
    const last = stages[stages.length - 1];

    if (last.key === "count") {
      const countValue = Math.max(1, Math.round(last.result.average));
      if (countValue === 1) {
        return {
          key: "singleQuota",
          type: "promedio",
          text: "¿Cuánto debe ser la cuota?",
          config: { trimPercent: 10 },
        };
      }
      return {
        key: "names",
        type: "recoleccion_abierta",
        text: `Propón nombres para las ${countValue} categorías de cuota que se necesitan (una por recuadro).`,
        config: { maxItemsPerPerson: countValue, categoryCount: countValue },
      };
    }

    if (last.key === "singleQuota") {
      return CUOTAS_APPROVAL_STAGE;
    }

    if (last.key === "names") {
      const pooledNames = last.result.pool.map((p) => p.text);
      const categoryCount = last.config.categoryCount;
      return {
        key: "ranking",
        type: "ranking_multiganador",
        text: "Ordena estas categorías propuestas según tu preferencia (toca en orden: 1ª, 2ª…).",
        config: { options: pooledNames, winnersCount: categoryCount },
      };
    }

    if (last.key === "ranking") {
      const categories = last.result.winners;
      return {
        key: "quotas",
        type: "promedio_por_categoria",
        text: "Propón la cuota que crees justa para cada categoría.",
        config: { categories, trimPercent: 10 },
      };
    }

    if (last.key === "quotas") {
      return CUOTAS_APPROVAL_STAGE;
    }

    if (last.key === "approval") {
      if (last.result.winner === "Sí") {
        return null; // aprobado — el flujo termina
      }
      // No se aprobó (o hubo empate): se repite desde el inicio. Las
      // etapas del intento anterior se quedan en el historial, así que
      // sirven de referencia para la siguiente vuelta.
      return cuotas.getInitialStage();
    }

    return null;
  },
};

const TEMPLATES = { cuotas };

module.exports = { TEMPLATES };
