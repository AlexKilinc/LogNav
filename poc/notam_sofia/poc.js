#!/usr/bin/env node
/* poc.js — POC en ligne de commande.

   Contre le VRAI SOFIA (à lancer depuis votre Mac / PC, pas d'ici) :
       node poc.js --route LFPN,LFPZ

   Contre la doublure locale (ce qui tourne dans cet environnement) :
       node faux_sofia.js 8899 &
       node poc.js --route LFPN,LFPZ --origin http://127.0.0.1:8899

   Options : --route A,B[,C…]  --origin URL  --duration HHMM  --traffic VI
             --width NM  --radius NM  --fl-lower N  --fl-upper N  --lang fr|en
             --valid-from 2026-08-27T12:00:00Z  --json  --sans-preparation
*/
const { recuperePib } = require("./sofia_client");

function opt(nom, defaut) {
  const i = process.argv.indexOf("--" + nom);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
}
const drapeau = (n) => process.argv.includes("--" + n);

(async () => {
  const route = opt("route", "LFPN,LFPZ").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = opt("origin", undefined);
  const brut = drapeau("json");

  if (!brut) {
    console.log("POC NOTAM SOFIA — LOGNAVAK");
    console.log("  route   : " + route.join(" → "));
    console.log("  serveur : " + (origin || "https://sofia-briefing.aviation-civile.gouv.fr"));
    console.log("");
  }

  const t0 = Date.now();
  let r;
  try {
    r = await recuperePib({
      route, origin,
      duration: opt("duration", "1200"),
      traffic: opt("traffic", "VI"),
      flLower: Number(opt("fl-lower", 0)),
      flUpper: Number(opt("fl-upper", 999)),
      widthNM: Number(opt("width", 15)),
      radiusADNM: Number(opt("radius", 30)),
      lang: opt("lang", "fr"),
      validFrom: opt("valid-from", undefined),
      sansPreparation: drapeau("sans-preparation"),
      delaiMs: Number(opt("delai", 20000)),
    });
  } catch (e) {
    console.error("\nÉCHEC : " + (e && e.message || e));
    process.exit(1);
  }

  if (brut) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

  console.log("Étapes HTTP");
  for (const t of r.trace) {
    console.log("  " + t.etape.padEnd(12) + t.methode.padEnd(5) +
      String(t.code).padEnd(5) + String(t.ms + " ms").padEnd(9) +
      (t.cookiesRecus && t.cookiesRecus.length ? "cookies: " + t.cookiesRecus.join(",") : "") +
      (t.taille ? "  " + t.taille + " o" : "") +
      (t.erreur ? "  ERREUR " + t.erreur : ""));
  }

  const L = r.pib.listnotams || {};
  console.log("\nPIB");
  console.log("  pibUid    : " + r.pib.pibUid);
  console.log("  validFrom : " + r.pib.validFrom);
  console.log("  validTo   : " + r.pib.validTo);
  console.log("  ADDep     : " + (L.ADDep && L.ADDep.code) + " — " + (L.ADDep && L.ADDep.name));
  console.log("  ADDes     : " + (L.ADDes && L.ADDes.code) + " — " + (L.ADDes && L.ADDes.name));

  console.log("\nNOTAM extraits : " + r.notams.length);
  for (const n of r.notams) {
    console.log("  [" + (n.terrain || "?") + " / " + n.categorie + "] " + n.id + "  " + n.texte);
  }
  console.log("\nrécupéré à " + r.retrievedAt + " · " + (Date.now() - t0) + " ms au total");
  console.log("source : SOFIA-Briefing (DGAC)");
})();
