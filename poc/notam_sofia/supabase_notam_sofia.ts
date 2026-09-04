// supabase/functions/notam_sofia/index.ts
//
// Adaptateur SOFIA-Briefing pour LOGNAVAK, en Edge Function Supabase (Deno).
//
// POURQUOI ICI ET PAS SUR CLOUDFLARE : LOGNAVAK exploite déjà un relais
// serveur — la fonction « cartes » — avec ses secrets, son CORS et sa table
// relais_memo. Le document propose un Worker Cloudflare, ce qui ajouterait un
// second compte, un second domaine, un second jeu de secrets et un second
// point de panne pour exactement le même travail. Le code ci-dessous est le
// Worker v1 du document, corrigé et transposé sur l'infrastructure existante.
// (La version Cloudflare reste disponible : worker_v1_corrige.js.)
//
// Déploiement :   supabase functions deploy notam_sofia
// Appel :         POST <projet>.supabase.co/functions/v1/notam_sofia
//                 { "route": ["LFPN","LFPZ"] }
//
// AUCUN secret n'est nécessaire : SOFIA ne demande pas d'authentification sur
// ce flux. Rien à mettre dans GitHub, rien de nouveau à stocker.

const SOFIA_ORIGIN = "https://sofia-briefing.aviation-civile.gouv.fr";
const SOFIA_PAGE = `${SOFIA_ORIGIN}/sofia/pages/notamform.html`;
const SOFIA_API = `${SOFIA_ORIGIN}/sofia`;

const ORIGINE_AUTORISEE = Deno.env.get("LOGNAV_ORIGIN") ?? "https://alexkilinc.github.io";
const DELAI_MS = 20000;
const CACHE_MS = 120000; // cache très court : données opérationnelles (§ 12)

const cache = new Map<string, { t: number; v: unknown }>();

const pad = (n: number) => String(n).padStart(2, "0");

const corpsBrut = (paires: [string, string][]) =>
  paires.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

function valideRoute(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > 20) {
    throw new Error("route : il faut de 2 à 20 points");
  }
  return v.map((p) => {
    const s = String(p).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,11}$/.test(s)) throw new Error("point de route invalide : " + s);
    return s;
  });
}

function cookiesDe(r: Response): [string, string][] {
  const lignes = typeof r.headers.getSetCookie === "function"
    ? r.headers.getSetCookie()
    : [r.headers.get("set-cookie") ?? ""].filter(Boolean);
  const out: [string, string][] = [];
  for (const ligne of lignes) {
    const re = /(?:^|,\s*)([A-Za-z0-9_.\-]+)=([^;,\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ligne))) {
      if (/^(path|domain|expires|max-age|samesite|secure|httponly|version)$/i.test(m[1])) continue;
      out.push([m[1], m[2]]);
    }
  }
  return out;
}

async function sofia(route: string[], opts: Record<string, unknown>) {
  const pot = new Map<string, string>();
  const trace: Record<string, unknown>[] = [];

  // redirections suivies à la main : un Set-Cookie posé sur une 302 serait
  // perdu si l'on laissait fetch suivre tout seul.
  const appel = async (etape: string, url: string, init: RequestInit = {}) => {
    let cible = url, rep: Response | null = null;
    for (let saut = 0; saut < 6; saut++) {
      const t0 = Date.now();
      const h = new Headers(init.headers);
      const c = [...pot].map(([k, v]) => `${k}=${v}`).join("; ");
      if (c) h.set("Cookie", c);
      rep = await fetch(cible, {
        method: init.method ?? "GET",
        headers: h,
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.timeout(DELAI_MS),
      });
      for (const [k, v] of cookiesDe(rep)) pot.set(k, v);
      trace.push({
        etape,
        methode: init.method ?? "GET",
        code: rep.status,
        ms: Date.now() - t0,
        cookiesRecus: cookiesDe(rep).map(([k]) => k), // noms seulement, jamais les valeurs
      });
      if (rep.status >= 300 && rep.status < 400 && rep.headers.get("location")) {
        cible = new URL(rep.headers.get("location")!, cible).toString();
        init = { method: "GET", headers: init.headers };
        continue;
      }
      break;
    }
    return rep!;
  };

  // 1 — session HTTP
  const init = await appel("session", SOFIA_PAGE, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  if (!init.ok) throw new Error(`SOFIA session HTTP ${init.status}`);
  await init.text();
  if (!pot.has("JSESSIONID")) throw new Error("SOFIA : JSESSIONID absent");

  // 2 — UUID applicatif (distinct de la session HTTP)
  const uuid = crypto.randomUUID();

  const validFrom = (opts.validFrom as string) ??
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (!/Z$/.test(validFrom)) throw new Error("validFrom doit être UTC et se terminer par Z");
  const d = new Date(validFrom);
  if (Number.isNaN(d.getTime())) throw new Error("validFrom invalide");

  const commun: [string, string][] = [
    ["valid_from", validFrom],
    ["duration", String(opts.duration ?? "1200")], // HHMM, PAS des minutes
    ["traffic", String(opts.traffic ?? "VI")],
    ["fl_lower", String(opts.flLower ?? 0)],
    ["fl_upper", String(opts.flUpper ?? 999)],
    ["width", String(opts.widthNM ?? 15)],
    ["radiusAD", String(opts.radiusADNM ?? 30)],
    ...route.map((p) => ["route[]", p] as [string, string]), // une occurrence par point
    ["uuid", uuid],
    ["isFromSofia", "true"],
    ["operation", "postNarrowRoutePibRequest"],
    ["target", "#aside-target"],
    ["href", "/sofia/pages/notamroute.html"],
    ["typeVol", "N"],
    ["departure_date", `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`],
    ["departure_time", `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`],
    ["lang", opts.lang === "en" ? "en" : "fr"],
    ["routeVal", "false"],
  ];

  const entetes = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: SOFIA_ORIGIN,
    Referer: SOFIA_PAGE,
    "X-Requested-With": "XMLHttpRequest",
  };

  // 3 — sauvegarde de la préparation (à ne pas retirer avant preuve, § 11.9)
  const prep = await appel("preparation", SOFIA_API, {
    method: "POST",
    headers: entetes,
    body: corpsBrut([[":operation", "postsaveinsessionprepa"], ...commun]),
  });
  if (!prep.ok) throw new Error(`SOFIA preparation HTTP ${prep.status}`);
  await prep.text();

  // 4 — PIB
  const rep = await appel("pib", SOFIA_API, {
    method: "POST",
    headers: entetes,
    body: corpsBrut([[":operation", "postNarrowRoutePibRequest"], ...commun]),
  });
  if (!rep.ok) throw new Error(`SOFIA pib HTTP ${rep.status}`);
  const texte = await rep.text();

  // 5 — double décodage
  let externe: Record<string, unknown>;
  try { externe = JSON.parse(texte); }
  catch { throw new Error("SOFIA : réponse PIB non JSON"); }
  if (typeof externe["status.message"] !== "string") {
    throw new Error("SOFIA : status.message absent — le schéma a peut-être changé");
  }
  const pib = JSON.parse(externe["status.message"] as string);
  if (!pib?.listnotams) throw new Error("SOFIA : listnotams absent");

  // 6 — cohérence : ne jamais rendre un PIB qui ne correspond pas à la route
  const dep = pib.listnotams?.ADDep?.code, des = pib.listnotams?.ADDes?.code;
  if (dep && dep !== route[0]) throw new Error(`SOFIA : départ incohérent (${dep})`);
  if (des && des !== route[route.length - 1]) throw new Error(`SOFIA : destination incohérente (${des})`);

  return { pib, trace };
}

const cors = (o: Record<string, string> = {}) => ({
  "Access-Control-Allow-Origin": ORIGINE_AUTORISEE,
  "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey",
  Vary: "Origin",
  ...o,
});
const rep = (data: unknown, code = 200) =>
  new Response(JSON.stringify(data), {
    status: code,
    headers: cors({ "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" }),
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    return rep({ ok: true, service: "lognavak-sofia" });
  }
  if (req.method !== "POST") return rep({ ok: false, error: "Not found" }, 404);

  try {
    const entree = await req.json();
    const route = valideRoute(entree.route);
    const cle = JSON.stringify([route, entree.duration, entree.traffic, entree.flLower,
      entree.flUpper, entree.widthNM, entree.radiusADNM, entree.lang]);

    const enCache = cache.get(cle);
    if (enCache && Date.now() - enCache.t < CACHE_MS) {
      return rep({ ...(enCache.v as object), cache: true });
    }

    const { pib, trace } = await sofia(route, entree);
    const valeur = {
      ok: true,
      source: "SOFIA-Briefing",
      retrievedAt: new Date().toISOString(),
      demande: { route },
      pib,
      trace, // mode diagnostic (§ 13) : codes HTTP et durées, aucun cookie
    };
    cache.set(cle, { t: Date.now(), v: valeur });
    return rep(valeur);
  } catch (e) {
    // JAMAIS un faux « aucun NOTAM » : une panne SOFIA doit être une erreur (§ 12)
    return rep({ ok: false, error: String((e as Error)?.message ?? e) }, 502);
  }
});
