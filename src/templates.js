// Registro de plantillas de flujo (Asociaciones, Municipios, etc). Cada
// plantilla define cómo es su primera etapa, y cómo decidir cuál sigue
// según lo que ya se cerró. Cada flujo tiene su propia configuración
// (flow.config), que el administrador puede ajustar — aquí solo se usan
// los valores, con 10% como default si no se ha configurado nada.

function approvalStage(label) {
  return {
    key: "approval",
    type: "mayoria",
    text: `¿Apruebas el resultado colectivo de ${label}?`,
    config: { options: ["Sí", "No"], majorityRule: "simple" },
  };
}

const cuotas = {
  defaultConfig: { categoryThresholdPercent: 10, quotaTrimPercent: 10 },

  getInitialStage(flowConfig = {}) {
    const trimPercent = flowConfig.quotaTrimPercent ?? 10;
    return {
      key: "count",
      type: "promedio",
      text: "¿Cuántos tipos de cuota debe haber? (todos pagan igual, o distintos grupos de personas pagan diferente)",
      config: { trimPercent },
    };
  },

  // Decide la siguiente etapa dado el historial de etapas ya cerradas
  // (stages: [{key, type, text, config, result}]) y la configuración
  // actual del flujo. Devuelve null cuando el flujo ya terminó.
  getNextStage(stages, flowConfig = {}) {
    const trimPercent = flowConfig.quotaTrimPercent ?? 10;
    const thresholdPercent = flowConfig.categoryThresholdPercent ?? 10;
    const last = stages[stages.length - 1];

    if (last.key === "count") {
      const countValue = Math.max(1, Math.round(last.result.average));
      if (countValue === 1) {
        return {
          key: "singleQuota",
          type: "promedio",
          text: "¿Cuánto debe ser la cuota?",
          config: { trimPercent },
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
      return approvalStage("las cuotas");
    }

    if (last.key === "names") {
      const { pool, totalResponses } = last.result;
      let survivors = pool.filter((p) => totalResponses > 0 && (p.count / totalResponses) * 100 >= thresholdPercent);
      if (survivors.length === 0) survivors = pool.slice(0, 1);
      const categoryCount = last.config.categoryCount;
      return {
        key: "ranking",
        type: "ranking_multiganador",
        text: `Ordena estas categorías propuestas según tu preferencia (toca en orden: 1ª, 2ª…). Se descartaron las que no llegaron al ${thresholdPercent}% de apoyo.`,
        config: { options: survivors.map((p) => p.text), winnersCount: Math.min(categoryCount, survivors.length) },
      };
    }

    if (last.key === "ranking") {
      const categories = last.result.winners;
      return {
        key: "quotas",
        type: "promedio_por_categoria",
        text: "Propón la cuota que crees justa para cada categoría.",
        config: { categories, trimPercent },
      };
    }

    if (last.key === "quotas") {
      return approvalStage("las cuotas");
    }

    if (last.key === "approval") {
      if (last.result.winner === "Sí") return null;
      return cuotas.getInitialStage(flowConfig);
    }

    return null;
  },
};

const presupuesto = {
  defaultConfig: { selectionThresholdPercent: 10 },

  getInitialStage() {
    return {
      key: "categories",
      type: "recoleccion_abierta",
      text: "Propón categorías de gasto para el presupuesto (una por recuadro).",
      config: { maxItemsPerPerson: 5 },
    };
  },

  getNextStage(stages, flowConfig = {}) {
    const thresholdPercent = flowConfig.selectionThresholdPercent ?? 10;
    const last = stages[stages.length - 1];

    if (last.key === "categories") {
      const allNames = last.result.pool.map((p) => p.text);
      return {
        key: "selection",
        type: "seleccion_multiple",
        text: `Elige las categorías que te importan (puedes elegir varias). Se descartan las que no lleguen al ${thresholdPercent}% de apoyo.`,
        config: { options: allNames },
      };
    }

    if (last.key === "selection") {
      let survivors = last.result.tally.filter((t) => t.percent >= thresholdPercent).map((t) => t.option);
      if (survivors.length === 0) {
        const sorted = [...last.result.tally].sort((a, b) => b.percent - a.percent);
        survivors = sorted.slice(0, 1).map((t) => t.option);
      }
      return {
        key: "budget",
        type: "porcentaje_por_categoria",
        text: "Asigna el % del presupuesto que crees justo para cada categoría (si la suma pasa de 100%, se ajusta sola).",
        config: { categories: survivors },
      };
    }

    if (last.key === "budget") {
      return approvalStage("el presupuesto");
    }

    if (last.key === "approval") {
      if (last.result.winner === "Sí") return null;
      return presupuesto.getInitialStage(flowConfig);
    }

    return null;
  },
};

const TEMPLATES = { cuotas, presupuesto };

module.exports = { TEMPLATES };
