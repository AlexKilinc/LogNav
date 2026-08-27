/* sofia_client.js — adaptateur SOFIA-Briefing, sans dépendance.
   Reproduit la séquence décrite dans « Procédure d'accès NOTAM SOFIA
   LOGNAVAK v2 » :

     1. GET  /sofia/pages/notamform.html   -> Set-Cookie: JSESSIONID
     2. uuid = crypto.randomUUID()         (identifiant applicatif, PAS la session)
     3. POST /sofia   :operation=postsaveinsessionprepa
     4. POST /sofia   :operation=postNarrowRoutePibRequest
     5. outer = JSON ; pib = JSON.parse(outer["status.message"])   (double décodage)
     6. pib.listnotams

   Fonctionne tel quel sur Node >= 18, Deno (Supabase Edge Function) et
   Cloudflare Workers : uniquement fetch, URL, crypto.randomUUID.

   ÉCARTS ASSUMÉS PAR RAPPORT AU WORKER v1 DU DOCUMENT — chacun est justifié
   dans README.md, section « Corrections apportées au Worker v1 » :
     a) corps construit en chaîne BRUTE, « :operation » en tête, comme le
        test PowerShell validé (URLSearchParams.set() le place en queue) ;
     b) redirections suivies à la main, en accumulant les cookies de CHAQUE
        saut (fetch n'expose que les en-têtes de la réponse finale : un
        Set-Cookie posé sur une 302 serait perdu) ;
     c) délai de garde (AbortSignal.timeout) sur les trois appels ;
     d) trace pas-à-pas — code HTTP, durée, taille — SANS jamais y écrire
        le JSESSIONID ;
     e) le JSESSIONID n'est jamais retourné ni journalisé.
*/

const SOFIA_ORIGIN_DEFAUT = "https://sofia-briefing.aviation-civile.gouv.fr";

/* Sur Node 18, le « crypto » global n'existe qu'avec un drapeau ; sur Deno et
   sur Cloudflare Workers il est toujours là et le require n'est jamais évalué. */
const CRYPTO = globalThis.crypto ||
  (typeof require === "function" ? require("node:crypto").webcrypto : null);

/* ------------------------------------------------------------------ outils */

const deuxChiffres = (n) => String(n).padStart(2, "0");

/** Corps x-www-form-urlencoded BRUT : ordre garanti, clés répétables. */
function corpsBrut(paires) {
  return paires
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)))
    .join("&");
}

/** valid_from doit être UTC et porter un Z, sans millisecondes. */
function isoUtcSecondes(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function valideRoute(valeur) {
  if (!Array.isArray(valeur) || valeur.length < 2 || valeur.length > 20) {
    throw new Error("route : il faut de 2 à 20 points");
  }
  return valeur.map((p) => {
    const s = String(p).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,11}$/.test(s)) throw new Error("point de route invalide : " + s);
    return s;
  });
}

/* Extrait toutes les paires cookie d'une réponse, y compris quand plusieurs
   Set-Cookie sont repliés en un seul en-tête séparé par des virgules. */
function cookiesDe(reponse) {
  let lignes = [];
  if (typeof reponse.headers.getSetCookie === "function") {
    lignes = reponse.headers.getSetCookie();
  }
  if (!lignes.length) {
    const brut = reponse.headers.get("set-cookie") || "";
    if (brut) lignes = [brut];
  }
  const trouvees = [];
  for (const ligne of lignes) {
    const re = /(?:^|[,]\s*)([A-Za-z0-9_.\-]+)=([^;,\s]+)/g;
    let m;
    while ((m = re.exec(ligne))) {
      const nom = m[1];
      /* on écarte les attributs de cookie qui ressemblent à des paires */
      if (/^(path|domain|expires|max-age|samesite|secure|httponly|version)$/i.test(nom)) continue;
      trouvees.push([nom, m[2]]);
    }
  }
  return trouvees;
}

/* ------------------------------------------------- client HTTP tracé */

class Client {
  constructor(opts = {}) {
    this.origin = (opts.origin || SOFIA_ORIGIN_DEFAUT).replace(/\/+$/, "");
    this.delaiMs = opts.delaiMs ?? 20000;
    this.maxSauts = opts.maxSauts ?? 5;
    this.pot = new Map();          // bocal à cookies
    this.trace = [];               // journal, sans secret
  }

  entete() {
    return [...this.pot].map(([k, v]) => k + "=" + v).join("; ");
  }

  /** fetch avec redirections manuelles, cookies accumulés à chaque saut. */
  async appel(etape, url, init = {}) {
    let cible = url;
    let reponse = null;
    for (let saut = 0; saut <= this.maxSauts; saut++) {
      const t0 = Date.now();
      const entetes = Object.assign({}, init.headers);
      const cookie = this.entete();
      if (cookie) entetes["Cookie"] = cookie;
      let signal;
      try { signal = AbortSignal.timeout(this.delaiMs); } catch (_) { signal = undefined; }

      try {
        reponse = await fetch(cible, {
          method: init.method || "GET",
          headers: entetes,
          body: init.body,
          redirect: "manual",
          signal,
        });
      } catch (e) {
        this.trace.push({
          etape, methode: init.method || "GET", url: cible,
          code: 0, ms: Date.now() - t0, erreur: String(e && e.message || e),
        });
        throw new Error("SOFIA " + etape + " : " + (e && e.message || e));
      }

      /* on récolte les cookies de CE saut avant de suivre la redirection */
      const recus = cookiesDe(reponse);
      for (const [k, v] of recus) this.pot.set(k, v);

      this.trace.push({
        etape, methode: init.method || "GET", url: cible,
        code: reponse.status, ms: Date.now() - t0,
        cookiesRecus: recus.map(([k]) => k),      // noms seulement, jamais les valeurs
        redirige: reponse.status >= 300 && reponse.status < 400,
      });

      if (reponse.status >= 300 && reponse.status < 400) {
        const loc = reponse.headers.get("location");
        if (!loc) break;
        cible = new URL(loc, cible).toString();
        init = { method: "GET", headers: init.headers };   // une redirection repasse en GET
        continue;
      }
      break;
    }
    return reponse;
  }
}

/* --------------------------------------------------------- séquence SOFIA */

/**
 * @param {object} p
 * @param {string[]} p.route          ex. ["LFPN","LFPZ"]
 * @param {string}  [p.validFrom]     ISO UTC avec Z ; défaut : maintenant
 * @param {string}  [p.duration]      HHMM (« 1200 » = 12 h), PAS des minutes
 * @param {string}  [p.traffic]       « VI » (VFR/IFR)
 * @param {number}  [p.flLower]       0
 * @param {number}  [p.flUpper]       999
 * @param {number}  [p.widthNM]       15  (demi-largeur du couloir)
 * @param {number}  [p.radiusADNM]    30  (rayon autour des terrains)
 * @param {string}  [p.lang]          « fr » | « en »
 * @param {string}  [p.origin]        pour pointer sur un banc local
 * @param {number}  [p.delaiMs]
 * @param {boolean} [p.sansPreparation]  saute l'étape 3 (test du § 11.9)
 */
async function recuperePib(p = {}) {
  const route = valideRoute(p.route);
  const validFrom = p.validFrom || isoUtcSecondes(new Date());
  const dt = new Date(validFrom);
  if (Number.isNaN(dt.getTime())) throw new Error("validFrom invalide");
  if (!/Z$/.test(validFrom)) throw new Error("validFrom doit être UTC et se terminer par Z");

  const client = new Client({ origin: p.origin, delaiMs: p.delaiMs });
  const PAGE = client.origin + "/sofia/pages/notamform.html";
  const API = client.origin + "/sofia";

  /* 1 — session HTTP -------------------------------------------------- */
  const init = await client.appel("session", PAGE, {
    method: "GET",
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  if (!init || !init.ok) throw new Error("SOFIA session HTTP " + (init ? init.status : "?"));
  await init.text();                       // on vide le corps
  if (!client.pot.has("JSESSIONID")) throw new Error("SOFIA : JSESSIONID absent");

  /* 2 — UUID applicatif ------------------------------------------------ */
  const uuid = CRYPTO.randomUUID();

  /* 3 — corps commun, dans l'ordre du test PowerShell validé ----------- */
  const departureDate = deuxChiffres(dt.getUTCDate()) + "-" +
                        deuxChiffres(dt.getUTCMonth() + 1) + "-" + dt.getUTCFullYear();
  const departureTime = deuxChiffres(dt.getUTCHours()) + deuxChiffres(dt.getUTCMinutes());

  const commun = [
    ["valid_from", validFrom],
    ["duration", String(p.duration ?? "1200")],
    ["traffic", String(p.traffic ?? "VI")],
    ["fl_lower", String(p.flLower ?? 0)],
    ["fl_upper", String(p.flUpper ?? 999)],
    ["width", String(p.widthNM ?? 15)],
    ["radiusAD", String(p.radiusADNM ?? 30)],
    /* route[] : une occurrence par point, dans l'ordre — le piège n°1 */
    ...route.map((pt) => ["route[]", pt]),
    ["uuid", uuid],
    ["isFromSofia", "true"],
    ["operation", "postNarrowRoutePibRequest"],
    ["target", "#aside-target"],
    ["href", "/sofia/pages/notamroute.html"],
    ["typeVol", "N"],
    ["departure_date", departureDate],
    ["departure_time", departureTime],
    ["lang", p.lang === "en" ? "en" : "fr"],
    ["routeVal", "false"],
  ];

  const entetes = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: client.origin,
    Referer: PAGE,
    "X-Requested-With": "XMLHttpRequest",
  };

  /* 4 — sauvegarde de la préparation ----------------------------------- */
  if (!p.sansPreparation) {
    const rep = await client.appel("preparation", API, {
      method: "POST",
      headers: entetes,
      body: corpsBrut([[":operation", "postsaveinsessionprepa"], ...commun]),
    });
    if (!rep || !rep.ok) throw new Error("SOFIA preparation HTTP " + (rep ? rep.status : "?"));
    await rep.text();
  }

  /* 5 — génération du PIB ---------------------------------------------- */
  const rep = await client.appel("pib", API, {
    method: "POST",
    headers: entetes,
    body: corpsBrut([[":operation", "postNarrowRoutePibRequest"], ...commun]),
  });
  if (!rep || !rep.ok) throw new Error("SOFIA pib HTTP " + (rep ? rep.status : "?"));
  const texte = await rep.text();
  client.trace[client.trace.length - 1].taille = texte.length;

  /* 6 — double décodage ------------------------------------------------- */
  let externe;
  try { externe = JSON.parse(texte); }
  catch (e) { throw new Error("SOFIA : réponse PIB non JSON (" + texte.slice(0, 80) + "…)"); }
  if (typeof externe["status.message"] !== "string") {
    throw new Error("SOFIA : status.message absent ou non textuel");
  }
  let pib;
  try { pib = JSON.parse(externe["status.message"]); }
  catch (e) { throw new Error("SOFIA : second décodage JSON impossible"); }
  if (!pib || !pib.listnotams) throw new Error("SOFIA : listnotams absent");

  /* 7 — cohérence : on ne fait pas confiance à l'en-tête si la structure
         contredit la route demandée ------------------------------------ */
  const dep = pib.listnotams?.ADDep?.code;
  const des = pib.listnotams?.ADDes?.code;
  if (dep && dep !== route[0]) throw new Error("SOFIA : départ incohérent (" + dep + " ≠ " + route[0] + ")");
  if (des && des !== route[route.length - 1]) {
    throw new Error("SOFIA : destination incohérente (" + des + " ≠ " + route[route.length - 1] + ")");
  }

  return {
    ok: true,
    source: "SOFIA-Briefing",
    retrievedAt: new Date().toISOString(),
    demande: { route, validFrom, duration: String(p.duration ?? "1200"), traffic: String(p.traffic ?? "VI") },
    pib,
    nbNotams: pib.nbNotams,                    // le compte annoncé par SOFIA
    notams: aplatis(pib.listnotams, { langue: p.lang === "en" ? "en" : "fr" }),
    trace: client.trace,          // aucun JSESSIONID à l'intérieur
  };
}

/* --------------------------------------------------------------- aplatissage

   CALÉ SUR LA STRUCTURE RÉELLE, relevée sur un PIB LFPN → LFPZ du 27/08/2026.
   Le document n'en citait que ADDep.code / ADDes.code ; voici ce qu'il y a
   vraiment :

     listnotams
       ADDep, ADDes   { code, name, + 12 tableaux de catégorie }
       ADDeg, ADSur   tableaux (dégagements, terrains survolés)
       FIR            { 8 tableaux de catégorie, noms différents }
       Other          tableau

   et un NOTAM porte :

     series/number/year  →  le VRAI numéro : « E 3970/26 »
     id                     identifiant interne (400000052237901), PAS le numéro
     type                   N nouveau · R remplace · C annule
     itemE                  le texte, en anglais
     multiLanguage.itemE    LE MÊME TEXTE EN FRANÇAIS, quand il existe
     qLine.traffic          « I », « V » ou « IV » — de quoi filtrer le VFR
     qLine.code23/code45    le code Q OACI
     startValidity/endValidity  + leurs variantes …Format, lisibles
     itemA, coordinates, radius

   Le JSON brut de chaque NOTAM reste attaché sous « brut ». */

function aplatis(listnotams, opts = {}) {
  const langue = opts.langue === "en" ? "en" : "fr";
  const sortie = [];
  const vu = new Set();
  /* les terrains que SOFIA a réellement examinés : sans cette liste,
     « aucun NOTAM ici » et « SOFIA n'a pas regardé ce terrain » s'affichent
     pareil — et le second est un mensonge */
  const couverts = new Set();

  const pousse = (n, groupe, categorie) => {
    if (!n || typeof n !== "object") return;
    const numero = (n.series && n.number)
      ? String(n.series) + " " + n.number + "/" + (n.year ?? "")
      : String(n.id ?? "");
    /* § 13 : dédupliquer par série/numéro/année */
    const cle = numero || JSON.stringify(n).slice(0, 60);
    if (vu.has(cle)) return;
    vu.add(cle);
    const ter = n.itemA || n.sectionCode || "";
    if (/^[A-Z]{4}$/.test(ter)) couverts.add(ter);

    const fr = n.multiLanguage && typeof n.multiLanguage.itemE === "string"
      ? n.multiLanguage.itemE.trim() : "";
    const en = typeof n.itemE === "string" ? n.itemE.trim() : "";

    sortie.push({
      groupe,                                   // ADDep · ADDes · FIR · …
      categorie,                                // aire_mouvement, obstacles, …
      terrain: n.itemA || n.sectionCode || groupe,
      numero,                                   // « E 3970/26 »
      type: n.type || "",                       // N · R · C
      texte: (langue === "fr" && fr) || en,     // français si disponible
      texteEn: en,
      traduit: !!fr,
      trafic: (n.qLine && n.qLine.traffic) || "",   // I · V · IV
      codeQ: n.qLine ? [n.qLine.code23, n.qLine.code45].filter(Boolean).join("") : "",
      debut: n.startValidityFormat || n.startValidity || "",
      fin: n.endValidityFormat || n.endValidity || "",
      id: String(n.id ?? ""),
      brut: n,
    });
  };

  /* PIÈGE : ADDeg et ADSur ne sont PAS des tableaux de NOTAM, ce sont des
     tableaux de TERRAINS, de la même forme qu'ADDep — code, name, puis les
     catégories. Les parcourir comme des NOTAM broyait tout leur contenu :
     les terrains survolés et les dégagements disparaissaient, et c'est
     exactement ce que SOFIA rendait de moins qu'autorouter.
     Le parcours ne se fie donc pas au NOM du groupe mais à la FORME : un
     objet est un NOTAM s'il porte itemE (ou text), ou series + number. Tout
     le reste est un conteneur dans lequel on descend. */
  const estNotam = (o) => typeof o.itemE === "string" || typeof o.text === "string"
    || (o.series != null && o.number != null);
  const marche = (n, groupe, categorie) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach((x) => marche(x, groupe, categorie)); return; }
    if (estNotam(n)) { pousse(n, groupe, categorie); return; }
    if (typeof n.code === "string" && /^[A-Z]{4}$/.test(n.code)) couverts.add(n.code);
    for (const [k, v] of Object.entries(n)) {
      if (v && typeof v === "object") marche(v, groupe, k);
    }
  };

  const connus = ["ADDep", "ADDeg", "ADSur", "ADDes", "FIR", "Other"];
  const l = listnotams || {};
  for (const k of connus) if (k in l) marche(l[k], k, "");
  /* tout groupe supplémentaire qu'une évolution de SOFIA ajouterait */
  for (const k of Object.keys(l)) if (!connus.includes(k)) marche(l[k], k, "");
  sortie.couverts = Array.from(couverts).sort();
  return sortie;
}

/* Ne garder que ce qui concerne un vol VFR : le champ traffic de la ligne Q
   porte « V » quand le NOTAM vise la circulation à vue. Les NOTAM sans ligne Q
   exploitable sont CONSERVÉS — mieux vaut un NOTAM de trop qu'un de moins. */
function filtreVfr(notams) {
  return notams.filter((n) => !n.trafic || /V/i.test(n.trafic));
}

module.exports.filtreVfr = filtreVfr;

module.exports = { recuperePib, valideRoute, corpsBrut, isoUtcSecondes, aplatis, filtreVfr, SOFIA_ORIGIN_DEFAUT };
