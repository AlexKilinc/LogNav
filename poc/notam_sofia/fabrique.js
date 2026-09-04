/* fabrique.js — construit le fichier « cartes » à coller dans Supabase.

   Le bloc SOFIA est copié OCTET POUR OCTET depuis greffe_cartes_7.42.ts, déjà
   éprouvé par test_greffe.mjs : rien ne peut diverger entre ce qui a été testé
   et ce qui sera déployé.

   La fabrique est IDEMPOTENTE : elle part du dernier fichier produit, en
   excise l'ancien bloc SOFIA (du marqueur jusqu'au commentaire SIGMET) et y
   pose le nouveau. On peut donc la rejouer autant de fois que la greffe évolue,
   sans jamais recopier le relais d'origine à la main.

   Elle trouve seule le dernier cartes_X.YZ.ts présent et produit le suivant :
   aucune constante à changer à la main d'un tour sur l'autre.

   node fabrique.js
*/
const fs = require("fs");

const versions = fs.readdirSync(".")
  .map((f) => /^cartes_(\d+)\.(\d+)\.ts$/.exec(f))
  .filter(Boolean)
  .map((m) => ({ f: m[0], maj: +m[1], min: +m[2] }))
  .sort((a, b) => a.maj - b.maj || a.min - b.min);
if (!versions.length) throw new Error("aucun cartes_X.YZ.ts dans ce dossier");
const cur = versions[versions.length - 1];
const DE = cur.maj + "." + cur.min, VERS = cur.maj + "." + (cur.min + 1);
const ENTREE = cur.f, SORTIE = "cartes_" + VERS + ".ts";
console.log("  · base : " + ENTREE);
const MARQUE = "/* ================== NOTAM via SOFIA-Briefing";
const APRES = "/* SIGMET : relais vers l'Aviation Weather Center";

let src = fs.readFileSync(ENTREE, "utf8");
const g = fs.readFileSync("greffe_cartes_7.42.ts", "utf8");
const bloc = g.slice(g.indexOf(MARQUE)).trimEnd();
const faites = [];

/* 1 — la version */
const avant = src;
src = src.split('const VERSION = "' + DE + '";').join('const VERSION = "' + VERS + '";');
if (src === avant) throw new Error("VERSION " + DE + " introuvable");
src = src.split("doit répondre " + DE + ".").join("doit répondre " + VERS + ".");
faites.push("VERSION " + DE + " -> " + VERS);

/* 2 — le bloc SOFIA : on remplace l'ancien s'il est là, sinon on l'insère */
const i = src.indexOf(MARQUE), j = src.indexOf(APRES);
if (j < 0) throw new Error("marque SIGMET introuvable");
if (i >= 0 && i < j) {
  src = src.slice(0, i) + bloc + "\n\n" + src.slice(j);
  faites.push("bloc SOFIA remplacé (" + bloc.split("\n").length + " lignes)");
} else {
  src = src.slice(0, j) + bloc + "\n\n" + src.slice(j);
  faites.push("bloc SOFIA inséré (" + bloc.split("\n").length + " lignes)");
}

/* 3 — la ligne du dispatcher, si elle n'y est pas déjà */
const d = '  if (q.get("notam") === "1") return notam(q);';
const s = '  if (q.get("sofia") === "1") return notamSofia(q);';
if (src.indexOf(d) < 0) throw new Error("ligne notam du dispatcher introuvable");
if (src.indexOf(s) < 0) {
  src = src.replace(d, d + "\n" + s);
  faites.push("dispatcher : ?sofia=1 branché après ?notam=1");
} else faites.push("dispatcher : ?sofia=1 déjà en place");

/* 4 — la doc des appels, si elle n'y est pas déjà */
const ligneV = " *   GET ?version=1                                  -> version du code déployé";
if (src.indexOf("?sofia=1&route=") < 0 && src.indexOf(ligneV) >= 0) {
  src = src.replace(ligneV,
    " *   GET ?sofia=1&route=LFPN,LFPZ                    -> NOTAM via SOFIA (PIB route étroite)\n" + ligneV);
  faites.push("mode d'emploi : la branche ?sofia=1 est listée");
}

fs.writeFileSync(SORTIE, src);
faites.forEach((f) => console.log("  · " + f));
console.log("\n" + SORTIE + " · " + src.split("\n").length + " lignes");
console.log("dernière ligne : " + JSON.stringify(src.trimEnd().split("\n").pop()));

/* garde-fous : présents exactement une fois */
let souci = 0;
for (const u of ['const VERSION = "' + VERS + '";', s,
                 "async function notamSofia(", "async function sofiaPib(",
                 "function sofiaAplatis(", MARQUE, APRES]) {
  const n = src.split(u).length - 1;
  if (n !== 1) { console.log("  ANOMALIE : « " + u.slice(0, 46) + " » présent " + n + " fois"); souci++; }
}
/* rien de l'existant ne doit avoir disparu */
for (const c of ["function recolteSofia(", "async function notam(", "async function azba(",
  "async function supAip(", "async function sigmet(", "async function viaAeroweb(",
  "async function posteSofia(", "Deno.serve(async (req: Request)"]) {
  if (src.indexOf(c) < 0) { console.log("  PERDU : " + c); souci++; }
}
console.log(souci ? "\n" + souci + " anomalie(s)" : "\ntout est en place");
process.exit(souci ? 1 : 0);
