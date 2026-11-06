// CSV export helpers. Cells are quoted and formula prefixes neutralised so a unit name
// starting with "=" cannot execute in the spreadsheet that opens the export.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replaceAll('"', '""')}"`;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((x) => Object.keys(x)))];
  return [
    keys.map(csvCell).join(','),
    ...rows.map((r) => keys.map((k) => csvCell(Array.isArray(r[k]) ? r[k].join('|') : r[k])).join(',')),
  ].join('\r\n');
}

module.exports = { toCsv, csvCell };
