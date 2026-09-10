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

// Arma la etapa de "asignar % del presupuesto", combinando los gastos
// fijos que ya puso el facilitador (con su % de referencia precargado,
// según cuánto representan de los ingresos) con los rubros que el
// grupo votó — estos últimos empiezan en 0%, para que el grupo decida
// desde cero cómo repartir lo que no está comprometido en gastos fijos.
function buildBudgetStage(stages, survivorCategories, label) {
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
    text: `Asigna el % de ${label} que crees justo para cada rubro (si la suma pasa de 100%, se ajusta sola). Los gastos fijos ya vienen con su % de referencia, pero los puedes mover.`,
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
      const allNames = last.result.pool.map((p) => p.text);
      return {
        key: "fusionarCategorias",
        type: "fusionar_categorias",
        text: "¿Hay categorías propuestas que en realidad son la misma? Márquenlas juntas si creen que sí.",
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
        text: `Ordena estas categorías propuestas según tu preferencia (toca en orden: 1ª, 2ª…). Se descartaron las que no llegaron al ${thresholdPercent}% de apoyo.`,
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

  getInitialStage(flowConfig = {}) {
    const ingresosFromCuotas = flowConfig.totalBudget != null;
    return {
      key: "gastosFijos",
      type: "gastos_fijos",
      text: ingresosFromCuotas
        ? "Desglosa los gastos fijos del presupuesto (si no hay gastos fijos, deja la lista vacía y continúa)."
        : "Desglosa los gastos fijos del presupuesto (si no hay, deja la lista vacía). Ingresar los ingresos totales es opcional — si los pones, se usan para calcular a cuánto equivale cada % más adelante.",
      config: { suggestedIngresos: flowConfig.totalBudget || null, ingresosFromCuotas },
    };
  },

  getNextStage(stages, flowConfig = {}) {
    const thresholdPercent = flowConfig.selectionThresholdPercent ?? 10;
    const last = stages[stages.length - 1];

    if (last.key === "gastosFijos") {
      return {
        key: "categories",
        type: "recoleccion_abierta",
        text: "Propón categorías de gasto para el presupuesto (una por recuadro).",
        config: { maxItemsPerPerson: 5, fixedExpenseNames: last.result.gastos.map((g) => g.nombre) },
      };
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
      return buildBudgetStage(stages, survivors, "el presupuesto");
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

function responsabilidadesProponerPuestosStage() {
  return {
    key: "proponerPuestos",
    type: "recoleccion_abierta",
    text: "Propongan los puestos o responsabilidades que debería tener este grupo — ya tienen algunos sugeridos, pueden editarlos o agregar más.",
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
    if (flowConfig && flowConfig.skipOpenVote) {
      return responsabilidadesProponerPuestosStage();
    }
    return {
      key: "openRoles",
      type: "mayoria",
      text: "¿Quieren asignar puestos y responsabilidades por sorteo?",
      config: {
        options: ["Sí", "No"],
        majorityRule: "absoluta",
        explanation:
          "En vez de que el facilitador asigne los puestos a mano, la app elige al azar entre los candidatos, de forma segura e imposible de manipular. Nadie repite el mismo puesto dos veces seguidas, ni tiene dos puestos en el mismo periodo.\n\nEsto solo se activa si más del 50% del grupo vota que sí. Si no se llega a esa mayoría, el grupo sigue como está, sin puestos asignados.",
      },
    };
  },

  getNextStage(stages, flowConfig = {}) {
    const last = stages[stages.length - 1];
    const thresholdPercent = flowConfig.puestosThresholdPercent ?? 10;

    if (last.key === "openRoles") {
      if (last.result.winner !== "Sí") return null;
      return responsabilidadesProponerPuestosStage();
    }

    if (last.key === "proponerPuestos") {
      const allNames = last.result.pool.map((p) => p.text);
      return {
        key: "fusionarPuestos",
        type: "fusionar_categorias",
        text: "¿Hay puestos propuestos que en realidad son el mismo? Márquenlos juntos si creen que sí.",
        config: { categories: allNames },
      };
    }

    if (last.key === "fusionarPuestos") {
      const allNames = last.result.finalCategories;
      return {
        key: "votarPuestos",
        type: "seleccion_multiple",
        text: `Elijan los puestos que crean que este grupo debería tener (pueden elegir varios). Se descartan los que no lleguen al ${thresholdPercent}% de apoyo.`,
        config: { options: allNames },
      };
    }

    if (last.key === "votarPuestos") {
      return {
        key: "frequencyVote",
        type: "mayoria",
        text: "¿Reparten los puestos una sola vez, o arman un calendario rotativo (12 meses)?",
        config: {
          options: ["Calendario rotativo", "Una sola vez"],
          majorityRule: "absoluta",
          explanation:
            "Calendario rotativo: se sortea de una sola vez un calendario completo (12 meses) que dice quién tiene cada puesto, mes por mes. Cada quien va saliendo del sorteo conforme le toca un puesto, hasta que todos hayan ocupado alguno — ahí se vuelve a incluir a todos y se sigue repartiendo.\n\nUna sola vez: se sortea una sola vez por puesto (sin calendario), y esa persona se queda de forma indefinida.",
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
        text: "Lista de candidatos para el sorteo — se llena automáticamente con los miembros del grupo.",
        config: { minCandidates },
      };
    }

    if (last.key === "configurarCandidatos") {
      const names = last.result.candidates.join(", ");
      return {
        key: "approvalVote",
        type: "mayoria",
        text: `¿Aprueban esta lista de candidatos para el sorteo de puestos? ${names}`,
        config: { options: ["Sí", "No"], majorityRule: "absoluta" },
      };
    }

    if (last.key === "approvalVote") {
      if (last.result.winner === "Sí") {
        return {
          key: "realizarSorteo",
          type: "realizar_sorteo",
          text: "Todo listo — el facilitador puede realizar el sorteo cuando quiera.",
          config: {},
        };
      }
      const candStage = [...stages].reverse().find((s) => s.key === "configurarCandidatos");
      return {
        key: "ajustarCandidatos",
        type: "ajustar_candidatos",
        text: "No se aprobó la lista — selecciona a quién quitarías, y propón nuevos candidatos si quieres.",
        config: { candidates: candStage.result.candidates },
      };
    }

    if (last.key === "ajustarCandidatos") {
      return {
        key: "fusionarCandidatos",
        type: "fusionar_candidatos",
        text: "Revisa la lista final: si dos nombres son en realidad la misma persona (por una errata o apodo), fusiónalos en uno solo.",
        config: { candidates: last.result.finalCandidates },
      };
    }

    if (last.key === "fusionarCandidatos") {
      return {
        key: "realizarSorteo",
        type: "realizar_sorteo",
        text: "Todo listo — el facilitador puede realizar el sorteo cuando quiera.",
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
      return buildBudgetStage(stages, survivors, "el presupuesto de la cooperativa");
    }

    if (last.key === "budget") {
      return approvalStage("el presupuesto de la cooperativa");
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
