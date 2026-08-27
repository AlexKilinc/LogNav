#!/usr/bin/env node
/* poc_meteo.js — le POC en ligne de commande.

   Contre les VRAIS services (depuis votre Mac) :
       node poc_meteo.js
       node poc_meteo.js --produit temsi-euroc
       node poc_meteo.js --vol 2026-08-28T09:00Z,2026-08-28T13:00Z --pdf

   Contre la doublure locale (ce qui tourne ici) :
       node faux_meteo.js 8897 &
       node poc_meteo.js --sofia http://127.0.0.1:8897 --meteo http://127.0.0.1:8897

   Options
     --produit temsi-france | temsi-euroc | wintem-france | tous   (défaut : tous)
     --ref 2026-08-28T10:00Z     heure de référence (défaut : maintenant)
     --vol DEBUT,FIN             fenêtre du vol : rend TOUTES les cartes utiles
     --pdf                       télécharge et vérifie les PDF retenus
     --dossier CHEMIN            où écrire les PDF (défaut : ./cartes)
     --json                      sortie brute
     --sofia URL  --meteo URL    pour pointer sur un banc
     --aeroweb-id ID             active le repli AEROWEB
*/
const fs = require("fs");
const path = require("path");
const M = require("./meteo_client");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n);
  return i > 0 && process.argv[i + 1] && !/^--/.test(process.argv[i + 1]) ? process.argv[i + 1] : d; };
const drapeau = (n) => process.argv.includes("--" + n);

const hhmm = (iso) => String(iso).slice(0, 16).replace("T", " ") + "Z";

(async () => {
  const demande = arg("produit", "tous");
  const produits = demande === "tous" ? Object.keys(M.PRODUITS) : [demande];
  for (const p of produits) {
    if (!M.PRODUITS[p]) { console.error("produit inconnu : " + p); process.exit(1); }
  }
  const o = { sofia: arg("sofia"), meteo: arg("meteo"), aerowebId: arg("aeroweb-id") };
  const ref = arg("ref") ? new Date(arg("ref")) : new Date();
  if (isNaN(+ref)) { console.error("--ref illisible"); process.exit(1); }
  const vol = arg("vol") ? String(arg("vol")).split(",") : null;
  const brut = drapeau("json");
  const sortie = [];

  if (!brut) {
    console.log("POC TEMSI / WINTEM — LOGNAVAK");
    console.log("  référence : " + hhmm(ref.toISOString()) + (arg("ref") ? "" : "  (maintenant)"));
    if (vol) console.log("  vol       : " + hhmm(vol[0]) + " → " + hhmm(vol[1]));
    console.log("  serveurs  : " + (o.sofia || "SOFIA officiel") + " / " + (o.meteo || "aviation.meteo.fr"));
  }

  for (const id of produits) {
    const P = M.PRODUITS[id];
    let cat;
    try { cat = await M.catalogue(id, o); }
    catch (e) {
      if (brut) { sortie.push({ produit: id, erreur: String(e.message) }); continue; }
      console.log("\n══ " + P.nom + " ══");
      console.log("  ÉCHEC : " + e.message);
      continue;
    }
    const c = M.classe(cat.items, ref);
    const pourVol = vol ? M.cartesPourVol(cat.items, vol[0], vol[1]) : null;

    if (brut) {
      sortie.push({ produit: id, source: cat.source, repli: cat.repli || null,
        alertes: cat.alertes, trous: c.trous,
        courante: c.courante, futures: c.futures, perimees: c.perimees,
        pourVol });
      continue;
    }

    console.log("\n══ " + P.nom + " ══   source : " + cat.source
      + (cat.repli ? "   (repli — SOFIA : " + cat.repli + ")" : ""));
    (cat.alertes || []).forEach((a) => console.log("  ⚠ " + a));
    c.trous.forEach((t) => console.log("  ⚠ saut d’horaire : " + t.heures + " h entre "
      + hhmm(t.apres) + " et " + hhmm(t.avant) + " — rien publié entre les deux"));

    if (c.courante) {
      const k = c.courante;
      console.log("  EN VIGUEUR  " + hhmm(k.validAt) + " → "
        + (k.finNominale ? hhmm(k.finNominale) : "prochaine publication")
        + (k.niveau ? "   " + k.niveau : "") + "   (âge " + k.ageH + " h)");
      /* Un saut d'horaire — 15:00 puis 21:00 — laisse la carte de 15:00 comme
         référence. Elle le reste, mais le pilote doit savoir que rien d'autre
         n'a été publié : une carte de 5 h d'âge ne se lit pas comme une
         fraîche. Taire cela serait pire que de la retenir. */
      if (k.note) console.log("  ⚠ " + k.note);
    } else {
      /* § 15.7 : ne jamais deviner. On le dit. */
      console.log("  EN VIGUEUR  aucune carte de référence disponible à cette heure");
    }
    c.futures.forEach((f) => console.log("  à venir     " + hhmm(f.validAt)
      + (f.niveau ? "   " + f.niveau : "")));
    c.perimees.forEach((f) => console.log("  périmée     " + hhmm(f.validAt)));

    if (pourVol) {
      console.log("  pour le vol : " + (pourVol.length
        ? pourVol.map((x) => hhmm(x.validAt)).join("  ·  ")
        : "aucune carte ne couvre cette fenêtre"));
    }

    if (drapeau("pdf")) {
      const dossier = arg("dossier", "cartes");
      fs.mkdirSync(dossier, { recursive: true });
      const aPrendre = pourVol && pourVol.length ? pourVol : (c.courante ? [c.courante] : []);
      if (!aPrendre.length) console.log("  PDF : rien à télécharger");
      for (const it of aPrendre) {
        try {
          const d = await M.pdf(id, it.validAt, Object.assign({ catalogue: cat }, o));
          const nom = id + "-" + it.validAt.replace(/[:-]/g, "").replace(".000Z", "Z") + ".pdf";
          fs.writeFileSync(path.join(dossier, nom), Buffer.from(d.donnees));
          console.log("  PDF  " + hhmm(it.validAt) + "  " + d.octets + " o  "
            + d.contentType + "  → " + path.join(dossier, nom));
        } catch (e) {
          console.log("  PDF  " + hhmm(it.validAt) + "  ÉCHEC : " + e.message);
        }
      }
    }
  }

  if (brut) { console.log(JSON.stringify(sortie, null, 2)); return; }
  console.log("\nsources : SOFIA-Briefing (SIA/DGAC) puis AEROWEB (Météo-France)");
  console.log("relevé à " + hhmm(new Date().toISOString()));
})();
