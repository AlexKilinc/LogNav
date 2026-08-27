/* faux_sofia.js — doublure fidèle de SOFIA-Briefing, pour prouver le client
   ICI, où l'accès sortant vers sofia-briefing.aviation-civile.gouv.fr est
   refusé par la politique réseau de cette session (le mandataire répond 403
   au CONNECT).

   La doublure n'est pas complaisante : elle applique littéralement tout ce que
   le document décrit, et RECRACHE une erreur sur chacun des pièges qu'il
   énumère au § 7 :

     · pas de JSESSIONID, ou un JSESSIONID inconnu / différent entre les deux
       POST                                             -> HTTP 403
     · route[] envoyé une seule fois (« LFPN,LFPZ »)     -> HTTP 500
       (c'est exactement l'échec Hashtable PowerShell)
     · valid_from sans Z, ou incohérent avec
       departure_date / departure_time                   -> HTTP 400
     · :operation inconnu                                -> HTTP 400
     · pas de Content-Type x-www-form-urlencoded          -> HTTP 415
     · postNarrowRoutePibRequest sans préparation
       préalable dans la session                         -> HTTP 409
       (le § 11.9 dit précisément : ne pas retirer la préparation de la v1
        avant preuve — la doublure prend l'hypothèse la plus stricte)

   Le PIB rendu reprend le résultat réel cité au § 6 : NW432608262157,
   LFPN -> LFPZ, avec les NOTAM de piste et de taxiway.
   Le corps est doublement encodé, comme le vrai : status.message est une
   CHAÎNE contenant un second JSON.
*/
const http = require("http");
const { randomUUID } = require("crypto");

const sessions = new Map();   // JSESSIONID -> { prepa: bool }

/* Structure calquée sur un PIB SOFIA réel (LFPN → LFPZ, 27/08/2026), champ
   pour champ : series/number/year, id interne distinct, itemE anglais,
   multiLanguage.itemE français, qLine, validités. Un NOTAM est volontairement
   laissé SANS traduction, pour éprouver le repli sur l'anglais. */
const notam = (o) => Object.assign({
  sectionCode: o.itemA, pibSection: "AD", nof: "LFFA", series: "E", year: 26,
  type: "N", qLine: { fir: "LFFF", code23: "MR", code45: "LC", traffic: "IV" },
  coordinates: "4845N00207E", radius: 5,
  startValidity: "2026-08-19T08:09:00Z", endValidity: "2026-08-28T20:00:00Z",
  startValidityFormat: "19 08 2026 08:09", endValidityFormat: "28 08 2026 20:00",
  marker: "+", valid: "",
}, o);

const PIB_REEL = {
  pibUid: "LFYN2608272364",
  authorityName: "FRANCE",
  organisationName: "SIA FRANCE",
  validFrom: "2026-08-26T14:13:56.000Z",
  validTo: "2026-08-27T02:13:00.000Z",
  traffic: "IV", duration: 1159, lowerFl: 0, upperFl: 999, radius: 30, routeWidth: 30,
  nbNotams: 9,
  listnotams: {
    ADDep: {
      code: "LFPN", name: "PARIS SACLAY VERSAILLES",
      aerodromes_services: [notam({ id: "400000052237901", number: 3970, itemA: "LFPN",
        qLine: { fir: "LFFF", code23: "FU", code45: "AU", traffic: "IV" },
        itemE: "'SMA UL AERO SUPER+' NOT AVBL",
        multiLanguage: { itemE: "SMA UL AERO SUPER+ INDISPONIBLE" } })],
      aire_mouvement: [notam({ id: "400000051804734", number: 3550, itemA: "LFPN",
        itemE: "RWY 07R/25L NIGHT VFR PROHIBITED.",
        multiLanguage: { itemE: "PISTE 07R/25L VFR DE NUIT INTERDIT." } })],
      aire_trafic: [], balisage: [], procedures: [], obstacles: [], autres_info: [],
    },
    /* ADDeg et ADSur sont des TABLEAUX DE TERRAINS, de la même forme que
       ADDep : code, name, puis les catégories. Les prendre pour des tableaux
       de NOTAM broie tout leur contenu — et c'est précisément ce qui manquait
       par rapport à autorouter : les terrains survolés et les dégagements. */
    ADSur: [{
      code: "LFOZ", name: "ORLEANS SAINT DENIS DE L'HOTEL",
      aire_mouvement: [notam({ id: "400000051900001", number: 3120, itemA: "LFOZ",
        itemE: "TWY A CLOSED.", multiLanguage: { itemE: "TAXIWAY A FERME." } })],
      obstacles: [],
    }],
    ADDeg: [{
      code: "LFPT", name: "PONTOISE CORMEILLES",
      aerodromes_services: [notam({ id: "400000051900002", number: 3121, itemA: "LFPT",
        itemE: "AD CLOSED OUTSIDE ATS HOURS.",
        multiLanguage: { itemE: "AD FERME HORS HORAIRES ATS." } })],
      aire_mouvement: [],
    }],
    ADDes: {
      code: "LFPZ", name: "SAINT CYR L'ECOLE",
      aire_mouvement: [
        notam({ id: "400000051012141", number: 2455, itemA: "LFPZ",
          itemE: "RWY 11L/29R CLOSED.", multiLanguage: { itemE: "PISTE 11L/29R FERMEE." } }),
        notam({ id: "400000051012048", number: 2454, itemA: "LFPZ",
          itemE: "FATO CLOSED.", multiLanguage: { itemE: "FATO FERMEE." } }),
        notam({ id: "400000051012153", number: 2456, itemA: "LFPZ",
          itemE: "TAXIWAY B CLOSED.", multiLanguage: { itemE: "TAXIWAY B FERME." } }),
        /* celui-ci n'a PAS de traduction : repli sur l'anglais attendu */
        notam({ id: "400000051012181", number: 2457, itemA: "LFPZ",
          itemE: "TAXIWAY C CLOSED." }),
      ],
      obstacles: [], autres_info: [],
    },
    FIR: {
      /* un NOTAM en-route, trafic IFR seulement : doit tomber au filtre VFR */
      installations_com_surveillance: [notam({ id: "400000047879352", number: 1210, itemA: "LFFF",
        sectionCode: "LFFF",
        qLine: { fir: "LFFF", code23: "CS", code45: "AU", traffic: "I" },
        itemE: "EUROCONTROL LOGON LIST FUNCTIONALITY SET UP FOR THE EN-ROUTE CENTRES." })],
      avertissements_navigation: [], obstacles: [], autres_info: [],
    },
    Other: [],
  },
};

/* Décodage d'un corps x-www-form-urlencoded en gardant les répétitions. */
function paires(corps) {
  return corps.split("&").filter(Boolean).map((m) => {
    const i = m.indexOf("=");
    const k = decodeURIComponent((i < 0 ? m : m.slice(0, i)).replace(/\+/g, " "));
    const v = decodeURIComponent((i < 0 ? "" : m.slice(i + 1)).replace(/\+/g, " "));
    return [k, v];
  });
}
const toutes = (ps, k) => ps.filter((x) => x[0] === k).map((x) => x[1]);
const une = (ps, k) => { const t = toutes(ps, k); return t.length ? t[0] : undefined; };

function repond(res, code, corps, entetes = {}) {
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=UTF-8" }, entetes));
  res.end(typeof corps === "string" ? corps : JSON.stringify(corps));
}

function pibPour(route) {
  /* Route autre que LFPN->LFPZ : on fabrique un PIB cohérent mais vide, ce qui
     permet de tester le contrôle de cohérence ADDep/ADDes du client. */
  if (route[0] === "LFPN" && route[route.length - 1] === "LFPZ") return PIB_REEL;
  return {
    pibUid: "NW" + Math.abs(hash(route.join(""))).toString().padStart(12, "0").slice(0, 12),
    validFrom: PIB_REEL.validFrom,
    validTo: PIB_REEL.validTo,
    nbNotams: 0,
    listnotams: {
      ADDep: { code: route[0], name: "TERRAIN " + route[0], aire_mouvement: [] },
      ADDeg: [], ADSur: [],
      ADDes: { code: route[route.length - 1], name: "TERRAIN " + route[route.length - 1], aire_mouvement: [] },
      FIR: { autres_info: [] }, Other: [],
    },
  };
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

const serveur = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  /* ---- 1. page d'initialisation : pose le JSESSIONID -------------- */
  if (req.method === "GET" && url.pathname === "/sofia/pages/notamform.html") {
    const sid = randomUUID().replace(/-/g, "").toUpperCase();
    sessions.set(sid, { prepa: false });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=UTF-8",
      "Set-Cookie": "JSESSIONID=" + sid + ";Path=/;HttpOnly",
    });
    /* NODE_SOFIA est bien une chaîne vide, comme observé au DevTools */
    res.end('<!doctype html><html><head><script>var NODE_SOFIA="";</script></head><body>form</body></html>');
    return;
  }

  /* ---- 2. endpoint applicatif ------------------------------------- */
  if (req.method === "POST" && url.pathname === "/sofia") {
    let brut = "";
    req.on("data", (c) => (brut += c));
    req.on("end", () => {
      const ct = req.headers["content-type"] || "";
      if (!/application\/x-www-form-urlencoded/i.test(ct)) {
        return repond(res, 415, { error: "Unsupported Media Type" });
      }

      const cookie = req.headers["cookie"] || "";
      const m = cookie.match(/JSESSIONID=([^;\s]+)/);
      if (!m || !sessions.has(m[1])) {
        return repond(res, 403, { error: "Session invalide" });
      }
      const session = sessions.get(m[1]);

      const ps = paires(brut);
      const op = une(ps, ":operation");

      /* piège n°1 : route[] doit apparaître UNE FOIS PAR POINT */
      const route = toutes(ps, "route[]");
      if (route.length < 2) {
        return repond(res, 500, { error: "route[] : occurrences insuffisantes (" + route.length + ")" });
      }
      if (route.some((r) => /[,;]/.test(r))) {
        return repond(res, 500, { error: "route[] : valeur agrégée refusée" });
      }

      /* piège n°2 : valid_from UTC avec Z, cohérent avec departure_* */
      const vf = une(ps, "valid_from") || "";
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(vf)) {
        return repond(res, 400, { error: "valid_from doit être UTC et porter un Z" });
      }
      const d = new Date(vf);
      const dd = String(d.getUTCDate()).padStart(2, "0") + "-" +
                 String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + d.getUTCFullYear();
      const hh = String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0");
      if (une(ps, "departure_date") !== dd || une(ps, "departure_time") !== hh) {
        return repond(res, 400, { error: "departure_date/time incohérents avec valid_from" });
      }

      /* piège n°3 : duration au format HHMM, pas des minutes */
      const dur = une(ps, "duration") || "";
      if (!/^\d{3,4}$/.test(dur) || Number(dur.slice(-2)) > 59) {
        return repond(res, 400, { error: "duration attendue au format HHMM" });
      }

      /* un uuid applicatif est attendu, distinct du JSESSIONID */
      const uuid = une(ps, "uuid") || "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
        return repond(res, 400, { error: "uuid applicatif absent ou mal formé" });
      }
      if (uuid.replace(/-/g, "").toUpperCase() === m[1]) {
        return repond(res, 400, { error: "uuid ne doit pas être le JSESSIONID" });
      }

      if (op === "postsaveinsessionprepa") {
        session.prepa = true;
        return repond(res, 200, { "status.code": "200", "status.message": "OK" });
      }

      if (op === "postNarrowRoutePibRequest") {
        if (!session.prepa) {
          return repond(res, 409, { error: "préparation absente dans la session" });
        }
        const pib = pibPour(route);
        /* DOUBLE ENCODAGE : status.message est une CHAÎNE de JSON */
        return repond(res, 200, {
          "status.code": "200",
          "status.message": JSON.stringify(pib),
        });
      }

      return repond(res, 400, { error: "opération inconnue : " + op });
    });
    return;
  }

  repond(res, 404, { error: "Not found" });
});

function demarre(port = 0) {
  return new Promise((r) => serveur.listen(port, "127.0.0.1", () => r(serveur.address().port)));
}
function arrete() { return new Promise((r) => serveur.close(r)); }

module.exports = { demarre, arrete, PIB_REEL, serveur };

if (require.main === module) {
  demarre(Number(process.argv[2]) || 8899).then((p) =>
    console.log("doublure SOFIA sur http://127.0.0.1:" + p));
}
