/* ═══════════════════════════════════════════════════════════════════════════
   GREFFE POUR LA FONCTION « cartes » — version 7.41 → 7.42
   NOTAM via SOFIA-Briefing.

   TROIS MODIFICATIONS, rien d'autre :

   1) En haut du fichier :
        const VERSION = "7.41";      ->      const VERSION = "7.42";

   2) Coller TOUT le bloc ci-dessous (à partir de « ══ NOTAM via SOFIA ══ »)
      quelque part au premier niveau — par exemple juste AVANT le commentaire
      « /* SIGMET : relais vers l'Aviation Weather Center ».

   3) Dans Deno.serve, juste après la ligne :
        if (q.get("notam") === "1") return notam(q);
      ajouter :
        if (q.get("sofia") === "1") return notamSofia(q);

   Aucun secret à ajouter : ce flux SOFIA ne demande pas d'authentification.

   Vérification après déploiement :
     ?version=1                              -> 7.42
     ?sofia=1&route=LFPN,LFPZ                -> { ok:true, notams:[…] }
     ?sofia=1&route=LFPN,LFPZ&essai=1        -> le détail des trois étapes
   ═══════════════════════════════════════════════════════════════════════════ */


/* ================== NOTAM via SOFIA-Briefing ==============================
   L'autre source de NOTAM, à côté d'autorouter. Elle a deux avantages : elle
   rend un PIB « route étroite » — un couloir autour de la trace, et non une
   liste de terrains — et surtout elle livre la TRADUCTION FRANÇAISE de chaque
   item E, dans multiLanguage.itemE. Lire « PISTE 11L/29R FERMEE » plutôt que
   « RWY 11L/29R CLOSED » n'est pas un confort : c'est une sécurité.

   La séquence, relevée puis vérifiée en vivo le 27/08/2026 (LFPN → LFPZ,
   trois étapes en 200, 84 NOTAM) :

     1. GET /sofia/pages/notamform.html   -> Set-Cookie: JSESSIONID
     2. uuid = crypto.randomUUID()        (identifiant applicatif, PAS la session)
     3. POST /sofia  :operation=postsaveinsessionprepa
     4. POST /sofia  :operation=postNarrowRoutePibRequest
     5. outer = JSON ; pib = JSON.parse(outer["status.message"])
     6. pib.listnotams

   Quatre pièges, tous rencontrés, tous désamorcés ici :
     · route[] doit apparaître UNE FOIS PAR POINT. Un « LFPN,LFPZ » agrégé
       fait répondre 500. D'où le corps construit en chaîne BRUTE.
     · le JSESSIONID doit être le MÊME sur les deux POST. L'uuid ne le
       remplace pas : ce sont deux identifiants distincts.
     · status.message est une CHAÎNE contenant un second JSON : deux décodages.
     · duration est au format HHMM — 1200 = 12 h, pas 1200 minutes.

   Et un piège de plate-forme : fetch n'expose que les en-têtes de la réponse
   FINALE. Un JSESSIONID posé sur une 302 serait perdu si l'on laissait suivre
   les redirections. On les suit donc à la main, en récoltant à chaque saut.

   Les NOTAM sont rendus DÉJÀ CONVERTIS dans la forme interne de l'application
   (ad, serie, qcode, fir, trafic, objet, portee, bas, haut, lat, lon, rayon,
   debut, fin, estimee, horaire, texte). L'application n'a ainsi aucune
   connaissance de SOFIA : tout l'adaptateur tient ici.

   ?sofia=1&route=LFPN,LFPZ[&lang=fr][&essai=1]
     -> { ok, source, pibUid, validFrom, validTo, nbSofia, traduits, notams }
   Mémo 10 minutes, partagé entre les instances comme celui d'autorouter. */

const SOFIA_FORM = SOFIA + "/sofia/pages/notamform.html";
const SOFIA_NOTAM_DUREE = 600000;      /* 10 min : la fraîcheur attendue */
const memoSofiaN = new Map<string, { t: number; corps: string }>();

/* « 4845N00207E » -> degrés décimaux. Le rayon voyage à part, dans radius. */
function sofiaCoord(v: unknown): { lat: number | null; lon: number | null } {
  const m = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])/.exec(String(v ?? ""));
  if (!m) return { lat: null, lon: null };
  return {
    lat: (+m[1] + +m[2] / 60) * (m[3] === "S" ? -1 : 1),
    lon: (+m[4] + +m[5] / 60) * (m[6] === "W" ? -1 : 1),
  };
}
function sofiaNombre(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function sofiaEpoque(v: unknown): number {
  if (!v) return 0;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : Math.round(t / 1000);
}
/* Les noms de purpose / scope / lower / upper dans qLine ne sont pas tous
   confirmés sur relevé : on essaie les variantes plausibles. Si aucune ne
   répond, l'application se passe simplement de la ligne Q — elle refuse déjà
   d'en afficher une incomplète, qui ressemblerait à l'officielle sans l'être. */
function sofiaChamp(o: Record<string, unknown>, noms: string[]): unknown {
  for (const n of noms) if (o && o[n] != null && o[n] !== "") return o[n];
  return null;
}

function sofiaVersApp(n: Record<string, any>, groupe: string, categorie: string) {
  const q = (n.qLine || {}) as Record<string, unknown>;
  const c = sofiaCoord(n.coordinates);
  const fr = typeof n.multiLanguage?.itemE === "string" ? n.multiLanguage.itemE.trim() : "";
  const en = typeof n.itemE === "string" ? n.itemE.trim() : "";
  return {
    ad: String(n.itemA || n.sectionCode || (groupe === "FIR" ? (q.fir || "FIR") : "")),
    /* le VRAI numéro, forme OACI : E3550/26. « id » est un identifiant interne
       SOFIA (400000051804734) — ce n'est PAS le numéro du NOTAM. */
    serie: (n.series && n.number != null)
      ? String(n.series) + String(n.number) + "/" + String(n.year ?? "").slice(-2)
      : String(n.id ?? ""),
    qcode: [q.code23, q.code45].filter(Boolean).join(""),
    fir: String(q.fir || ""),
    trafic: String(q.traffic || ""),
    objet: String(sofiaChamp(q, ["purpose", "pu", "purposes", "objet"]) ?? ""),
    portee: String(sofiaChamp(q, ["scope", "sc", "portee"]) ?? ""),
    bas: sofiaNombre(sofiaChamp(q, ["lower", "lowerLimit", "lower_fl", "bas"])),
    haut: sofiaNombre(sofiaChamp(q, ["upper", "upperLimit", "upper_fl", "haut"])),
    lat: c.lat, lon: c.lon, rayon: sofiaNombre(n.radius),
    debut: sofiaEpoque(n.startValidity),
    fin: sofiaEpoque(n.endValidity),
    estimee: /\bEST\b/i.test(String(n.endValidityFormat || "")) || n.estimated === true,
    horaire: String(n.itemD || ""),
    /* LES DEUX LANGUES voyagent côte à côte : l'application bascule FR/EN sans
       rien redemander. Tous les NOTAM ne sont pas traduits — environ un sur
       six — et ceux-là retombent sur l'anglais plutôt que de rester vides. */
    texte: fr || en,
    texteFr: fr,
    texteEn: en,
    traduit: !!fr,
    src: "SOFIA",
    cat: categorie,
    fir_seul: groupe === "FIR",
    idSofia: String(n.id ?? ""),
  };
}

/* La structure réelle, relevée le 27/08/2026 :
     listnotams
       ADDep, ADDes   { code, name, + 12 tableaux de catégorie }
       ADDeg, ADSur   tableaux (dégagements, terrains survolés)
       FIR            { 8 tableaux de catégorie, aux noms différents }
       Other          tableau                                            */
const SOFIA_GROUPES = ["ADDep", "ADDeg", "ADSur", "ADDes", "FIR", "Other"];

function sofiaAplatis(listnotams: Record<string, any>) {
  const sortie: Record<string, unknown>[] = [];
  const vus = new Set<string>();
  const pousse = (n: unknown, groupe: string, categorie: string) => {
    if (!n || typeof n !== "object") return;
    const o = sofiaVersApp(n as Record<string, any>, groupe, categorie);
    /* dédupliquer par numéro et terrain : un même NOTAM peut figurer sous
       deux catégories */
    const cle = o.serie + "|" + o.ad;
    if (vus.has(cle)) return;
    vus.add(cle);
    sortie.push(o);
  };
  const traite = (nom: string, g: unknown) => {
    if (!g) return;
    if (Array.isArray(g)) { g.forEach((n) => pousse(n, nom, "")); return; }
    for (const [k, v] of Object.entries(g as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach((n) => pousse(n, nom, k));
      else if (v && typeof v === "object") traite(nom, v);
    }
  };
  const connu = SOFIA_GROUPES.some((k) => k in (listnotams || {}));
  if (connu) {
    for (const k of SOFIA_GROUPES) traite(k, listnotams[k]);
    /* tout groupe qu'une évolution de SOFIA ajouterait : on le prend quand même */
    for (const k of Object.keys(listnotams)) if (!SOFIA_GROUPES.includes(k)) traite(k, listnotams[k]);
  } else {
    /* structure inattendue : parcours tolérant plutôt qu'une liste vide, qui
       passerait pour « aucun NOTAM » */
    (function marche(n: unknown, ch: string[]) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach((x) => marche(x, ch)); return; }
      const o = n as Record<string, unknown>;
      if (typeof o.itemE === "string") { pousse(o, ch[0] || "", ch[ch.length - 1] || ""); return; }
      for (const [k, v] of Object.entries(o)) marche(v, ch.concat(k));
    })(listnotams, []);
  }
  return sortie;
}

/* La séquence complète. Le bocal à témoins est PROPRE À CET APPEL : le bocal
   global du relais (temoinsSofia) sert les images de cartes, et un JSESSIONID
   périmé qui s'y serait attardé ferait échouer la préparation. */
async function sofiaPib(route: string[], o: Record<string, string>):
    Promise<{ pib: Record<string, any>; trace: Record<string, unknown>[] }> {
  const pot = new Map<string, string>();
  const trace: Record<string, unknown>[] = [];

  const appel = async (etape: string, url: string, init: RequestInit = {}): Promise<Response> => {
    let cible = url, rep: Response | null = null;
    for (let saut = 0; saut < 6; saut++) {
      const t0 = Date.now();
      const h = new Headers(init.headers);
      const c = Array.from(pot).map(([k, v]) => k + "=" + v).join("; ");
      if (c) h.set("Cookie", c);
      rep = await fetch(cible, {
        method: init.method ?? "GET", headers: h, body: init.body,
        redirect: "manual", signal: AbortSignal.timeout(20000),
      });
      /* on récolte les témoins de CE saut avant de suivre la redirection */
      const recus: string[] = [];
      try {
        const brut: string[] = typeof (rep.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
          ? (rep.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
          : (rep.headers.get("set-cookie") ? [rep.headers.get("set-cookie") as string] : []);
        for (const l of brut) {
          const m = /^\s*([^=;,\s]+)=([^;]*)/.exec(l);
          if (m) { pot.set(m[1], m[2]); recus.push(m[1]); }
        }
      } catch { /* témoins illisibles */ }
      /* on ne journalise QUE les noms de témoins, jamais leurs valeurs */
      trace.push({ etape, http: rep.status, ms: Date.now() - t0, temoins: recus });
      if (rep.status >= 300 && rep.status < 400 && rep.headers.get("location")) {
        cible = new URL(rep.headers.get("location") as string, cible).toString();
        init = { method: "GET", headers: init.headers };
        continue;
      }
      break;
    }
    return rep as Response;
  };

  /* 1 — la session HTTP */
  const init = await appel("session", SOFIA_FORM, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
  });
  if (!init.ok) throw new Error("SOFIA session HTTP " + init.status);
  await init.text();
  if (!pot.has("JSESSIONID")) throw new Error("SOFIA : JSESSIONID absent");

  /* 2 — l'uuid applicatif, distinct de la session */
  const uuid = crypto.randomUUID();
  const validFrom = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const d = new Date(validFrom);
  const dd = (n: number) => String(n).padStart(2, "0");

  /* 3 — le corps commun, « :operation » en tête comme le test de référence */
  const commun: [string, string][] = [
    ["valid_from", validFrom],
    ["duration", o.duration || "1200"],      /* HHMM : 1200 = 12 h */
    ["traffic", o.traffic || "VI"],
    ["fl_lower", o.flLower || "0"],
    ["fl_upper", o.flUpper || "999"],
    ["width", o.width || "15"],
    ["radiusAD", o.radiusAD || "30"],
    ...route.map((p) => ["route[]", p] as [string, string]),   /* une occurrence par point */
    ["uuid", uuid],
    ["isFromSofia", "true"],
    ["operation", "postNarrowRoutePibRequest"],
    ["target", "#aside-target"],
    ["href", "/sofia/pages/notamroute.html"],
    ["typeVol", "N"],
    ["departure_date", dd(d.getUTCDate()) + "-" + dd(d.getUTCMonth() + 1) + "-" + d.getUTCFullYear()],
    ["departure_time", dd(d.getUTCHours()) + dd(d.getUTCMinutes())],
    ["lang", "fr"],
    ["routeVal", "false"],
  ];
  const corps = (op: string) =>
    ([[":operation", op] as [string, string]].concat(commun))
      .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  const entetes = {
    "User-Agent": UA,
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Origin": SOFIA,
    "Referer": SOFIA_FORM,
    "X-Requested-With": "XMLHttpRequest",
  };

  /* 4 — la préparation. Ne pas la retirer sans preuve : elle est dans le
     chemin validé, et rien ne dit que le PIB s'en passe. */
  const prep = await appel("preparation", SOFIA + "/sofia", {
    method: "POST", headers: entetes, body: corps("postsaveinsessionprepa"),
  });
  if (!prep.ok) throw new Error("SOFIA preparation HTTP " + prep.status);
  await prep.text();

  /* 5 — le PIB */
  const rp = await appel("pib", SOFIA + "/sofia", {
    method: "POST", headers: entetes, body: corps("postNarrowRoutePibRequest"),
  });
  if (!rp.ok) throw new Error("SOFIA pib HTTP " + rp.status);
  const texte = await rp.text();
  trace[trace.length - 1].octets = texte.length;

  /* 6 — le double décodage */
  let externe: Record<string, unknown>;
  try { externe = JSON.parse(texte); }
  catch { throw new Error("SOFIA : réponse PIB non JSON (" + texte.slice(0, 60) + ")"); }
  if (typeof externe["status.message"] !== "string") {
    throw new Error("SOFIA : status.message absent — le schéma a peut-être changé");
  }
  const pib = JSON.parse(externe["status.message"] as string);
  if (!pib || !pib.listnotams) throw new Error("SOFIA : listnotams absent");

  /* 7 — cohérence : ne jamais rendre un PIB qui ne correspond pas à la route */
  const dep = pib.listnotams?.ADDep?.code, des = pib.listnotams?.ADDes?.code;
  if (dep && dep !== route[0]) throw new Error("SOFIA : départ incohérent (" + dep + ")");
  if (des && des !== route[route.length - 1]) {
    throw new Error("SOFIA : destination incohérente (" + des + ")");
  }
  return { pib, trace };
}

function reponseSofiaN(corps: string, voie: "memo" | "base" | "frais"): Response {
  return new Response(corps, { headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=600",
    "Access-Control-Allow-Origin": "*",
    "X-Cartes-Version": VERSION,
    "X-Cartes-Sofia": voie,
  } });
}

async function notamSofia(q: URLSearchParams): Promise<Response> {
  const route = (q.get("route") || "").toUpperCase().split(",")
    .map((x) => x.trim()).filter(Boolean);
  if (route.length < 2 || route.length > 20) {
    return reponseJson({ erreur: "paramètre route attendu : route=LFPN,LFPZ (2 à 20 points)" }, 400);
  }
  for (const p of route) {
    if (!/^[A-Z0-9]{2,11}$/.test(p)) {
      return reponseJson({ erreur: "point de route invalide : " + p }, 400);
    }
  }
  const opts: Record<string, string> = {};
  for (const k of ["duration", "traffic", "flLower", "flUpper", "width", "radiusAD"]) {
    const v = q.get(k); if (v) opts[k] = v;
  }
  /* La mémoire ne dépend PAS de la langue : les deux textes voyagent ensemble,
     et l'application choisit lequel afficher. Une seule entrée sert donc les
     deux langues — la mémoire partagée en est d'autant plus utile. */
  const cle = "sofia:" + route.join(">") + "|" + JSON.stringify(opts);
  const su = memoSofiaN.get(cle);
  if (su && Date.now() - su.t < SOFIA_NOTAM_DUREE && q.get("essai") !== "1") {
    return reponseSofiaN(su.corps, "memo");
  }
  const pt = q.get("essai") === "1" ? null : await memoFrais(cle);
  if (pt) {
    /* on garde l'ÂGE d'origine : passer par la base ne rajeunit rien */
    memoSofiaN.set(cle, { t: Date.now() - (SOFIA_NOTAM_DUREE - pt.reste), corps: pt.valeur });
    return reponseSofiaN(pt.valeur, "base");
  }
  try {
    const { pib, trace } = await sofiaPib(route, opts);
    const notams = sofiaAplatis(pib.listnotams);
    const corps = JSON.stringify({
      ok: true,
      source: "SOFIA-Briefing",
      route,
      pibUid: pib.pibUid,
      validFrom: pib.validFrom,
      validTo: pib.validTo,
      releveA: new Date().toISOString(),
      /* le compte annoncé par SOFIA, à côté du nôtre : un écart signale un
         changement de schéma bien avant qu'un NOTAM ne manque en silence */
      nbSofia: pib.nbNotams,
      total: notams.length,
      traduits: notams.filter((n) => n.traduit).length,
      notams,
      sofia: q.get("essai") === "1" ? trace : undefined,
    });
    memoSofiaN.set(cle, { t: Date.now(), corps });
    if (q.get("essai") !== "1") await memoRange(cle, corps, SOFIA_NOTAM_DUREE);
    return reponseSofiaN(corps, "frais");
  } catch (e) {
    /* JAMAIS un faux « aucun NOTAM » : une panne SOFIA est une ERREUR, et
       l'application doit pouvoir replier sur autorouter en le sachant. */
    return reponseJson({ erreur: String((e as Error)?.message ?? e).slice(0, 200) }, 502);
  }
}
