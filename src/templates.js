// Registro de plantillas de flujo (Asociaciones, Municipios, etc). Cada
// plantilla define cómo es su primera etapa, y cómo decidir cuál sigue
// según lo que ya se cerró. Cada flujo tiene su propia configuración
// (flow.config), que el administrador puede ajustar — aquí solo se usan
// los valores, con 10% como default si no se ha configurado nada.

const { t } = require("./strings");

// Redondea hacia abajo en los empates de .5 (2.5 → 2, no 3), a
// diferencia de Math.round que siempre sube en los .5. Solo sube si la
// parte decimal pasa de .5 (ej. 2.51 → 3).
function roundHalfDown(n) {
  const floor = Math.floor(n);
  return n - floor > 0.5 ? floor + 1 : floor;
}

function approvalStage(labelKey, lang) {
  return {
    key: "approval",
    type: "mayoria",
    text: t("approval", lang, { label: t(`approval.label.${labelKey}`, lang) }),
    config: { options: ["Sí", "No"], majorityRule: "simple" },
  };
}

// Arma la etapa de "asignar % del presupuesto", combinando los gastos
// fijos que ya puso el facilitador (con su % de referencia precargado,
// según cuánto representan de los ingresos) con los rubros que el
// grupo votó — estos últimos empiezan en 0%, para que el grupo decida
// desde cero cómo repartir lo que no está comprometido en gastos fijos.
function buildBudgetStage(stages, survivorCategories, labelKey, lang) {
  const gastosStage = [...stages].reverse().find((s) => s.key === "gastosFijos");
  const ingresos = gastosStage ? gastosStage.result.ingresos : 0;
  const gastosFijos = gastosStage ? gastosStage.result.gastos : [];
  const presetPercentages = {};
  gastosFijos.forEach((g) => {
    presetPercentages[g.nombre] = ingresos > 0 ? Math.round((g.monto / ingresos) * 10000) / 100 : 0;
  });
  const allCategories = [...gastosFijos.map((g) => g.nombre), ...survivorCategories];
  return {
    key: "budget",
    type: "porcentaje_por_categoria",
    text: t("presupuesto.budget", lang, { label: t(`approval.label.${labelKey}`, lang) }),
    config: { categories: allCategories, totalBudget: ingresos, presetPercentages },
  };
}

const cuotas = {
  defaultConfig: { categoryThresholdPercent: 10, quotaTrimPercent: 10 },

  getInitialStage(flowConfig = {}) {
    const trimPercent = flowConfig.quotaTrimPercent ?? 10;
    return {
      key: "count",
      type: "promedio",
      text: t("cuotas.count", flowConfig.lang),
      config: { trimPercent },
    };
  },

  // Decide la siguiente etapa dado el historial de etapas ya cerradas
  // (stages: [{key, type, text, config, result}]) y la configuración
  // actual del flujo. Devuelve null cuando el flujo ya terminó.
  getNextStage(stages, flowConfig = {}) {
    const trimPercent = flowConfig.quotaTrimPercent ?? 10;
    const thresholdPercent = flowConfig.categoryThresholdPercent ?? 10;
    const lang = flowConfig.lang;
    const last = stages[stages.length - 1];

    if (last.key === "count") {
      const countValue = Math.max(1, roundHalfDown(last.result.average));
      if (countValue === 1) {
        return {
          key: "memberSetup",
          type: "conteo_miembros",
          text: t("cuotas.memberSetup.single", lang),
          config: { mode: "single" },
        };
      }
      return {
        key: "names",
        type: "recoleccion_abierta",
        text: t("cuotas.names", lang, { count: countValue }),
        config: { maxItemsPerPerson: countValue, categoryCount: countValue },
      };
    }

    if (last.key === "names") {
      const allNames = last.result.pool.map((p) => p.text);
      return {
        key: "fusionarCategorias",
        type: "fusionar_categorias",
        text: t("cuotas.fusionarCategorias", lang),
        config: { categories: allNames },
      };
    }

    if (last.key === "fusionarCategorias") {
      const namesStage = [...stages].reverse().find((s) => s.key === "names");
      const { pool, totalResponses } = namesStage.result;
      const countByText = {};
      pool.forEach((p) => (countByText[p.text] = p.count));

      // El "apoyo" de una categoría fusionada es la suma del apoyo de
      // los nombres que se juntaron en ella.
      const finalCounts = {};
      last.result.mergedGroups.forEach((g) => {
        const displayName = `${g.primary} (${g.aliases.join(", ")})`;
        finalCounts[displayName] = [g.primary, ...g.aliases].reduce((s, n) => s + (countByText[n] || 0), 0);
      });
      const mergedRawNames = new Set(last.result.mergedGroups.flatMap((g) => [g.primary, ...g.aliases]));
      pool.forEach((p) => {
        if (!mergedRawNames.has(p.text)) finalCounts[p.text] = p.count;
      });

      let survivors = Object.keys(finalCounts).filter((name) => totalResponses > 0 && (finalCounts[name] / totalResponses) * 100 >= thresholdPercent);
      if (survivors.length === 0) survivors = Object.keys(finalCounts).slice(0, 1);
      const categoryCount = namesStage.config.categoryCount;
      return {
        key: "ranking",
        type: "ranking_multiganador",
        text: t("cuotas.ranking", lang, { threshold: thresholdPercent }),
        config: { options: survivors, winnersCount: Math.min(categoryCount, survivors.length) },
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
        text: t("cuotas.memberSetup.categories", lang),
        config: { mode: "categories", categories },
      };
    }

    if (last.key === "memberSetup") {
      if (last.config.mode === "single") {
        return {
          key: "singleQuota",
          type: "promedio",
          text: t("cuotas.singleQuota", lang),
          config: { trimPercent },
        };
      }
      return {
        key: "quotas",
        type: "promedio_por_categoria",
        text: t("cuotas.quotas", lang),
        config: { categories: last.config.categories, trimPercent },
      };
    }

    if (last.key === "singleQuota" || last.key === "quotas") {
      return approvalStage("cuotas", flowConfig.lang);
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

  getInitialStage(flowConfig = {}) {
    const ingresosFromCuotas = flowConfig.totalBudget != null;
    return {
      key: "gastosFijos",
      type: "gastos_fijos",
      text: ingresosFromCuotas
        ? t("presupuesto.gastosFijos.chained", flowConfig.lang)
        : t("presupuesto.gastosFijos.standalone", flowConfig.lang),
      config: { suggestedIngresos: flowConfig.totalBudget || null, ingresosFromCuotas },
    };
  },

  getNextStage(stages, flowConfig = {}) {
    const thresholdPercent = flowConfig.selectionThresholdPercent ?? 10;
    const lang = flowConfig.lang;
    const last = stages[stages.length - 1];

    if (last.key === "gastosFijos") {
      return {
        key: "categories",
        type: "recoleccion_abierta",
        text: t("presupuesto.categories", lang),
        config: { maxItemsPerPerson: 5, fixedExpenseNames: last.result.gastos.map((g) => g.nombre) },
      };
    }

    if (last.key === "categories") {
      const allNames = last.result.pool.map((p) => p.text);
      return {
        key: "fusionarCategorias",
        type: "fusionar_categorias",
        text: t("presupuesto.fusionarCategorias", lang),
        config: { categories: allNames },
      };
    }

    if (last.key === "fusionarCategorias") {
      const allNames = last.result.finalCategories;
      return {
        key: "selection",
        type: "seleccion_multiple",
        text: t("presupuesto.selection", lang, { threshold: thresholdPercent }),
        config: { options: allNames },
      };
    }

    if (last.key === "selection") {
      let survivors = last.result.tally.filter((t) => t.percent >= thresholdPercent).map((t) => t.option);
      if (survivors.length === 0) {
        const sorted = [...last.result.tally].sort((a, b) => b.percent - a.percent);
        survivors = sorted.slice(0, 1).map((t) => t.option);
      }
      return buildBudgetStage(stages, survivors, "presupuesto", flowConfig.lang);
    }

    if (last.key === "budget") {
      return approvalStage("presupuesto", flowConfig.lang);
    }

    if (last.key === "approval") {
      if (last.result.winner === "Sí") {
        return {
          key: "openBids",
          type: "mayoria",
          text: t("presupuesto.openBids", lang),
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

const RESPONSABILIDADES_SUGGESTED_ROLES = [
  { id: "tesorero", name: "Tesorero", description: "recibe el dinero de las cuotas y lo reparte para los proyectos." },
  { id: "auditor", name: "Auditor", description: "revisa los proyectos para asegurarse de que sí se estén realizando conforme a las propuestas y de acuerdo al presupuesto." },
  { id: "facilitador", name: "Facilitador", description: "encargado de organizar las reuniones durante el mes." },
];

// Convierte nombres de puestos (texto simple, ya elegidos por votación)
// en objetos {id, name, description} — si el nombre coincide con uno
// de los sugeridos, se le conserva su descripción.
function rolesFromNames(names) {
  return names.map((name) => {
    const clean = String(name).trim();
    const match = RESPONSABILIDADES_SUGGESTED_ROLES.find((r) => r.name.toLowerCase() === clean.toLowerCase());
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return { id: slug || `puesto_${Math.random().toString(36).slice(2, 8)}`, name: clean, description: match ? match.description : "" };
  });
}

function responsabilidadesProponerPuestosStage(lang) {
  return {
    key: "proponerPuestos",
    type: "recoleccion_abierta",
    text: t("responsabilidades.proponerPuestos", lang),
    config: { maxItemsPerPerson: 5, suggestedItems: RESPONSABILIDADES_SUGGESTED_ROLES.map((r) => r.name) },
  };
}

const responsabilidades = {
  defaultConfig: { puestosThresholdPercent: 10 },

  // flowConfig.skipOpenVote === true cuando este flujo se usa desde
  // "Selección de responsables" en solitario (fuera de Asociaciones):
  // ahí, elegir la opción desde inicio YA es la decisión de hacerlo —
  // no hace falta volver a preguntarle al grupo. Dentro de Asociaciones
  // (donde esto es una función extra, opcional, sugerida al final del
  // proceso) sí se le pregunta al grupo primero.
  getInitialStage(flowConfig) {
    const lang = flowConfig && flowConfig.lang;
    if (flowConfig && flowConfig.skipOpenVote) {
      return responsabilidadesProponerPuestosStage(lang);
    }
    return {
      key: "openRoles",
      type: "mayoria",
      text: t("responsabilidades.openRoles", lang),
      config: {
        options: ["Sí", "No"],
        majorityRule: "absoluta",
        explanation: t("responsabilidades.openRoles.explanation", lang),
      },
    };
  },

  getNextStage(stages, flowConfig = {}) {
    const last = stages[stages.length - 1];
    const thresholdPercent = flowConfig.puestosThresholdPercent ?? 10;
    const lang = flowConfig.lang;

    if (last.key === "openRoles") {
      if (last.result.winner !== "Sí") return null;
      return responsabilidadesProponerPuestosStage(lang);
    }

    if (last.key === "proponerPuestos") {
      const allNames = last.result.pool.map((p) => p.text);
      return {
        key: "fusionarPuestos",
        type: "fusionar_categorias",
        text: t("responsabilidades.fusionarPuestos", lang),
        config: { categories: allNames },
      };
    }

    if (last.key === "fusionarPuestos") {
      const allNames = last.result.finalCategories;
      return {
        key: "votarPuestos",
        type: "seleccion_multiple",
        text: t("responsabilidades.votarPuestos", lang, { threshold: thresholdPercent }),
        config: { options: allNames },
      };
    }

    if (last.key === "votarPuestos") {
      return {
        key: "frequencyVote",
        type: "mayoria",
        text: t("responsabilidades.frequencyVote", lang),
        config: {
          options: ["Calendario rotativo", "Una sola vez"],
          majorityRule: "absoluta",
          explanation: t("responsabilidades.frequencyVote.explanation", lang),
        },
      };
    }

    if (last.key === "frequencyVote") {
      const votedStage = [...stages].reverse().find((s) => s.key === "votarPuestos");
      let minCandidates = 1;
      if (votedStage) {
        let survivors = votedStage.result.tally.filter((t) => t.percent >= thresholdPercent).map((t) => t.option);
        if (survivors.length === 0) {
          const sorted = [...votedStage.result.tally].sort((a, b) => b.percent - a.percent);
          survivors = sorted.slice(0, 1).map((t) => t.option);
        }
        minCandidates = survivors.length;
      }
      return {
        key: "configurarCandidatos",
        type: "configurar_candidatos",
        text: t("responsabilidades.configurarCandidatos", lang),
        config: { minCandidates },
      };
    }

    if (last.key === "configurarCandidatos") {
      const names = last.result.candidates.join(", ");
      return {
        key: "approvalVote",
        type: "mayoria",
        text: t("responsabilidades.approvalVote", lang, { names }),
        config: { options: ["Sí", "No"], majorityRule: "absoluta" },
      };
    }

    if (last.key === "approvalVote") {
      if (last.result.winner === "Sí") {
        return {
          key: "realizarSorteo",
          type: "realizar_sorteo",
          text: t("responsabilidades.realizarSorteo", lang),
          config: {},
        };
      }
      const candStage = [...stages].reverse().find((s) => s.key === "configurarCandidatos");
      return {
        key: "ajustarCandidatos",
        type: "ajustar_candidatos",
        text: t("responsabilidades.ajustarCandidatos", lang),
        config: { candidates: candStage.result.candidates },
      };
    }

    if (last.key === "ajustarCandidatos") {
      return {
        key: "fusionarCandidatos",
        type: "fusionar_candidatos",
        text: t("responsabilidades.fusionarCandidatos", lang),
        config: { candidates: last.result.finalCandidates },
      };
    }

    if (last.key === "fusionarCandidatos") {
      return {
        key: "realizarSorteo",
        type: "realizar_sorteo",
        text: t("responsabilidades.realizarSorteo", lang),
        config: {},
      };
    }

    return null;
  },
};

const tabuladorSueldos = {
  defaultConfig: { sueldoTrimPercent: 10 },

  getInitialStage() {
    return {
      key: "limiteVote",
      type: "mayoria",
      text: "¿Quieres que exista un límite de desigualdad entre la persona que más gana y la que menos gana en nuestra cooperativa?",
      config: { options: ["Sí", "No"], majorityRule: "absoluta" },
    };
  },

  getNextStage(stages, flowConfig = {}) {
    const last = stages[stages.length - 1];

    if (last.key === "limiteVote") {
      if (last.result.winner === "Sí") {
        return {
          key: "vecesPromedio",
          type: "promedio",
          text: "¿Cuántas veces más piensas que debe ganar la persona que más gana en nuestra cooperativa, comparada con la persona que menos gana? (considerando que trabajan las mismas horas)",
          config: { trimPercent: 0 },
        };
      }
      return { key: "configurarPuestos", type: "configurar_puestos", text: "Define los puestos de la cooperativa.", config: { suggestedRoles: [], minSlots: 5 } };
    }

    if (last.key === "vecesPromedio") {
      return { key: "configurarPuestos", type: "configurar_puestos", text: "Define los puestos de la cooperativa.", config: { suggestedRoles: [], minSlots: 5 } };
    }

    if (last.key === "configurarPuestos") {
      const names = last.result.roles.map((r) => r.name).join(", ");
      return {
        key: "aprobarPuestos",
        type: "mayoria",
        text: `¿Aprueban esta lista de puestos? ${names}`,
        config: { options: ["Sí", "No"], majorityRule: "absoluta" },
      };
    }

    if (last.key === "aprobarPuestos") {
      if (last.result.winner !== "Sí") {
        const prevRoles = [...stages].reverse().find((s) => s.key === "configurarPuestos").result.roles;
        return { key: "configurarPuestos", type: "configurar_puestos", text: "Ajusten la lista de puestos — no se aprobó la anterior.", config: { suggestedRoles: prevRoles, minSlots: 5 } };
      }
      return {
        key: "frecuenciaSueldo",
        type: "mayoria",
        text: "¿Los sueldos de la cooperativa se deciden por hora, o por mes?",
        config: { options: ["Por hora", "Por mes"], majorityRule: "simple" },
      };
    }

    if (last.key === "frecuenciaSueldo") {
      const rolesStage = [...stages].reverse().find((s) => s.key === "configurarPuestos");
      const vecesStage = stages.find((s) => s.key === "vecesPromedio");
      const limitTimes = vecesStage ? vecesStage.result.average : null;
      const frequency = last.result.winner === "Por hora" ? "hora" : "mes";
      const trimPercent = flowConfig.sueldoTrimPercent ?? 10;
      return {
        key: "montoPorPuesto",
        type: "monto_por_puesto",
        text: `¿Cuánto debería ganar cada puesto en nuestra cooperativa? (por ${frequency})`,
        config: { roles: rolesStage.result.roles, frequency, limitTimes, trimPercent },
      };
    }

    if (last.key === "montoPorPuesto") {
      return {
        key: "aprobarSueldos",
        type: "mayoria",
        text: "¿Aprueban este resultado de sueldos por puesto?",
        config: { options: ["Sí", "No"], majorityRule: "absoluta" },
      };
    }

    if (last.key === "aprobarSueldos") {
      if (last.result.winner !== "Sí") {
        const freqStage = [...stages].reverse().find((s) => s.key === "frecuenciaSueldo");
        const rolesStage = [...stages].reverse().find((s) => s.key === "configurarPuestos");
        const prevMontos = [...stages].reverse().find((s) => s.key === "montoPorPuesto");
        return {
          key: "montoPorPuesto",
          type: "monto_por_puesto",
          text: "Vuelvan a proponer los sueldos — no se aprobó el resultado anterior.",
          config: prevMontos.config,
        };
      }
      return null;
    }

    return null;
  },
};

const presupuestoCooperativa = {
  defaultConfig: { selectionThresholdPercent: 10 },

  getInitialStage() {
    return {
      key: "gastosFijos",
      type: "gastos_fijos",
      text: "Ingresa los ingresos mensuales de la cooperativa y desglosa sus gastos fijos.",
      config: {},
    };
  },

  getNextStage(stages, flowConfig = {}) {
    const thresholdPercent = flowConfig.selectionThresholdPercent ?? 10;
    const last = stages[stages.length - 1];

    if (last.key === "gastosFijos") {
      return { key: "categories", type: "recoleccion_abierta", text: "Propón rubros de gasto para el presupuesto (además de los gastos fijos ya establecidos).", config: { maxItemsPerPerson: 5 } };
    }

    if (last.key === "categories") {
      const allNames = last.result.pool.map((p) => p.text);
      return {
        key: "fusionarCategorias",
        type: "fusionar_categorias",
        text: "¿Hay rubros propuestos que en realidad son el mismo? Márquenlos juntos si creen que sí.",
        config: { categories: allNames },
      };
    }

    if (last.key === "fusionarCategorias") {
      const allNames = last.result.finalCategories;
      return {
        key: "selection",
        type: "seleccion_multiple",
        text: `Elige los rubros que te importan (puedes elegir varios). Se descartan los que no lleguen al ${thresholdPercent}% de apoyo.`,
        config: { options: allNames },
      };
    }

    if (last.key === "selection") {
      let survivors = last.result.tally.filter((t) => t.percent >= thresholdPercent).map((t) => t.option);
      if (survivors.length === 0) {
        const sorted = [...last.result.tally].sort((a, b) => b.percent - a.percent);
        survivors = sorted.slice(0, 1).map((t) => t.option);
      }
      return buildBudgetStage(stages, survivors, "presupuestoCooperativa", flowConfig.lang);
    }

    if (last.key === "budget") {
      return approvalStage("presupuestoCooperativa", flowConfig.lang);
    }

    if (last.key === "approval") {
      if (last.result.winner === "Sí") return null;
      const budgetStage = [...stages].reverse().find((s) => s.key === "budget");
      return { key: "budget", type: "porcentaje_por_categoria", text: budgetStage.text, config: budgetStage.config };
    }

    return null;
  },
};

const TEMPLATES = { cuotas, presupuesto, responsabilidades, tabuladorSueldos, presupuestoCooperativa };

module.exports = { TEMPLATES, rolesFromNames };
