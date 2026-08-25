// Convierte filas (arreglo de arreglos) a texto CSV, escapando comas,
// comillas y saltos de línea cuando hace falta.

function escapeField(field) {
  const str = String(field ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows) {
  return rows.map((row) => row.map(escapeField).join(",")).join("\n");
}

module.exports = { toCsv };
