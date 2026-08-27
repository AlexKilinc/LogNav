/* structure.js — radiographie d'un PIB réel.

   Le document ne décrit pas la forme de listnotams : il n'en cite que
   ADDep.code / ADDes.code. Le test réel a montré deux choses qu'il faut
   éclaircir avant d'écrire quoi que ce soit dans LOGNAVAK :

     · le champ « id » que l'aplatisseur a retenu n'est PAS le numéro de NOTAM
       (400000051804734 là où le document citait E 3550/26) ;
     · les textes sont revenus en anglais alors que lang=fr était envoyé.

   Ce script ne devine rien : il lit le PIB capturé et affiche ce qu'il y a
   vraiment dedans — les catégories, tous les noms de champs d'un NOTAM, et
   la recherche de tout champ qui porterait une version française.

   Utilisation :
       node poc.js --route LFPN,LFPZ --json > pib_reel.json
       node structure.js
*/
const fs = require("fs");

const chemin = process.argv[2] || "pib_reel.json";
if (!fs.existsSync(chemin)) {
  console.error("Fichier introuvable : " + chemin);
  console.error("Produisez-le d'abord :  node poc.js --route LFPN,LFPZ --json > pib_reel.json");
  process.exit(1);
}
const racine = JSON.parse(fs.readFileSync(chemin, "utf8"));
const pib = racine.pib || racine;
const L = pib.listnotams || {};

const coupe = (v, n = 70) => {
  const s = String(v).replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "…" : s;
};

console.log("═══ NIVEAU 1 — le PIB ═══");
for (const [k, v] of Object.entries(pib)) {
  console.log("  " + k.padEnd(28) + (typeof v === "object" && v !== null ? "{objet}" : coupe(v)));
}

console.log("\n═══ NIVEAU 2 — listnotams ═══");
for (const [k, v] of Object.entries(L)) {
  const t = Array.isArray(v) ? "tableau[" + v.length + "]" : (v && typeof v === "object" ? "{objet}" : coupe(v));
  console.log("  " + k.padEnd(28) + t);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k2, v2] of Object.entries(v)) {
      const t2 = Array.isArray(v2) ? "tableau[" + v2.length + "]" : (v2 && typeof v2 === "object" ? "{objet}" : coupe(v2));
      console.log("      " + k2.padEnd(44) + t2);
    }
  }
}

/* ---- on descend jusqu'au premier objet qui ressemble à un NOTAM ---- */
let exemple = null, cheminExemple = [];
(function marche(n, ch) {
  if (exemple || !n || typeof n !== "object") return;
  if (Array.isArray(n)) { for (const x of n) { marche(x, ch); if (exemple) return; } return; }
  const clefs = Object.keys(n);
  const ressemble = clefs.some((k) => /^(id|text|texte|message)$/i.test(k)) && clefs.length >= 2;
  if (ressemble) { exemple = n; cheminExemple = ch; return; }
  for (const [k, v] of Object.entries(n)) { marche(v, ch.concat(k)); if (exemple) return; }
})(L, []);

console.log("\n═══ NIVEAU 3 — UN NOTAM COMPLET, tous ses champs ═══");
if (!exemple) {
  console.log("  aucun objet NOTAM reconnu — envoyez-moi pib_reel.json tel quel");
} else {
  console.log("  chemin : listnotams." + cheminExemple.join(".") + "\n");
  for (const [k, v] of Object.entries(exemple)) {
    const t = v === null ? "null"
      : Array.isArray(v) ? "tableau[" + v.length + "] " + coupe(JSON.stringify(v), 50)
      : typeof v === "object" ? coupe(JSON.stringify(v), 60)
      : coupe(v, 90);
    console.log("  " + k.padEnd(24) + t);
  }
}

/* ---- y a-t-il du français quelque part ? ---- */
console.log("\n═══ RECHERCHE DU FRANÇAIS ═══");
const champsFr = new Set(), champsTexte = new Map();
const MOTS_FR = /\b(piste|fermée?|fermé|travaux|indisponible|interdit|aérodrome|balisage|circulation|hauteur|nuit|jour|sauf|heures?)\b/i;
(function ratisse(n) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) return n.forEach(ratisse);
  for (const [k, v] of Object.entries(n)) {
    if (typeof v === "string") {
      if (/fr|franc|trad|local/i.test(k) && v.length > 3) champsFr.add(k);
      if (v.length > 25) {
        champsTexte.set(k, (champsTexte.get(k) || 0) + 1);
        if (MOTS_FR.test(v)) champsFr.add(k + "  ← contient des mots français");
      }
    } else ratisse(v);
  }
})(L);

console.log("  champs porteurs de texte long, et leur nombre d'occurrences :");
[...champsTexte].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log("      " + k.padEnd(24) + n));
console.log("\n  champs susceptibles d'être francophones :");
if (!champsFr.size) console.log("      aucun — la traduction demande sans doute un paramètre de requête en plus");
else champsFr.forEach((k) => console.log("      " + k));

console.log("\n═══ VOLUME ═══");
console.log("  taille du PIB : " + Math.round(JSON.stringify(pib).length / 1024) + " ko");
console.log("  NOTAM extraits par l'aplatisseur actuel : " + (racine.notams ? racine.notams.length : "?"));
