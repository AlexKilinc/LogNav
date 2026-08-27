/* meteo_client.js — TEMSI France, TEMSI EUROC et WINTEM France depuis SOFIA,
   avec repli sur AEROWEB. Sans dépendance : Node >= 18, Deno, Workers.

   LA SÉQUENCE, telle que la note technique du 26/08/2026 la décrit :

     1. GET /sofia/pages/meteosearchtemsi.html   -> Set-Cookie: JSESSIONID
        (ou meteosearchwintem.html pour le WINTEM)
     2. POST /sofia  :operation=postsaveinsessionprepa   -> vide ou OK
     3. POST /sofia  :operation=postTemsi | postWintem   -> le catalogue
     4. outer = JSON ; catalogue = JSON.parse(outer["status.message"])
     5. catalogue.zones[].temsi[] / .wintem[]
     6. le PDF vit chez Météo-France : https://aviation.meteo.fr + item.link

   CE QUE CE CLIENT AJOUTE À LA NOTE, et pourquoi :

   a) « expiration » N'EST PAS une fin de validité. Dans tous les relevés il
      vaut exactement « date ». Le client l'ignore pour classer — et SIGNALE
      s'il venait à différer : ce serait un changement de schéma, à savoir
      avant qu'il ne fasse des dégâts.

   b) LA FIN DE VALIDITÉ EST BORNÉE PAR LA CADENCE. La note calcule la fin
      d'une carte comme le début de la SUIVANTE DU CATALOGUE. Si une échéance
      manque au catalogue — publication en retard, trou — la carte de 15:00
      resterait « en vigueur » jusqu'à 21:00, soit six heures, le double de la
      cadence et le double de la limite pratique du guide Météo-France. On
      borne donc à la cadence, et le trou est signalé.

   c) LE PDF EST VÉRIFIÉ, pas supposé. HTTP 200 et Content-Type ne suffisent
      pas : on lit les cinq premiers octets et on exige « %PDF- ». Un portail
      qui répond une page d'erreur en 200 avec le bon type existe.

   d) LE « login » DU LIEN N'EST JAMAIS JOURNALISÉ ni conservé. Il peut être
      éphémère ; on rafraîchit le catalogue avant tout téléchargement différé.

   e) UN VOL COUVRE SOUVENT PLUSIEURS ÉCHÉANCES. cartesPourVol() rend toutes
      celles qui couvrent la fenêtre du vol, pas seulement celle du départ.
*/

const SOFIA_DEFAUT = "https://sofia-briefing.aviation-civile.gouv.fr";
const METEO_DEFAUT = "https://aviation.meteo.fr";
const CADENCE_MS = 3 * 3600 * 1000;   /* les trois produits : toutes les 3 h */
const DELAI_MS = 20000;

const CRYPTO = globalThis.crypto ||
  (typeof require === "function" ? require("node:crypto").webcrypto : null);

const PRODUITS = {
  "temsi-france": {
    type: "TEMSI", zone: "FRANCE", op: "postTemsi", liste: "temsi",
    page: "/sofia/pages/meteosearchtemsi.html",
    resultat: "/sofia/pages/meteotemsi.html",
    couche: "sigwx/fr/france",
    aeroweb: "VUE_CARTE=AERO_TEMSI",
    /* le guide Météo-France : mise à disposition ~2 h avant l'échéance */
    avanceH: 2, nom: "TEMSI France",
  },
  "temsi-euroc": {
    type: "TEMSI", zone: "EUROC", op: "postTemsi", liste: "temsi",
    page: "/sofia/pages/meteosearchtemsi.html",
    resultat: "/sofia/pages/meteotemsi.html",
    couche: "sigwx/fr/euroc",
    aeroweb: "VUE_CARTE=AERO_TEMSI&ZONE=AERO_EUROC",
    avanceH: 4, nom: "TEMSI EUROC",
  },
  "wintem-france": {
    type: "WINTEM", zone: "FRANCE", op: "postWintem", liste: "wintem",
    level: "100",
    page: "/sofia/pages/meteosearchwintem.html",
    resultat: "/sofia/pages/meteowintem.html",
    /* RÉSERVE IMPORTANTE, et elle contredit la note.
       La note annonce « postWintem + level=100 » et relève « level=FL20-100 ».
       Mais elle relève AUSSI, dans la même page, « layer=wintemp/fr/france/
       fl020 ». Autrement dit : SOFIA étiquette FL20-100 et sert la planche
       fl020, celle par défaut. Le relais « cartes » de LOGNAVAK l'avait déjà
       constaté en production — « level=NNN simple : PROUVÉ inopérant, l'image
       reste le fl020 par défaut » — et y a laissé une chasse aux formes qui
       n'a jamais trouvé la bonne. Ce POC ne prétend donc PAS obtenir un niveau
       choisi : il obtient la planche FL020, correctement identifiée comme
       telle. Demander FL050 ou FL100 reste un problème ouvert. */
    couche: "wintemp/fr/france/fl020",
    niveauReel: "FL020",
    reserve: "SOFIA étiquette FL20-100 mais sert la planche FL020 : "
      + "le niveau n'est pas sélectionnable par ce chemin",
    aeroweb: "VUE_CARTE=AERO_WINTEM&ALTITUDE=020",
    avanceH: null, nom: "WINTEM France",
  },
};

/* ------------------------------------------------------------------ outils */

/** Corps x-www-form-urlencoded BRUT : ordre garanti, « :operation » en tête. */
const corpsBrut = (paires) =>
  paires.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&");

/** « 26 08 2026 15:00 » -> « 2026-08-26T15:00:00Z ». Les heures SOFIA sont UTC. */
function dateSofia(v) {
  const m = /^(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{2}):(\d{2})$/.exec(String(v || "").trim());
  if (!m) return null;
  return m[3] + "-" + m[2] + "-" + m[1] + "T" + m[4] + ":" + m[5] + ":00Z";
}
/** « …echeance=20260826150000 » -> ISO, quand SOFIA n'a pas donné de date. */
function dateLien(u) {
  const m = /(?:echeance|date)=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(u || ""));
  return m ? m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":00Z" : null;
}
/** Toutes les heures du client sortent sous LA MÊME forme : ISO UTC à la
    seconde, sans millisecondes — comme les validAt de SOFIA. Deux formes de
    date dans un même objet finissent toujours par se comparer mal. */
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** le « login » du lien ne doit jamais paraître dans un journal */
const masque = (u) => String(u).replace(/(login=)[^&]*/i, "$1……");

function cookiesDe(r) {
  const lignes = typeof r.headers.getSetCookie === "function"
    ? r.headers.getSetCookie()
    : [r.headers.get("set-cookie") || ""].filter(Boolean);
  const out = [];
  for (const l of lignes) {
    const re = /(?:^|,\s*)([A-Za-z0-9_.\-]+)=([^;,\s]+)/g;
    let m;
    while ((m = re.exec(l))) {
      if (/^(path|domain|expires|max-age|samesite|secure|httponly|version)$/i.test(m[1])) continue;
      out.push([m[1], m[2]]);
    }
  }
  return out;
}

/* ---------------------------------------------------- client HTTP tracé */

class Client {
  constructor(o = {}) {
    this.sofia = (o.sofia || SOFIA_DEFAUT).replace(/\/+$/, "");
    this.meteo = (o.meteo || METEO_DEFAUT).replace(/\/+$/, "");
    this.delaiMs = o.delaiMs ?? DELAI_MS;
    this.pot = new Map();
    this.trace = [];
  }
  /* redirections suivies à la main : fetch n'expose que les en-têtes de la
     réponse FINALE, un JSESSIONID posé sur une 302 serait perdu */
  async appel(etape, url, init = {}) {
    let cible = url, rep = null;
    for (let saut = 0; saut < 6; saut++) {
      const t0 = Date.now();
      const h = Object.assign({}, init.headers);
      const c = [...this.pot].map(([k, v]) => k + "=" + v).join("; ");
      if (c) h["Cookie"] = c;
      let signal; try { signal = AbortSignal.timeout(this.delaiMs); } catch (_) {}
      try {
        rep = await fetch(cible, { method: init.method || "GET", headers: h,
          body: init.body, redirect: "manual", signal });
      } catch (e) {
        this.trace.push({ etape, url: masque(cible), code: 0, ms: Date.now() - t0,
          erreur: String((e && e.message) || e) });
        throw new Error(etape + " : " + ((e && e.message) || e));
      }
      const recus = cookiesDe(rep);
      for (const [k, v] of recus) this.pot.set(k, v);
      this.trace.push({ etape, url: masque(cible), code: rep.status,
        ms: Date.now() - t0, temoins: recus.map(([k]) => k) });
      if (rep.status >= 300 && rep.status < 400 && rep.headers.get("location")) {
        cible = new URL(rep.headers.get("location"), cible).toString();
        init = { method: "GET", headers: init.headers };
        continue;
      }
      break;
    }
    return rep;
  }
}

/* --------------------------------------------------- catalogue via SOFIA */

async function catalogueSofia(idProduit, o = {}) {
  const p = PRODUITS[idProduit];
  if (!p) throw new Error("produit inconnu : " + idProduit);
  const cl = new Client(o);
  const PAGE = cl.sofia + p.page;

  /* 1 — la session */
  const init = await cl.appel("session", PAGE, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  if (!init || !init.ok) throw new Error("SOFIA session HTTP " + (init ? init.status : "?"));
  await init.text();
  if (!cl.pot.has("JSESSIONID")) throw new Error("SOFIA : JSESSIONID absent");

  const commun = [
    ["zone", p.zone],
    ...(p.level ? [["level", p.level]] : []),
    ["operation", p.op],
    ["target", "#aside-target"],
    ["href", p.resultat],
    ["typeVol", ""],
    ["departure_date", ""],
    ["departure_time", ""],
    ["lang", "fr"],
    ["routeVal", "false"],
  ];
  const entetes = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: cl.sofia, Referer: PAGE, "X-Requested-With": "XMLHttpRequest",
  };

  /* 2 — la préparation. Sa réponse est vide ou « OK » : ce n'est PAS le
     catalogue, et la lire comme tel est le piège n°3 de la note. */
  if (!o.sansPreparation) {
    const prep = await cl.appel("preparation", cl.sofia + "/sofia", {
      method: "POST", headers: entetes,
      body: corpsBrut([[":operation", "postsaveinsessionprepa"], ...commun]),
    });
    if (!prep || !prep.ok) throw new Error("SOFIA preparation HTTP " + (prep ? prep.status : "?"));
    await prep.text();
  }

  /* 3 — le catalogue */
  const rep = await cl.appel("catalogue", cl.sofia + "/sofia", {
    method: "POST", headers: entetes,
    body: corpsBrut([[":operation", p.op], ...commun]),
  });
  if (!rep || !rep.ok) throw new Error("SOFIA catalogue HTTP " + (rep ? rep.status : "?"));
  const texte = await rep.text();
  cl.trace[cl.trace.length - 1].octets = texte.length;

  /* 4 — double décodage */
  let externe;
  try { externe = JSON.parse(texte); }
  catch (e) { throw new Error("SOFIA : réponse non JSON (" + texte.slice(0, 60) + ")"); }
  const msg = externe["status.message"];
  if (typeof msg !== "string" || !msg.trim()) {
    throw new Error("SOFIA : status.message absent ou vide — schéma changé ?");
  }
  let cat;
  try { cat = JSON.parse(msg); }
  catch (e) { throw new Error("SOFIA : status.message n'est pas du JSON"); }
  if (cat && cat.message === "No content") return { source: "SOFIA", items: [], trace: cl.trace };

  const zones = Array.isArray(cat && cat.zones) ? cat.zones : [];
  const z = zones.find((x) => x && x.id === p.zone) || zones[0] || {};
  const brut = Array.isArray(z[p.liste]) ? z[p.liste] : [];
  const alertes = [];
  const items = brut.map((it) => {
    if (!it) return null;
    const validAt = dateSofia(it.date) || dateLien(it.link);
    /* PIÈGE : expiration vaut date dans tous les relevés. On ne s'en sert pas.
       S'il venait à différer, c'est un changement de schéma : on le dit. */
    if (it.expiration && it.date && String(it.expiration).trim() !== String(it.date).trim()) {
      alertes.push("expiration diffère de date (" + it.expiration + " ≠ " + it.date
        + ") : le schéma SOFIA a peut-être changé, à vérifier");
    }
    return validAt && it.link ? {
      produit: idProduit, type: it.type || p.type, zone: it.zone || p.zone,
      niveau: it.level || null, validAt,
      deadline: it.deadline || null,
      expirationSource: it.expiration || null,   /* conservé, jamais utilisé pour classer */
      lien: String(it.link),
    } : null;
  }).filter(Boolean);
  items.sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt));
  return { source: "SOFIA", items, alertes, trace: cl.trace };
}

/* ------------------------------------------- catalogue via AEROWEB (repli)
   La voie officielle, sous convention Météo-France : l'identifiant vit en
   secret côté serveur, jamais dans le dépôt. Sans lui, ce repli ne peut pas
   jouer — et il le DIT, au lieu de rendre une liste vide. */

async function catalogueAeroweb(idProduit, o = {}) {
  const p = PRODUITS[idProduit];
  if (!p) throw new Error("produit inconnu : " + idProduit);
  const id = o.aerowebId || "";
  if (!id) throw new Error("AEROWEB : identifiant absent (secret AEROWEB_ID)");
  const cl = new Client(o);
  const u = cl.meteo + "/FR/aviation/serveur_donnees.jsp?ID=" + encodeURIComponent(id)
    + "&TYPE_DONNEES=CARTES&BASE_COMPLETE=non&" + p.aeroweb;
  const rep = await cl.appel("aeroweb", u, { headers: { Accept: "*/*" } });
  if (!rep || !rep.ok) throw new Error("AEROWEB HTTP " + (rep ? rep.status : "?"));
  const texte = await rep.text();
  /* les liens signés sont dans le XML, échappés de plusieurs façons */
  const net = texte.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const re = /(?:https?:\/\/[A-Za-z0-9_.:-]+)?[A-Za-z0-9_\/.-]*affiche_image\.php\?[^"'`\s<>()\\]+/g;
  const vus = new Set(), items = [];
  for (const brut of net.match(re) || []) {
    let q; try { q = new URL(brut, cl.meteo).searchParams; } catch (e) { continue; }
    const couche = (q.get("layer") || q.get("type") || "").toLowerCase();
    if (!memeCouche(p.couche, couche)) continue;
    const validAt = dateLien(brut);
    if (!validAt || vus.has(validAt)) continue;
    vus.add(validAt);
    items.push({ produit: idProduit, type: p.type, zone: p.zone, niveau: null,
      validAt, deadline: null, expirationSource: null,
      lien: brut.replace(/^https?:\/\/[^/]+/, "") });
  }
  items.sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt));
  return { source: "AEROWEB", items, alertes: [], trace: cl.trace };
}

/* Ne jamais servir une carte d'un autre type que celui demandé : on compare
   la famille (TEMSI / WINTEM), puis le niveau pour le WINTEM et la zone pour
   le TEMSI. « teuroc » compte comme « euroc ». */
function famille(s) {
  s = String(s || "").toLowerCase();
  if (/wintem/.test(s)) return "wintem";
  if (/sigwx|temsi/.test(s)) return "temsi";
  return s.split("/")[0];
}
function memeCouche(demande, lien) {
  if (famille(demande) !== famille(lien)) return false;
  if (famille(demande) === "wintem") {
    const a = (String(demande).match(/fl0*(\d{1,3})/i) || [])[1];
    const b = (String(lien).match(/fl0*(\d{1,3})/i) || [])[1];
    return a === b;
  }
  const zn = (s) => (/euroc/.test(String(s).toLowerCase()) ? "euroc"
    : (/france/.test(String(s).toLowerCase()) ? "france" : ""));
  return zn(demande) === zn(lien);
}

/* ----------------------------------------- catalogue : SOFIA puis AEROWEB */

async function catalogue(idProduit, o = {}) {
  const essais = [];
  try {
    const r = await catalogueSofia(idProduit, o);
    /* un catalogue VIDE n'est pas une réponse : les trois produits sont
       publiés toutes les 3 h, il y a toujours quelque chose. On replie. */
    if (r.items.length) return Object.assign(r, { essais });
    essais.push({ voie: "SOFIA", motif: "catalogue vide" });
  } catch (e) {
    essais.push({ voie: "SOFIA", motif: String((e && e.message) || e).slice(0, 140) });
  }
  try {
    const r = await catalogueAeroweb(idProduit, o);
    if (r.items.length) return Object.assign(r, { essais, repli: essais[0] && essais[0].motif });
    essais.push({ voie: "AEROWEB", motif: "catalogue vide" });
  } catch (e) {
    essais.push({ voie: "AEROWEB", motif: String((e && e.message) || e).slice(0, 140) });
  }
  /* JAMAIS une liste vide qui passerait pour « aucune carte publiée » */
  const err = new Error("aucun catalogue obtenu · "
    + essais.map((x) => x.voie + " : " + x.motif).join(" · "));
  err.essais = essais;
  throw err;
}

/* ------------------------------------------------------- la classification

   CURRENT : la carte de référence à l'instant demandé.
   PUBLISHED_FUTURE : publiée d'avance, pas encore en vigueur.
   EXPIRED : dépassée par la suivante.

   La note calcule la fin d'une carte comme le début de la SUIVANTE DU
   CATALOGUE. Si une échéance manque, la carte précédente resterait « en
   vigueur » deux fois trop longtemps. On borne donc à la cadence, et le trou
   est signalé — un trou dans le catalogue est une information, pas un détail
   d'implémentation. */

function classe(items, reference, o = {}) {
  const cadence = o.cadenceMs || CADENCE_MS;
  const ref = (reference instanceof Date ? reference : new Date(reference)).getTime();
  if (!isFinite(ref)) throw new Error("heure de référence invalide");
  const tri = items.slice().sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt));
  let courante = null;
  const futures = [], perimees = [], trous = [];

  for (let i = 0; i < tri.length; i++) {
    const it = tri[i];
    const debut = Date.parse(it.validAt);
    const suivante = tri[i + 1] ? Date.parse(tri[i + 1].validAt) : null;
    /* la borne : la suivante, MAIS jamais au-delà d'une cadence */
    const finNominale = suivante == null ? debut + cadence : Math.min(suivante, debut + cadence);
    if (suivante != null && suivante - debut > cadence * 1.5) {
      trous.push({ apres: it.validAt, avant: tri[i + 1].validAt,
        note: "échéance manquante au catalogue entre ces deux cartes" });
    }
    const enrichie = Object.assign({}, it, { finNominale: isoSec(finNominale) });
    if (debut > ref) { futures.push(Object.assign(enrichie, { statut: "PUBLISHED_FUTURE" })); continue; }
    if (ref >= debut && ref < finNominale) courante = Object.assign(enrichie, { statut: "CURRENT" });
    else perimees.push(Object.assign(enrichie, { statut: "EXPIRED" }));
  }
  return { courante, futures, perimees, trous, reference: isoSec(ref) };
}

/* Un vol couvre souvent PLUSIEURS échéances : la note le dit au § 14, et pour
   un dossier de vol c'est le cas qui compte. On rend toutes les cartes dont la
   fenêtre de validité recoupe celle du vol, dans l'ordre. */
function cartesPourVol(items, depart, arrivee, o = {}) {
  const cadence = o.cadenceMs || CADENCE_MS;
  const d = (depart instanceof Date ? depart : new Date(depart)).getTime();
  const a = (arrivee instanceof Date ? arrivee : new Date(arrivee)).getTime();
  if (!isFinite(d) || !isFinite(a)) throw new Error("fenêtre de vol invalide");
  if (a < d) throw new Error("l’arrivée précède le départ");
  const tri = items.slice().sort((x, y) => Date.parse(x.validAt) - Date.parse(y.validAt));
  const out = [];
  for (let i = 0; i < tri.length; i++) {
    const debut = Date.parse(tri[i].validAt);
    const suiv = tri[i + 1] ? Date.parse(tri[i + 1].validAt) : null;
    const fin = suiv == null ? debut + cadence : Math.min(suiv, debut + cadence);
    if (fin > d && debut <= a) {
      out.push(Object.assign({}, tri[i], { finNominale: isoSec(fin) }));
    }
  }
  return out;
}

/* --------------------------------------------------- le PDF, VÉRIFIÉ

   Le lien porte un « login » qui peut être éphémère : on rafraîchit le
   catalogue avant tout téléchargement, plutôt que de garder une adresse.
   Et on ne se contente pas d'un 200 : on lit les octets. Un portail qui rend
   une page d'erreur en 200, avec le bon Content-Type, existe. */

async function pdf(idProduit, validAt, o = {}) {
  const cat = o.catalogue || await catalogue(idProduit, o);
  const it = cat.items.find((x) => x.validAt === validAt);
  if (!it) {
    throw new Error("échéance absente du catalogue : " + validAt
      + " (disponibles : " + cat.items.map((x) => x.validAt).join(", ") + ")");
  }
  const cl = new Client(o);
  const url = /^https?:/.test(it.lien) ? it.lien : cl.meteo + it.lien;
  const rep = await cl.appel("pdf", url, {
    headers: { Accept: "application/pdf,*/*" },
  });
  if (!rep || !rep.ok) throw new Error("Météo-France HTTP " + (rep ? rep.status : "?"));
  const ct = (rep.headers.get("content-type") || "").toLowerCase();
  const octets = new Uint8Array(await rep.arrayBuffer());
  /* la seule preuve qui vaille : les cinq premiers octets */
  const magie = String.fromCharCode.apply(null, Array.from(octets.slice(0, 5)));
  if (magie !== "%PDF-") {
    throw new Error("le document reçu n'est pas un PDF (début : « "
      + magie.replace(/[^\x20-\x7e]/g, ".") + " », type annoncé : " + (ct || "aucun") + ")");
  }
  if (octets.length < 1000) throw new Error("PDF suspicieusement petit : " + octets.length + " octets");
  return {
    produit: idProduit, validAt, niveau: it.niveau || null,
    source: cat.source, contentType: ct, octets: octets.length,
    /* le lien est rendu MASQUÉ : le login n'a rien à faire dans un journal */
    lienMasque: masque(url),
    donnees: octets,
    recupereA: isoSec(Date.now()),
    trace: cl.trace,
  };
}

module.exports = {
  PRODUITS, CADENCE_MS,
  catalogue, catalogueSofia, catalogueAeroweb,
  classe, cartesPourVol, pdf,
  dateSofia, dateLien, masque, memeCouche, corpsBrut, isoSec,
};
