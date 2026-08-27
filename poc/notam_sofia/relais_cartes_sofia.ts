// relais_cartes_sofia.ts — la branche SOFIA à greffer dans la fonction Edge
// « cartes » de LOGNAVAK.
//
// POURQUOI CÔTÉ SERVEUR. Le navigateur ne peut pas parler à SOFIA : il n'a pas
// le droit d'y poser un JSESSIONID (cookie tiers, HttpOnly) et SOFIA n'ouvre
// aucun CORS. Toute la séquence doit donc vivre dans le relais, comme déjà
// pour autorouter et AEROWEB.
//
// GREFFE. Dans « cartes », à côté des branches existantes (?notam=1,
// ?supaip=1, ?sigmet=1), ajouter :
//
//     if (url.searchParams.get("sofia") === "1") return await sofiaNotams(url);
//
// et coller ce fichier au-dessus. Aucun secret : SOFIA ne demande aucune
// authentification sur ce flux. Rien à ajouter dans les secrets Supabase,
// rien qui puisse fuir dans GitHub.
//
// APPEL DEPUIS L'APPLI :
//     /functions/v1/cartes?sofia=1&route=LFPN,LFPZ&lang=fr
//
// RENDU : les NOTAM sont livrés DÉJÀ CONVERTIS dans la forme interne de
// LOGNAVAK (serie, qcode, fir, trafic, objet, portee, bas, haut, lat, lon,
// rayon, ad, debut, fin, estimee, horaire, texte). L'appli n'a donc aucune
// connaissance de SOFIA : tout l'adaptateur tient dans ce seul fichier, ce que
// demandait le § 12 du document — « isoler tout le code SOFIA dans un seul
// module ».

const SOFIA_ORIGIN = "https://sofia-briefing.aviation-civile.gouv.fr";
const SOFIA_PAGE = `${SOFIA_ORIGIN}/sofia/pages/notamform.html`;
const SOFIA_API = `${SOFIA_ORIGIN}/sofia`;
const DELAI_MS = 20000;
const CACHE_MS = 120000; // très court : données opérationnelles

const memo = new Map<string, { t: number; v: unknown }>();

const pad = (n: number) => String(n).padStart(2, "0");
const brut = (p: [string, string][]) =>
  p.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

function cookiesDe(r: Response): [string, string][] {
  const lignes = typeof r.headers.getSetCookie === "function"
    ? r.headers.getSetCookie()
    : [r.headers.get("set-cookie") ?? ""].filter(Boolean);
  const out: [string, string][] = [];
  for (const l of lignes) {
    const re = /(?:^|,\s*)([A-Za-z0-9_.\-]+)=([^;,\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l))) {
      if (/^(path|domain|expires|max-age|samesite|secure|httponly|version)$/i.test(m[1])) continue;
      out.push([m[1], m[2]]);
    }
  }
  return out;
}

/* ─────────────────────────── la séquence SOFIA ─────────────────────────── */

async function pibSofia(route: string[], o: Record<string, string>) {
  const pot = new Map<string, string>();
  const trace: Record<string, unknown>[] = [];

  // Redirections suivies à la main : fetch n'expose que les en-têtes de la
  // réponse finale, or un JSESSIONID posé sur une 302 serait alors perdu.
  const appel = async (etape: string, url: string, init: RequestInit = {}) => {
    let cible = url, rep: Response | null = null;
    for (let saut = 0; saut < 6; saut++) {
      const t0 = Date.now();
      const h = new Headers(init.headers);
      const c = [...pot].map(([k, v]) => `${k}=${v}`).join("; ");
      if (c) h.set("Cookie", c);
      rep = await fetch(cible, {
        method: init.method ?? "GET", headers: h, body: init.body,
        redirect: "manual", signal: AbortSignal.timeout(DELAI_MS),
      });
      const recus = cookiesDe(rep);
      for (const [k, v] of recus) pot.set(k, v);
      // on ne journalise QUE les noms de cookies, jamais les valeurs
      trace.push({ etape, code: rep.status, ms: Date.now() - t0, cookies: recus.map(([k]) => k) });
      if (rep.status >= 300 && rep.status < 400 && rep.headers.get("location")) {
        cible = new URL(rep.headers.get("location")!, cible).toString();
        init = { method: "GET", headers: init.headers };
        continue;
      }
      break;
    }
    return rep!;
  };

  const init = await appel("session", SOFIA_PAGE, { headers: { Accept: "text/html,application/xhtml+xml" } });
  if (!init.ok) throw new Error(`SOFIA session HTTP ${init.status}`);
  await init.text();
  if (!pot.has("JSESSIONID")) throw new Error("SOFIA : JSESSIONID absent");

  const uuid = crypto.randomUUID();
  const validFrom = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const d = new Date(validFrom);

  const commun: [string, string][] = [
    ["valid_from", validFrom],
    ["duration", o.duration || "1200"],   // HHMM : 1200 = 12 h, PAS 1200 minutes
    ["traffic", o.traffic || "VI"],
    ["fl_lower", o.flLower || "0"],
    ["fl_upper", o.flUpper || "999"],
    ["width", o.width || "15"],
    ["radiusAD", o.radiusAD || "30"],
    ...route.map((p) => ["route[]", p] as [string, string]),  // une occurrence par point
    ["uuid", uuid],
    ["isFromSofia", "true"],
    ["operation", "postNarrowRoutePibRequest"],
    ["target", "#aside-target"],
    ["href", "/sofia/pages/notamroute.html"],
    ["typeVol", "N"],
    ["departure_date", `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`],
    ["departure_time", `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`],
    ["lang", "fr"],
    ["routeVal", "false"],
  ];
  const entetes = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: SOFIA_ORIGIN, Referer: SOFIA_PAGE, "X-Requested-With": "XMLHttpRequest",
  };

  const prep = await appel("preparation", SOFIA_API, {
    method: "POST", headers: entetes,
    body: brut([[":operation", "postsaveinsessionprepa"], ...commun]),
  });
  if (!prep.ok) throw new Error(`SOFIA preparation HTTP ${prep.status}`);
  await prep.text();

  const rp = await appel("pib", SOFIA_API, {
    method: "POST", headers: entetes,
    body: brut([[":operation", "postNarrowRoutePibRequest"], ...commun]),
  });
  if (!rp.ok) throw new Error(`SOFIA pib HTTP ${rp.status}`);
  const texte = await rp.text();

  // double décodage : status.message est une CHAÎNE contenant un second JSON
  let externe: Record<string, unknown>;
  try { externe = JSON.parse(texte); }
  catch { throw new Error("SOFIA : réponse PIB non JSON"); }
  if (typeof externe["status.message"] !== "string") {
    throw new Error("SOFIA : status.message absent — le schéma a peut-être changé");
  }
  const pib = JSON.parse(externe["status.message"] as string);
  if (!pib?.listnotams) throw new Error("SOFIA : listnotams absent");

  const dep = pib.listnotams?.ADDep?.code, des = pib.listnotams?.ADDes?.code;
  if (dep && dep !== route[0]) throw new Error(`SOFIA : départ incohérent (${dep})`);
  if (des && des !== route[route.length - 1]) throw new Error(`SOFIA : destination incohérente (${des})`);

  return { pib, trace };
}

/* ────────────── SOFIA → la forme interne des NOTAM de LOGNAVAK ────────────── */

const nombre = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const epoque = (v: unknown) => {
  if (!v) return 0;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : Math.round(t / 1000);
};

// « 4845N00207E » → { lat: 48.75, lon: 2.1166… }. Le rayon voyage à part,
// dans le champ radius, contrairement à la forme OACI compacte.
function coord(v: unknown) {
  const m = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])/.exec(String(v || ""));
  if (!m) return { lat: null as number | null, lon: null as number | null };
  const la = (+m[1] + +m[2] / 60) * (m[3] === "S" ? -1 : 1);
  const lo = (+m[4] + +m[5] / 60) * (m[6] === "W" ? -1 : 1);
  return { lat: la, lon: lo };
}

// Les noms exacts des champs purpose / scope / lower / upper de la ligne Q ne
// sont pas tous confirmés sur relevé : on essaie les variantes plausibles.
// Une ligne Q incomplète n'est PAS affichée par l'appli — elle ressemblerait à
// l'officielle sans en être une — donc l'échec est silencieux et sans dommage.
const champ = (o: Record<string, unknown>, noms: string[]) => {
  for (const n of noms) if (o && o[n] != null && o[n] !== "") return o[n];
  return null;
};

function versFormeApp(n: Record<string, any>, groupe: string, categorie: string, langue: string) {
  const q = (n.qLine || {}) as Record<string, unknown>;
  const c = coord(n.coordinates);
  const fr = typeof n.multiLanguage?.itemE === "string" ? n.multiLanguage.itemE.trim() : "";
  const en = typeof n.itemE === "string" ? n.itemE.trim() : "";
  const finFmt = String(n.endValidityFormat || "");

  return {
    ad: n.itemA || n.sectionCode || (groupe === "FIR" ? String(q.fir || "FIR") : ""),
    // forme OACI officielle du numéro : E3550/26. « id » est un identifiant
    // interne SOFIA (400000051804734), ce n'est PAS le numéro du NOTAM.
    serie: (n.series && n.number != null)
      ? `${n.series}${n.number}/${String(n.year ?? "").padStart(2, "0")}`
      : String(n.id ?? ""),
    qcode: [q.code23, q.code45].filter(Boolean).join(""),
    fir: String(q.fir || ""),
    trafic: String(q.traffic || ""),
    objet: String(champ(q, ["purpose", "pu", "purposes", "objet"]) ?? ""),
    portee: String(champ(q, ["scope", "sc", "portee"]) ?? ""),
    bas: nombre(champ(q, ["lower", "lowerLimit", "lower_fl", "bas"])),
    haut: nombre(champ(q, ["upper", "upperLimit", "upper_fl", "haut"])),
    lat: c.lat, lon: c.lon, rayon: nombre(n.radius),
    debut: epoque(n.startValidity),
    fin: epoque(n.endValidity),
    estimee: /\bEST\b/i.test(finFmt) || n.estimated === true,
    horaire: String(n.itemD || ""),
    // français par défaut, repli sur l'anglais quand la traduction manque
    texte: (langue === "en" ? en : (fr || en)) || "",
    texteEn: en,
    texteFr: fr,
    traduit: !!fr,
    src: "SOFIA",
    cat: categorie,
    fir_seul: groupe === "FIR",   // NOTAM en-route, sans terrain rattaché
    idSofia: String(n.id ?? ""),
  };
}

const GROUPES = ["ADDep", "ADDeg", "ADSur", "ADDes", "FIR", "Other"];

function aplatis(listnotams: Record<string, any>, langue: string) {
  const sortie: any[] = [];
  const vus = new Set<string>();

  const pousse = (n: any, groupe: string, categorie: string) => {
    if (!n || typeof n !== "object") return;
    const o = versFormeApp(n, groupe, categorie, langue);
    // dédupliquer par série/numéro/année, comme le recommande le § 13 :
    // un même NOTAM peut figurer sous deux catégories
    const cle = o.serie + "|" + o.ad;
    if (vus.has(cle)) return;
    vus.add(cle);
    sortie.push(o);
  };

  const traite = (nom: string, g: any) => {
    if (!g) return;
    if (Array.isArray(g)) return g.forEach((n) => pousse(n, nom, ""));
    for (const [k, v] of Object.entries(g)) {
      if (Array.isArray(v)) v.forEach((n) => pousse(n, nom, k));
      else if (v && typeof v === "object") traite(nom, v);
    }
  };

  const connu = GROUPES.some((k) => k in (listnotams || {}));
  if (connu) {
    for (const k of GROUPES) traite(k, listnotams[k]);
    // tout groupe qu'une évolution de SOFIA ajouterait : on le prend quand même
    for (const k of Object.keys(listnotams)) if (!GROUPES.includes(k)) traite(k, listnotams[k]);
  } else {
    // structure inattendue : parcours tolérant plutôt qu'une liste vide, qui
    // passerait pour « aucun NOTAM »
    (function marche(n: any, ch: string[]) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((x) => marche(x, ch));
      if (typeof n.itemE === "string") return pousse(n, ch[0] || "", ch[ch.length - 1] || "");
      for (const [k, v] of Object.entries(n)) marche(v, ch.concat(k));
    })(listnotams, []);
  }
  return sortie;
}

/* ───────────────────────────── la branche HTTP ───────────────────────────── */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=UTF-8",
  "Cache-Control": "no-store",
};
const rendu = (d: unknown, code = 200) =>
  new Response(JSON.stringify(d), { status: code, headers: CORS });

export async function sofiaNotams(url: URL): Promise<Response> {
  try {
    const route = String(url.searchParams.get("route") || "")
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (route.length < 2 || route.length > 20) {
      return rendu({ erreur: "route : il faut de 2 à 20 points" }, 400);
    }
    for (const p of route) {
      if (!/^[A-Z0-9]{2,11}$/.test(p)) return rendu({ erreur: "point de route invalide : " + p }, 400);
    }
    const langue = url.searchParams.get("lang") === "en" ? "en" : "fr";
    const opts: Record<string, string> = {};
    for (const k of ["duration", "traffic", "flLower", "flUpper", "width", "radiusAD"]) {
      const v = url.searchParams.get(k);
      if (v) opts[k] = v;
    }

    const cle = route.join(">") + "|" + JSON.stringify(opts);
    const enMemo = memo.get(cle);
    let pib: any, trace: unknown;
    if (enMemo && Date.now() - enMemo.t < CACHE_MS) {
      pib = enMemo.v;
    } else {
      const r = await pibSofia(route, opts);
      pib = r.pib; trace = r.trace;
      memo.set(cle, { t: Date.now(), v: pib });
    }

    const notams = aplatis(pib.listnotams, langue);
    return rendu({
      ok: true,
      source: "SOFIA-Briefing",
      pibUid: pib.pibUid,
      validFrom: pib.validFrom,
      validTo: pib.validTo,
      releveA: new Date().toISOString(),
      // le compte annoncé par SOFIA, à comparer au nôtre : un écart signale un
      // changement de schéma bien avant qu'un NOTAM ne manque en silence
      nbSofia: pib.nbNotams,
      bruts: notams.length,
      traduits: notams.filter((n) => n.traduit).length,
      notams,
      trace,
    });
  } catch (e) {
    // JAMAIS un faux « aucun NOTAM » : une panne SOFIA est une ERREUR, et
    // l'appli doit pouvoir basculer sur autorouter en le sachant.
    return rendu({ erreur: String((e as Error)?.message ?? e).slice(0, 200) }, 502);
  }
}
