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
  const uuid = crypto.randomUUID();

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
    notams: aplatis(pib.listnotams),
    trace: client.trace,          // aucun JSESSIONID à l'intérieur
  };
}

/* --------------------------------------------------------------- aplatissage
   La forme interne de listnotams AU-DELÀ de ADDep.code / ADDes.code n'est pas
   décrite par le document : il n'en cite que des textes de NOTAM. Ce parcours
   est donc VOLONTAIREMENT tolérant — il descend tout l'arbre et retient tout
   objet qui ressemble à un NOTAM — et le JSON brut est conservé à côté. */

const RE_ID = /^[A-Z]{1,2}\s?\d{3,4}\/\d{2}$/;

function aplatis(listnotams) {
  const sortie = [];
  const vu = new Set();
  (function marche(noeud, chemin) {
    if (!noeud || typeof noeud !== "object") return;
    if (Array.isArray(noeud)) { noeud.forEach((x) => marche(x, chemin)); return; }

    const id = premierChamp(noeud, ["id", "numero", "number", "notamId", "cle", "key"]);
    const texte = premierChamp(noeud, ["text", "texte", "message", "e", "itemE", "content"]);
    if ((id && RE_ID.test(String(id).trim())) || (texte && String(texte).length > 8 && id)) {
      const cle = chemin.join("/") + "|" + id;
      if (!vu.has(cle)) {
        vu.add(cle);
        sortie.push({
          terrain: chemin.find((c) => /^[A-Z]{4}$/.test(c)) || chemin[0] || "",
          categorie: chemin[chemin.length - 1] || "",
          id: String(id).trim(),
          texte: String(texte || "").trim(),
        });
      }
      return;
    }
    for (const [k, v] of Object.entries(noeud)) {
      if (typeof v !== "object" || v === null) continue;
      const suite = chemin.slice();
      if (v && typeof v === "object" && !Array.isArray(v) && typeof v.code === "string") suite.push(v.code);
      suite.push(k);
      marche(v, suite);
    }
  })(listnotams, []);
  return sortie;
}

function premierChamp(o, noms) {
  for (const n of noms) if (typeof o[n] === "string" && o[n]) return o[n];
  return null;
}

module.exports = { recuperePib, valideRoute, corpsBrut, isoUtcSecondes, aplatis, SOFIA_ORIGIN_DEFAUT };
