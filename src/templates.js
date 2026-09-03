// Registro de plantillas de flujo (Asociaciones, Municipios, etc). Cada
// plantilla define cómo es su primera etapa, y cómo decidir cuál sigue
// según lo que ya se cerró. Cada flujo tiene su propia configuración
// (flow.config), que el administrador puede ajustar — aquí solo se usan
// los valores, con 10% como default si no se ha configurado nada.

// Redondea hacia abajo en los empates de .5 (2.5 → 2, no 3), a
// diferencia de Math.round que siempre sube en los .5. Solo sube si la
// parte decimal pasa de .5 (ej. 2.51 → 3).
function roundHalfDown(n) {
  const floor = Math.floor(n);
  return n - floor > 0.5 ? floor + 1 : floor;
}

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
      const countValue = Math.max(1, roundHalfDown(last.result.average));
      if (countValue === 1) {
        return {
          key: "memberSetup",
          type: "conteo_miembros",
          text: "¿Cuántos miembros van a pagar la cuota? (opcional, solo para ver cuánto se recauda — el administrador puede omitir este paso)",
          config: { mode: "single" },
        };
      }
      return {
        key: "names",
        type: "recoleccion_abierta",
        text: `Propón nombres para las ${countValue} categorías de cuota que se necesitan (una por recuadro).`,
        config: { maxItemsPerPerson: countValue, categoryCount: countValue },
      };
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
      // Si por alguna razón nadie le dio puntos a ninguna opción (ej.
      // una prueba sin votos reales), no se deja la lista de categorías
      // vacía — se usan todas las que se rankearon, para que el flujo
      // pueda seguir.
      const categories = last.result.winners.length > 0 ? last.result.winners : last.config.options;
      return {
        key: "memberSetup",
        type: "conteo_miembros",
        text: "¿Cuántos miembros hay en cada categoría? (opcional, solo para ver cuánto se recauda — el administrador puede omitir este paso)",
        config: { mode: "categories", categories },
      };
    }

    if (last.key === "memberSetup") {
      if (last.config.mode === "single") {
        return {
          key: "singleQuota",
          type: "promedio",
          text: "¿Cuánto debe ser la cuota?",
          config: { trimPercent },
        };
      }
      return {
        key: "quotas",
        type: "promedio_por_categoria",
        text: "Propón la cuota que crees justa para cada categoría.",
        config: { categories: last.config.categories, trimPercent },
      };
    }

    if (last.key === "singleQuota" || last.key === "quotas") {
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
        config: { categories: survivors, totalBudget: flowConfig.totalBudget || null },
      };
    }

    if (last.key === "budget") {
      return approvalStage("el presupuesto");
    }

    if (last.key === "approval") {
      if (last.result.winner === "Sí") {
        return {
          key: "openBids",
          type: "mayoria",
          text: "¿Quieren abrir el proceso de propuestas para hacer uso del presupuesto de cada categoría?",
          config: { options: ["Sí", "No"], majorityRule: "simple" },
        };
      }
      return presupuesto.getInitialStage(flowConfig);
    }

    // "openBids" siempre termina aquí la secuencia normal de etapas — si
    // ganó el Sí, server.js arranca por separado el sistema de
    // propuestas y votación (flow.licitacion), que no es una etapa más.
    if (last.key === "openBids") {
      return null;
    }

    return null;
  },
};

const TEMPLATES = { cuotas, presupuesto };

module.exports = { TEMPLATES };
