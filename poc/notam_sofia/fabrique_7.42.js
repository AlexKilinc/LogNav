/* fabrique_7.42.js — construit cartes_7.42.ts à partir du relais 7.41 et de
   la greffe déjà éprouvée. Le bloc SOFIA est copié OCTET POUR OCTET depuis
   greffe_cartes_7.42.ts : aucune recopie à la main, donc aucune faute de
   frappe possible entre ce qui a été testé et ce qui sera déployé. */
const fs = require("fs");

let src = fs.readFileSync("cartes_original_7.41.ts", "utf8");
const g = fs.readFileSync("greffe_cartes_7.42.ts", "utf8");
const bloc = g.slice(g.indexOf("/* ================== NOTAM via SOFIA-Briefing")).trimEnd();

let faites = [];

/* 1 — la version */
const avant = src;
src = src.replace('const VERSION = "7.41";', 'const VERSION = "7.42";');
if (src === avant) throw new Error("VERSION introuvable");
faites.push("VERSION 7.41 -> 7.42");

/* la ligne de mode d'emploi annonçait encore 7.29 : elle était déjà fausse */
src = src.replace("doit répondre 7.29.", "doit répondre 7.42.");
faites.push("mode d'emploi : ?version=1 annonce 7.42");

/* la nouvelle branche, documentée en tête comme les autres */
const ligneVersion = " *   GET ?version=1                                  -> version du code déployé";
if (src.indexOf(ligneVersion) < 0) throw new Error("ligne de doc ?version=1 introuvable");
src = src.replace(ligneVersion,
  " *   GET ?sofia=1&route=LFPN,LFPZ                    -> NOTAM via SOFIA (PIB route étroite)\n"
  + ligneVersion);
faites.push("mode d'emploi : la branche ?sofia=1 est listée");

/* 2 — le bloc, juste avant le commentaire SIGMET */
const marque = "/* SIGMET : relais vers l'Aviation Weather Center";
const i = src.indexOf(marque);
if (i < 0) throw new Error("marque SIGMET introuvable");
src = src.slice(0, i) + bloc + "\n\n" + src.slice(i);
faites.push("bloc SOFIA inséré (" + bloc.split("\n").length + " lignes)");

/* 3 — la ligne du dispatcher */
const d = '  if (q.get("notam") === "1") return notam(q);';
if (src.indexOf(d) < 0) throw new Error("ligne notam du dispatcher introuvable");
src = src.replace(d, d + '\n  if (q.get("sofia") === "1") return notamSofia(q);');
faites.push("dispatcher : ?sofia=1 branché après ?notam=1");

fs.writeFileSync("cartes_7.42.ts", src);

faites.forEach((f) => console.log("  · " + f));
console.log("\nlignes : " + src.split("\n").length);
console.log("dernière ligne : " + JSON.stringify(src.trimEnd().split("\n").pop()));

/* garde-fous : ce qui doit être présent exactement une fois */
const unique = [
  'const VERSION = "7.42";',
  'if (q.get("sofia") === "1") return notamSofia(q);',
  "async function notamSofia(",
  "async function sofiaPib(",
  "function sofiaAplatis(",
];
let souci = 0;
for (const u of unique) {
  const n = src.split(u).length - 1;
  if (n !== 1) { console.log("  ANOMALIE : « " + u + " » présent " + n + " fois"); souci++; }
}
/* rien de l'ancien ne doit avoir disparu */
const conserves = ["function recolteSofia(", "async function notam(", "async function azba(",
  "async function supAip(", "async function sigmet(", "async function viaAeroweb(",
  "async function posteSofia(", "Deno.serve(async (req: Request)"];
for (const c of conserves) if (src.indexOf(c) < 0) { console.log("  PERDU : " + c); souci++; }
console.log(souci ? "\n" + souci + " anomalie(s)" : "\ntout est en place");
process.exit(souci ? 1 : 0);
