// Lecture des fichiers d'import dans le navigateur (CSV, XLSX, JSON), modèle téléchargeable
// et protections contre les fichiers malveillants.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { detectDelimiter, parseCsv, toCsv } from "../src/lib/bank/csv.ts";
import { buildXlsx, columnIndex, decodeXml, encodeXml, readXlsx } from "../src/lib/bank/xlsx.ts";
import { fingerprintOf, formatOf, parseImportBytes, parseJson } from "../src/lib/bank/parse.ts";
import { templateCsv, templateSheets, templateXlsx } from "../src/lib/bank/template.ts";
import { chunkRows as clientChunkRows } from "../src/lib/bank/importClient.ts";
import { chunkRows as serverChunkRows, processChunk, suggestMapping } from "../server/bank/import.mjs";

const template = JSON.parse(readFileSync(new URL("../data/import-template.json", import.meta.url), "utf8"));
const bytes = (text) => new TextEncoder().encode(text);

test("CSV : guillemets, retours à la ligne dans les cellules, BOM et séparateurs", () => {
  const text = '﻿a;b;c\r\n"x;1";"ligne 1\nligne 2";"dit ""oui"""\r\n;;\r\nlast;;';
  assert.equal(detectDelimiter(text.slice(1)), ";");
  assert.deepEqual(parseCsv(text), [["a", "b", "c"], ["x;1", "ligne 1\nligne 2", 'dit "oui"'], ["", "", ""], ["last", "", ""]]);
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a\tb\n1\t2", undefined), [["a", "b"], ["1", "2"]]);
  const rows = [["h1", "h2"], ['a,"b"', "x\ny"], [1, ""]];
  assert.deepEqual(parseCsv(toCsv(rows)), [["h1", "h2"], ['a,"b"', "x\ny"], ["1", ""]]);
});

test("XML : entités décodées en une seule passe, caractères interdits retirés", () => {
  assert.equal(decodeXml("a &amp; b &lt;c&gt; &quot;d&quot; &#233; &#x41; &amp;lt;"), 'a & b <c> "d" é A &lt;');
  assert.equal(decodeXml("&unknown; &#0;"), "&unknown; ");
  assert.equal(encodeXml("a<b>&\u0001\u0008c"), "a&lt;b&gt;&amp;c");
  assert.equal(columnIndex("A1"), 0);
  assert.equal(columnIndex("AA10"), 26);
});

test("XLSX : écriture puis relecture à l'identique (accents, retours à la ligne, cellules vides)", () => {
  const data = [["Partie", "Énoncé", "Note"], [5, "Un « test » & <b>\nsur deux lignes", ""], ["", "", "fin"]];
  const sheet = readXlsx(buildXlsx([{ name: "Modèle", rows: data, boldHeader: true }, { name: "Autre", rows: [["x"]] }]));
  assert.equal(sheet.name, "Modèle");
  assert.deepEqual(sheet.rows.map((r) => r.cells), [["Partie", "Énoncé", "Note"], ["5", "Un « test » & <b>\nsur deux lignes", ""], ["", "", "fin"]]);
  assert.deepEqual(sheet.rows.map((r) => r.n), [1, 2, 3]);
});

test("XLSX : lecture d'un classeur Excel avec chaînes partagées, texte riche, booléens et lignes éparses", () => {
  const files = {
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Cachée" sheetId="1" state="hidden" r:id="rId1"/><sheet name="Questions" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>'),
    "xl/sharedStrings.xml": strToU8('<sst><si><t>prompt</t></si><si><r><t>Rich </t></r><r><t xml:space="preserve">text</t></r></si><si><t>a &amp; b</t></si></sst>'),
    "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'),
    "xl/worksheets/sheet2.xml": strToU8('<worksheet><sheetData><row r="3"><c r="A3" t="s"><v>0</v></c><c r="C3" t="b"><v>1</v></c><c r="D3"><v>2.5</v></c></row><row r="4"><c r="B4" t="s"><v>1</v></c><c r="C4" t="s"><v>2</v></c><c r="E4" t="str"><f>A1&amp;B1</f><v>calc</v></c></row></sheetData></worksheet>'),
  };
  const sheet = readXlsx(zipSync(files));
  assert.equal(sheet.name, "Questions", "les feuilles masquées sont ignorées");
  assert.deepEqual(sheet.rows, [
    { n: 3, cells: ["prompt", "", "TRUE", "2.5"] },
    { n: 4, cells: ["", "Rich text", "a & b", "", "calc"] },
  ]);
});

test("modèle : CSV et XLSX contiennent les mêmes exemples valides des parties 5, 6 et 7", () => {
  const csv = parseImportBytes("modele.csv", bytes(templateCsv()));
  const xlsx = parseImportBytes("modele.xlsx", templateXlsx());
  assert.equal(csv.format, "csv");
  assert.equal(xlsx.format, "xlsx");
  assert.deepEqual(csv.headers, template.headers);
  assert.deepEqual(xlsx.headers, template.headers);
  assert.equal(csv.rows.length, 10);
  assert.deepEqual(xlsx.rows.map((r) => r.data), csv.rows.map((r) => r.data));
  const { mapping, missing } = suggestMapping(xlsx.headers);
  assert.deepEqual(missing, []);
  const result = processChunk(xlsx.rows, mapping);
  assert.deepEqual(result.stats, { rows: 10, rejected: 0, flagged: 0 });
  assert.deepEqual(templateSheets().map((s) => s.name), ["Modèle", "Instructions", "Catégories"]);
  const parts = new Set(xlsx.rows.map((r) => r.data.part));
  assert.deepEqual([...parts].sort(), ["5", "6", "7"]);
});

test("JSON : le format actuel du dépôt (passages + questions) s'importe sans erreur", () => {
  const text = readFileSync(new URL("../data/questions.json", import.meta.url), "utf8");
  const parsed = parseImportBytes("questions.json", bytes(text));
  assert.equal(parsed.rows.length, 33);
  const { mapping, missing } = suggestMapping(parsed.headers);
  assert.deepEqual(missing, []);
  const chunks = serverChunkRows(parsed.rows, mapping, 200);
  const results = chunks.map((c) => processChunk(c, mapping));
  assert.equal(results.reduce((n, r) => n + r.stats.rejected, 0), 0, JSON.stringify(results.flatMap((r) => r.issues.filter((i) => i.severity === "error"))));
  assert.equal(results.reduce((n, r) => n + r.items.length, 0), 33);
  const p7 = results.flatMap((r) => r.items).filter((i) => i.part === 7);
  assert.ok(p7.some((i) => i.passage.documents.length === 3), "le document à trois pièces est conservé");
});

test("JSON : tableau plat, options en liste ou en dictionnaire, tags en liste", () => {
  const parsed = parseJson(JSON.stringify([
    { part: 5, prompt: "The invoice is due ______ Friday.", options: ["by", "until", "since", "during"], correct: "A", tags: ["x", "y"], difficulty: 1 },
    { part: 5, question: "We met ______ the conference.", options: { A: "at", B: "on", C: "by", D: "to" }, answer: "A" },
  ]));
  assert.deepEqual(parsed.rows[0].data.tags, "x;y");
  assert.equal(parsed.rows[1].data.option_c, "by");
  assert.equal(parsed.rows[0].data.option_d, "during");
  const { mapping } = suggestMapping(parsed.headers);
  const r = processChunk(parsed.rows, mapping);
  assert.equal(r.items.length, 2);
  assert.throws(() => parseJson("{ pas du json"), /JSON invalide/);
  assert.throws(() => parseJson('{"foo": 1}'), /tableau de questions/);
});

test("découpage côté navigateur identique à celui du serveur", () => {
  const { mapping } = suggestMapping(template.headers);
  const copies = Array.from({ length: 9 }, (_, c) => template.rows.map((r) => ({ ...r, passage_ref: r.passage_ref && `${r.passage_ref}-${c}` })));
  const rows = copies.flat().map((data, i) => ({ n: i + 2, data }));
  for (const size of [10, 25, 200]) {
    assert.deepEqual(clientChunkRows(rows, mapping, size).map((c) => c.map((r) => r.n)), serverChunkRows(rows, mapping, size).map((c) => c.map((r) => r.n)), `taille ${size}`);
  }
});

test("fichiers refusés : mauvais format, faux .xlsx, macros, bombe ZIP, volume, lignes en trop", () => {
  assert.equal(formatOf("Export.CSV"), "csv");
  assert.throws(() => formatOf("fichier.exe"), /Format non pris en charge/);
  assert.throws(() => formatOf("ancien.xls"), /\.xlsx/);
  assert.throws(() => formatOf("macro.xlsm"), /\.xlsx/);
  assert.throws(() => parseImportBytes("a.csv", new Uint8Array()), /vide/);
  assert.throws(() => parseImportBytes("a.csv", new Uint8Array(26 * 1024 * 1024)), /trop volumineux/);
  assert.throws(() => parseImportBytes("faux.xlsx", bytes("MZ ceci est un exécutable")), /pas un classeur/);
  assert.throws(() => parseImportBytes("cassé.xlsx", new Uint8Array([0x50, 0x4b, 1, 2, 3, 4])), /illisible|valide/);
  // Macros : refusées même si le reste du classeur est valide.
  const withMacro = zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "xl/vbaProject.bin": new Uint8Array([1, 2, 3]) });
  assert.throws(() => parseImportBytes("macro.xlsx", withMacro), /macros/);
  // Bombe ZIP : 130 Mo de zéros qui se compressent en quelques Ko — refusée sans décompression.
  const bomb = zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "xl/worksheets/sheet1.xml": new Uint8Array(130 * 1024 * 1024) }, { level: 9 });
  assert.ok(bomb.byteLength < 1024 * 1024, `archive de ${bomb.byteLength} octets`);
  const t = performance.now();
  assert.throws(() => parseImportBytes("bombe.xlsx", bomb), /trop volumineux/);
  assert.ok(performance.now() - t < 3000, "refus rapide");
  // Trop de lignes.
  const lines = ["part,prompt", ...Array.from({ length: 20_001 }, (_, i) => `5,q${i}`)].join("\n");
  assert.throws(() => parseImportBytes("long.csv", bytes(lines)), /Trop de lignes/);
  // Trop de colonnes.
  const wide = `${Array.from({ length: 100 }, (_, i) => `c${i}`).join(",")}\n${Array.from({ length: 100 }, () => "x").join(",")}`;
  assert.throws(() => parseImportBytes("large.csv", bytes(wide)), /Trop de colonnes/);
  assert.throws(() => parseImportBytes("vide.csv", bytes("une seule colonne\nx")), /en-tête/);
});

test("cellules : tronquées, en-têtes dupliqués renommés, aucune pollution de prototype", () => {
  const csv = `__proto__,prompt,prompt,constructor\n{"polluted":true},${"x".repeat(7000)},second,y\n`;
  const parsed = parseImportBytes("p.csv", bytes(csv));
  assert.deepEqual(parsed.headers, ["__proto__", "prompt", "prompt (2)", "constructor"]);
  assert.equal(parsed.rows[0].data.prompt.length, 6000);
  assert.equal(parsed.truncated, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(parsed.rows[0].data), null);
  assert.equal(JSON.parse(JSON.stringify(parsed.rows[0].data)).prompt.length, 6000);
  const empty = parseImportBytes("e.csv", bytes("a,b\n1,2\n,\n\n3,4\n"));
  assert.equal(empty.rows.length, 2);
  assert.equal(empty.skipped, 2);
  assert.deepEqual(empty.rows.map((r) => r.n), [2, 5]);
});

test("empreinte du fichier : stable, change avec le contenu", async () => {
  const a = await fingerprintOf(bytes("contenu A"));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, await fingerprintOf(bytes("contenu A")));
  assert.notEqual(a, await fingerprintOf(bytes("contenu B")));
});
