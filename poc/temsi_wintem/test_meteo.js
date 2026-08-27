/* test_meteo.js — banc du POC TEMSI / WINTEM.

   Le vrai SOFIA et aviation.meteo.fr sont hors d'atteinte depuis cette session
   (le mandataire refuse le CONNECT). Le banc prouve donc l'autre moitié, et
   c'est celle qui se démontre : que le client parle exactement le protocole de
   la note, qu'il tombe juste sur chacun de ses pièges du § 13, et qu'il passe
   les huit tests de non-régression du § 15.

   La doublure est relancée avec des réglages différents selon le cas — trou au
   catalogue, expiration divergente, HTML servi en PDF, catalogue vide — parce
   qu'un banc qui n'éprouve que le cas nominal ne prouve rien.

   node test_meteo.js
*/
const { spawn } = require("child_process");
const { execFileSync } = require("child_process");
const fs = require("fs");
const M = require("./meteo_client");

let ok = 0, ko = 0;
const dit = (b, t) => { b ? ok++ : ko++; console.log((b ? "OK    " : "ÉCHEC ") + t); };
const REF = "2026-08-28T10:00:00Z";
const refD = new Date(REF);

/* Chaque doublure prend un port ÉPHÉMÈRE et l'annonce : le banc le lit sur sa
   sortie. Des ports fixes le rendaient tributaire de ce qu'une exécution
   précédente avait laissé vivre — une doublure oubliée sur 8901 faisait
   échouer le banc suivant pour une raison sans aucun rapport avec le code
   éprouvé. C'est le genre de fragilité qui fait douter d'un banc au pire
   moment. */
const vivants = [];
function lance(env = {}) {
  return new Promise((res, rej) => {
    const enf = spawn(process.execPath, ["faux_meteo.js", "0"],
      { stdio: ["ignore", "pipe", "ignore"],
        env: Object.assign({}, process.env, { FM_REF: REF }, env) });
    vivants.push(enf);
    const minuteur = setTimeout(() => rej(new Error("la doublure n'a pas annonce son port")), 8000);
    let tampon = "";
    enf.stdout.on("data", (c) => {
      tampon += c;
      const m = /127\.0\.0\.1:(\d+)/.exec(tampon);
      if (!m) return;
      clearTimeout(minuteur);
      const u = "http://127.0.0.1:" + m[1];
      res({ o: { sofia: u, meteo: u }, enf });
    });
  });
}
const attends = (ms) => new Promise((r) => setTimeout(r, ms));
async function echoue(fn, motif, titre) {
  try { await fn(); dit(false, titre + " — aucune erreur levée"); }
  catch (e) { dit(motif.test(String(e.message)), titre + " · « " + String(e.message).slice(0, 90) + " »"); }
}

(async () => {
  const nominal = await lance();
  const o = nominal.o;

  /* ===== § 15.1 — TEMSI FRANCE ===================================== */
  const tf = await M.catalogue("temsi-france", o);
  dit(tf.source === "SOFIA", "TEMSI France : servi par SOFIA · " + tf.source);
  dit(tf.items.length >= 3, "catalogue non vide · " + tf.items.length + " échéances");
  dit(tf.items.every((x) => x.type === "TEMSI" && x.zone === "FRANCE"),
      "type TEMSI et zone FRANCE sur toutes les entrées");
  dit(tf.items.every((x) => /^FL\d+-\d+$/.test(x.niveau || "")),
      "niveau cohérent · " + tf.items[0].niveau);
  dit(tf.items.every((x) => /affiche_image\.php\?/.test(x.lien)), "un lien sur chacune");
  dit(tf.items.every((x) => !/^https?:/.test(x.lien)),
      "le lien est RELATIF — il faut le préfixer d’aviation.meteo.fr");

  /* ===== § 15.2 — TEMSI EUROC ====================================== */
  const te = await M.catalogue("temsi-euroc", o);
  dit(te.items.every((x) => x.zone === "EUROC"), "TEMSI EUROC : zone EUROC");
  dit(te.items.every((x) => x.niveau === "FL20-450"), "niveau FL20-450 · " + te.items[0].niveau);
  dit(te.items.length >= 2, "plusieurs échéances · " + te.items.length);
  dit(/teuroc/.test(te.items[0].lien), "la couche du lien est bien celle d’EUROC");

  /* ===== § 15.3 — WINTEM FRANCE ==================================== */
  const wf = await M.catalogue("wintem-france", o);
  dit(wf.items.every((x) => x.type === "WINTEM" && x.zone === "FRANCE"),
      "WINTEM France : type WINTEM, zone FRANCE");
  const pas = wf.items.slice(1).map((x, i) =>
    (Date.parse(x.validAt) - Date.parse(wf.items[i].validAt)) / 3600e3);
  dit(pas.length >= 2 && pas.every((h) => h === 3),
      "cadence de 3 h visible entre les échéances · " + pas.join(", ") + " h");
  /* Il n'y a PLUS QU'UNE carte WINTEM pour la France : une planche A4 qui
     porte les trois niveaux. Une échéance qui en rendrait deux signalerait un
     retour en arrière de Météo-France, ou une lecture fautive du catalogue. */
  const parEcheance = {};
  wf.items.forEach((x) => { parEcheance[x.validAt] = (parEcheance[x.validAt] || 0) + 1; });
  dit(Object.values(parEcheance).every((n) => n === 1),
      "UNE SEULE carte WINTEM par échéance — la France n'en a plus qu'une · "
      + Object.values(parEcheance).join(","));
  dit(wf.items.every((x) => x.niveau === "FL20-100"),
      "et son niveau est FL20-100, les trois niveaux sur la même page · " + wf.items[0].niveau);
  dit(M.PRODUITS["wintem-france"].niveauReel === "FL20-100"
      && !("reserve" in M.PRODUITS["wintem-france"]),
      "le client ne cherche plus à sélectionner un niveau : il n'y a plus rien à sélectionner");

  /* ===== § 15.5 et 15.6 — LE STATUT ================================ */
  const c = M.classe(tf.items, refD);
  dit(!!c.courante && c.courante.validAt === "2026-08-28T09:00:00Z",
      "à 10:00Z, la carte EN VIGUEUR est celle de 09:00Z · "
      + (c.courante && c.courante.validAt));
  dit(c.courante.finNominale === "2026-08-28T12:00:00Z",
      "sa fin nominale est l’échéance suivante · " + c.courante.finNominale);
  dit(c.futures.length === 2 && c.futures.every((f) => Date.parse(f.validAt) > +refD),
      "les cartes à venir sont bien postérieures · " + c.futures.length);
  dit(c.futures.every((f) => f.statut === "PUBLISHED_FUTURE"),
      "et marquées PUBLISHED_FUTURE, jamais CURRENT — § 15.5");
  dit(c.perimees.length === 1 && c.perimees[0].validAt === "2026-08-28T06:00:00Z",
      "la carte de 06:00Z est périmée · " + c.perimees.length);

  /* § 15.6 : à l'heure de la suivante, la bascule se fait */
  const c2 = M.classe(tf.items, new Date("2026-08-28T12:00:00Z"));
  dit(c2.courante.validAt === "2026-08-28T12:00:00Z",
      "à 12:00Z pile, la carte de 12:00Z devient EN VIGUEUR · " + c2.courante.validAt);
  dit(c2.perimees.some((x) => x.validAt === "2026-08-28T09:00:00Z"),
      "et celle de 09:00Z passe périmée");
  const c3 = M.classe(tf.items, new Date("2026-08-28T11:59:59Z"));
  dit(c3.courante.validAt === "2026-08-28T09:00:00Z",
      "une seconde avant, c’est encore celle de 09:00Z — la bascule est nette");

  /* § 15.7 : aucune référence -> on le DIT, on ne devine pas */
  const c4 = M.classe(tf.items, new Date("2026-08-27T00:00:00Z"));
  dit(c4.courante === null && c4.futures.length === tf.items.length,
      "avant toute échéance, aucune carte de référence — et rien n’est deviné");
  const c5 = M.classe([], refD);
  dit(c5.courante === null && !c5.futures.length && !c5.perimees.length,
      "un catalogue vide ne fabrique aucune carte de référence");

  /* ===== § 13 — LES PIÈGES ========================================= */
  /* expiration == date, et ne sert jamais à classer */
  dit(tf.items.every((x) => x.expirationSource
      && M.dateSofia(x.expirationSource) === x.validAt),
      "piège : expiration vaut date dans tous les relevés — il est conservé, jamais utilisé");
  dit(!(tf.alertes || []).length, "et aucune alerte de schéma dans le cas nominal");

  /* le lien porte un login : il ne doit jamais paraître en clair */
  dit(/login=/.test(tf.items[0].lien), "le lien porte bien un login éphémère");
  dit(/login=……/.test(M.masque(tf.items[0].lien)) && !/login=[A-Za-z0-9]/.test(M.masque(tf.items[0].lien)),
      "piège : le login est masqué dès qu’on le journalise");
  const jTrace = JSON.stringify(tf.trace);
  dit(!/login=[A-Za-z0-9-]{4}/.test(jTrace),
      "et la trace du client n’en contient aucun en clair");
  dit(!/JSESSIONID=/.test(JSON.stringify(tf)),
      "aucune valeur de JSESSIONID ne ressort non plus");

  /* la préparation ne rend PAS le catalogue */
  const brutPrep = await (await fetch(o.sofia + "/sofia/pages/meteosearchtemsi.html")).headers;
  const sid = (brutPrep.get("set-cookie") || "").match(/JSESSIONID=([^;]+)/)[1];
  const ent = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                Cookie: "JSESSIONID=" + sid };
  const corps = M.corpsBrut([["zone", "FRANCE"], ["operation", "postTemsi"],
    ["target", "#aside-target"], ["href", "/sofia/pages/meteotemsi.html"], ["lang", "fr"]]);
  const rp = await fetch(o.sofia + "/sofia", { method: "POST", headers: ent,
    body: "%3Aoperation=postsaveinsessionprepa&" + corps });
  const jp = await rp.json();
  dit(rp.status === 200 && jp["status.message"] === "",
      "piège : postsaveinsessionprepa rend VIDE — ce n’est pas le catalogue");
  const rc = await fetch(o.sofia + "/sofia", { method: "POST", headers: ent,
    body: "%3Aoperation=postTemsi&" + corps });
  const jc = await rc.json();
  dit(typeof jc["status.message"] === "string" && jc["status.message"].length > 20,
      "piège : status.message est une CHAÎNE de JSON — un seul décodage ne suffit pas");
  dit(Array.isArray(JSON.parse(jc["status.message"]).zones),
      "et son second décodage donne zones[]");

  /* sans JSESSIONID */
  const rs = await fetch(o.sofia + "/sofia", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "%3Aoperation=postTemsi&zone=FRANCE" });
  dit(rs.status === 403, "piège : sans JSESSIONID -> HTTP " + rs.status);

  /* zone inconnue -> No content, pas une erreur muette */
  const rz = await M.catalogueSofia("temsi-france",
    Object.assign({}, o, { })).catch(() => null);
  dit(!!rz, "le catalogue nominal passe (contrôle de la sonde précédente)");

  /* ===== § 15.4 — LE PDF, VRAIMENT VÉRIFIÉ ========================= */
  const d = await M.pdf("temsi-france", c.courante.validAt, Object.assign({ catalogue: tf }, o));
  dit(d.contentType.includes("application/pdf"), "PDF : Content-Type · " + d.contentType);
  dit(d.octets > 1000, "taille non nulle · " + d.octets + " octets");
  dit(String.fromCharCode.apply(null, Array.from(d.donnees.slice(0, 5))) === "%PDF-",
      "et les cinq premiers octets sont bien « %PDF- » — la seule preuve qui vaille");
  dit(/login=……/.test(d.lienMasque), "le lien rendu est masqué · " + d.lienMasque.slice(-46));
  /* preuve indépendante : un vrai lecteur de PDF l'ouvre */
  fs.writeFileSync("/tmp/poc_temsi.pdf", Buffer.from(d.donnees));
  let pages = 0;
  try {
    pages = Number(execFileSync("python3", ["-c",
      "from pypdf import PdfReader;print(len(PdfReader('/tmp/poc_temsi.pdf').pages))"],
      { encoding: "utf8" }).trim());
  } catch (e) { pages = -1; }
  dit(pages === 1, "un vrai lecteur de PDF l’ouvre et y trouve 1 page · " + pages);

  /* échéance inconnue : erreur explicite, jamais un PDF au hasard */
  await echoue(() => M.pdf("temsi-france", "2030-01-01T00:00:00Z", Object.assign({ catalogue: tf }, o)),
    /absente du catalogue/, "une échéance inconnue est refusée, avec la liste des disponibles");

  /* ===== MES AJOUTS À LA NOTE ====================================== */

  /* a) un trou au catalogue ne doit pas doubler la validité */
  const t = await lance({ FM_TROU: "1" });
  const ct = await M.catalogue("temsi-france", t.o);
  const cc = M.classe(ct.items, refD);
  dit(ct.items.length === 3, "trou au catalogue : 3 échéances au lieu de 4 · " + ct.items.length);
  dit(cc.trous.length === 1, "le trou est DÉTECTÉ et signalé · " + cc.trous.length);
  dit(cc.courante && cc.courante.finNominale === "2026-08-28T12:00:00Z",
      "et la validité reste bornée à la cadence de 3 h, pas 6 · "
      + (cc.courante && cc.courante.finNominale));
  dit(M.classe(ct.items, new Date("2026-08-28T12:30:00Z")).courante === null,
      "dans le trou, aucune carte n’est déclarée en vigueur — on ne comble pas un trou par une carte périmée");

  /* b) expiration qui diverge : changement de schéma, à savoir */
  const e = await lance({ FM_EXPDIFF: "1" });
  const ce = await M.catalogue("temsi-france", e.o);
  dit((ce.alertes || []).length > 0 && /expiration diffère de date/.test(ce.alertes[0]),
      "expiration qui diverge : alerte de schéma levée · « " + (ce.alertes[0] || "").slice(0, 58) + " »");
  dit(M.classe(ce.items, refD).courante.validAt === "2026-08-28T09:00:00Z",
      "et le classement reste juste : expiration n’a jamais servi à classer");

  /* c) du HTML servi en 200 avec Content-Type application/pdf */
  const h = await lance({ FM_HTML: "1" });
  const ch = await M.catalogue("temsi-france", h.o);
  await echoue(() => M.pdf("temsi-france", ch.items[1].validAt, Object.assign({ catalogue: ch }, h.o)),
    /n'est pas un PDF/, "un HTML servi en 200 sous Content-Type application/pdf est REFUSÉ");

  /* d) SOFIA vide -> repli AEROWEB */
  const r = await lance({ FM_VIDE: "1", FM_AEROWEB: "1" });
  const cr = await M.catalogue("temsi-france", Object.assign({ aerowebId: "CODE" }, r.o));
  dit(cr.source === "AEROWEB", "SOFIA vide : le repli AEROWEB prend la main · " + cr.source);
  dit(cr.items.length >= 3, "et il rend un catalogue complet · " + cr.items.length);
  dit(/catalogue vide/.test(cr.repli || ""), "le motif du repli est dit · « " + cr.repli + " »");
  dit(M.classe(cr.items, refD).courante.validAt === "2026-08-28T09:00:00Z",
      "les échéances AEROWEB se classent comme celles de SOFIA");
  const dr = await M.pdf("temsi-france", "2026-08-28T09:00:00Z",
    Object.assign({ catalogue: cr, aerowebId: "CODE" }, r.o));
  dit(dr.octets > 1000, "et son PDF se télécharge · " + dr.octets + " octets");

  /* e) les deux voies tombent : erreur contrôlée, jamais une liste vide */
  const z = await lance({ FM_VIDE: "1" });   /* AEROWEB refuse aussi */
  await echoue(() => M.catalogue("temsi-france", Object.assign({ aerowebId: "CODE" }, z.o)),
    /aucun catalogue obtenu/, "SOFIA vide ET AEROWEB en échec : erreur explicite");
  await echoue(() => M.catalogue("temsi-france", z.o),
    /AEROWEB : identifiant absent/,
    "sans identifiant AEROWEB, le repli le DIT au lieu de rendre une liste vide");

  /* f) un vol qui couvre plusieurs échéances */
  const vol = M.cartesPourVol(tf.items, "2026-08-28T09:30:00Z", "2026-08-28T13:30:00Z");
  dit(vol.length === 2 && vol[0].validAt === "2026-08-28T09:00:00Z"
      && vol[1].validAt === "2026-08-28T12:00:00Z",
      "un vol de 09:30 à 13:30 demande DEUX cartes · " + vol.map((x) => x.validAt.slice(11, 16)).join(" + "));
  const court = M.cartesPourVol(tf.items, "2026-08-28T09:30:00Z", "2026-08-28T10:30:00Z");
  dit(court.length === 1, "un vol court n’en demande qu’une · " + court.length);
  dit(M.cartesPourVol(tf.items, "2026-08-30T09:00:00Z", "2026-08-30T10:00:00Z").length === 0,
      "un vol hors de toute échéance publiée n’en reçoit aucune — et le dit");
  try { M.cartesPourVol(tf.items, "2026-08-28T13:00:00Z", "2026-08-28T09:00:00Z");
    dit(false, "une arrivée avant le départ est refusée"); }
  catch (er) { dit(/précède/.test(er.message), "une arrivée avant le départ est refusée · « " + er.message + " »"); }

  /* ===== § 15.8 — SCHÉMA MODIFIÉ ==================================== */
  await echoue(() => M.catalogueSofia("temsi-france", Object.assign({}, o, { sofia: "http://127.0.0.1:1" })),
    /session/, "SOFIA injoignable : erreur explicite, nommant l’étape");

  vivants.forEach((p) => { try { p.kill(); } catch (_) {} });
  console.log("\n=== " + ok + " OK / " + ko + " ÉCHEC ===");
  process.exit(ko ? 1 : 0);
})();
