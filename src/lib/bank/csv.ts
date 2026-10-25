// Lecture et écriture CSV (RFC 4180) : guillemets, retours à la ligne dans les cellules,
// BOM UTF-8 et détection du séparateur (virgule, point-virgule ou tabulation).

export type Delimiter = "," | ";" | "\t";

/** Choisit le séparateur le plus fréquent de la première ligne (hors guillemets). */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const char of text.slice(0, 20000)) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && char in counts) counts[char as Delimiter] += 1;
  }
  const best = (Object.entries(counts) as [Delimiter, number][]).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

/** Découpe un texte CSV en lignes de cellules. Les lignes entièrement vides sont conservées vides. */
export function parseCsv(input: string, delimiter?: Delimiter): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === sep) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
    i += 1;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Sérialise des lignes en CSV (guillemets si nécessaire). */
export function toCsv(rows: (string | number)[][], delimiter: Delimiter = ","): string {
  const escape = (value: string | number) => {
    const text = String(value ?? "");
    return text.includes('"') || text.includes("\n") || text.includes("\r") || text.includes(delimiter)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };
  return rows.map((row) => row.map(escape).join(delimiter)).join("\r\n") + "\r\n";
}
