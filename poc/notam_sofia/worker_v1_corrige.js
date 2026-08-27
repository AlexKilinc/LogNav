/* worker_v1_corrige.js — le Worker Cloudflare v1 du document, corrigé.
   Même logique que supabase_notam_sofia.ts, avec l'emballage Cloudflare.
   Testable hors Cloudflare : Node 22 fournit Request/Response/Headers, et
   env.SOFIA_ORIGIN permet de le brancher sur la doublure locale.

   CORRECTIONS PAR RAPPORT À LA v1 DU DOCUMENT (détail dans README.md) :
     1. corps BRUT avec « :operation » en tête — URLSearchParams.set() sur une
        clé absente AJOUTE EN QUEUE, la v1 ne reproduisait donc pas l'ordre du
        test PowerShell validé ;
     2. redirect:"manual" + bocal à cookies — avec redirect:"follow", un
        Set-Cookie posé sur une 302 est perdu et le JSESSIONID manque ;
     3. AbortSignal.timeout sur les trois appels (le § 12 le demandait en v2) ;
     4. validFrom vérifié UTC/Z avant l'appel, pas seulement parsable ;
     5. trace de diagnostic (§ 13) sans jamais journaliser le JSESSIONID ;
     6. cache court par requête identique (§ 12) ;
     7. contrôle de cohérence ADDep/ADDes appliqué même à 2 points exactement.
*/

const pad = (n) => String(n).padStart(2, "0");
const corpsBrut = (p) => p.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&");
const DELAI_MS = 20000, CACHE_MS = 120000;
const cache = new Map();

function valideRoute(v) {
  if (!Array.isArray(v) || v.length < 2 || v.length > 20) throw new Error("route : il faut de 2 à 20 points");
  return v.map((p) => {
    const s = String(p).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,11}$/.test(s)) throw new Error("point de route invalide : " + s);
    return s;
  });
}

function cookiesDe(r) {
  const lignes = typeof r.headers.getSetCookie === "function"
    ? r.headers.getSetCookie()
    : [r.headers.get("set-cookie") || ""].filter(Boolean);
  const out = [];
  for (const ligne of lignes) {
    const re = /(?:^|,\s*)([A-Za-z0-9_.\-]+)=([^;,\s]+)/g;
    let m;
    while ((m = re.exec(ligne))) {
      if (/^(path|domain|expires|max-age|samesite|secure|httponly|version)$/i.test(m[1])) continue;
      out.push([m[1], m[2]]);
    }
  }
  return out;
}

async function sofia(origin, route, o) {
  const PAGE = origin + "/sofia/pages/notamform.html", API = origin + "/sofia";
  const pot = new Map(), trace = [];

  const appel = async (etape, url, init = {}) => {
    let cible = url, rep = null;
    for (let saut = 0; saut < 6; saut++) {
      const t0 = Date.now();
      const h = new Headers(init.headers);
      const c = [...pot].map(([k, v]) => k + "=" + v).join("; ");
      if (c) h.set("Cookie", c);
      rep = await fetch(cible, {
        method: init.method || "GET", headers: h, body: init.body,
        redirect: "manual", signal: AbortSignal.timeout(DELAI_MS),
      });
      const recus = cookiesDe(rep);
      for (const [k, v] of recus) pot.set(k, v);
      trace.push({ etape, methode: init.method || "GET", code: rep.status,
                   ms: Date.now() - t0, cookiesRecus: recus.map(([k]) => k) });
      if (rep.status >= 300 && rep.status < 400 && rep.headers.get("location")) {
        cible = new URL(rep.headers.get("location"), cible).toString();
        init = { method: "GET", headers: init.headers };
        continue;
      }
      break;
    }
    return rep;
  };

  const init = await appel("session", PAGE, { headers: { Accept: "text/html,application/xhtml+xml" } });
  if (!init.ok) throw new Error("SOFIA session HTTP " + init.status);
  await init.text();
  if (!pot.has("JSESSIONID")) throw new Error("SOFIA : JSESSIONID absent");

  const uuid = crypto.randomUUID();
  const validFrom = o.validFrom || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (!/Z$/.test(validFrom)) throw new Error("validFrom doit être UTC et se terminer par Z");
  const d = new Date(validFrom);
  if (Number.isNaN(d.getTime())) throw new Error("validFrom invalide");

  const commun = [
    ["valid_from", validFrom],
    ["duration", String(o.duration ?? "1200")],
    ["traffic", String(o.traffic ?? "VI")],
    ["fl_lower", String(o.flLower ?? 0)],
    ["fl_upper", String(o.flUpper ?? 999)],
    ["width", String(o.widthNM ?? 15)],
    ["radiusAD", String(o.radiusADNM ?? 30)],
    ...route.map((p) => ["route[]", p]),
    ["uuid", uuid],
    ["isFromSofia", "true"],
    ["operation", "postNarrowRoutePibRequest"],
    ["target", "#aside-target"],
    ["href", "/sofia/pages/notamroute.html"],
    ["typeVol", "N"],
    ["departure_date", pad(d.getUTCDate()) + "-" + pad(d.getUTCMonth() + 1) + "-" + d.getUTCFullYear()],
    ["departure_time", pad(d.getUTCHours()) + pad(d.getUTCMinutes())],
    ["lang", o.lang === "en" ? "en" : "fr"],
    ["routeVal", "false"],
  ];
  const entetes = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: origin, Referer: PAGE, "X-Requested-With": "XMLHttpRequest",
  };

  const prep = await appel("preparation", API, {
    method: "POST", headers: entetes,
    body: corpsBrut([[":operation", "postsaveinsessionprepa"], ...commun]),
  });
  if (!prep.ok) throw new Error("SOFIA preparation HTTP " + prep.status);
  await prep.text();

  const rp = await appel("pib", API, {
    method: "POST", headers: entetes,
    body: corpsBrut([[":operation", "postNarrowRoutePibRequest"], ...commun]),
  });
  if (!rp.ok) throw new Error("SOFIA pib HTTP " + rp.status);
  const texte = await rp.text();

  let externe;
  try { externe = JSON.parse(texte); } catch { throw new Error("SOFIA : réponse PIB non JSON"); }
  if (typeof externe["status.message"] !== "string") {
    throw new Error("SOFIA : status.message absent — le schéma a peut-être changé");
  }
  const pib = JSON.parse(externe["status.message"]);
  if (!pib || !pib.listnotams) throw new Error("SOFIA : listnotams absent");

  const dep = pib.listnotams?.ADDep?.code, des = pib.listnotams?.ADDes?.code;
  if (dep && dep !== route[0]) throw new Error("SOFIA : départ incohérent (" + dep + ")");
  if (des && des !== route[route.length - 1]) throw new Error("SOFIA : destination incohérente (" + des + ")");

  return { pib, trace };
}

const entetesCors = (env) => ({
  "Access-Control-Allow-Origin": (env && env.ALLOWED_ORIGIN) || "https://alexkilinc.github.io",
  "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  Vary: "Origin",
});
const rep = (data, code, env) => new Response(JSON.stringify(data), {
  status: code,
  headers: { ...entetesCors(env), "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: entetesCors(env) });
    if (request.method === "GET" && url.pathname === "/health") {
      return rep({ ok: true, service: "lognavak-sofia" }, 200, env);
    }
    if (request.method !== "POST" || url.pathname !== "/api/notams/route") {
      return rep({ ok: false, error: "Not found" }, 404, env);
    }
    try {
      const entree = await request.json();
      const route = valideRoute(entree.route);
      const origin = (env && env.SOFIA_ORIGIN) || "https://sofia-briefing.aviation-civile.gouv.fr";
      const cle = origin + JSON.stringify([route, entree.duration, entree.traffic,
        entree.flLower, entree.flUpper, entree.widthNM, entree.radiusADNM, entree.lang]);

      const c = cache.get(cle);
      if (c && Date.now() - c.t < CACHE_MS) return rep({ ...c.v, cache: true }, 200, env);

      const { pib, trace } = await sofia(origin, route, entree);
      const valeur = { ok: true, source: "SOFIA-Briefing",
        retrievedAt: new Date().toISOString(), demande: { route }, pib, trace };
      cache.set(cle, { t: Date.now(), v: valeur });
      return rep(valeur, 200, env);
    } catch (e) {
      return rep({ ok: false, error: String((e && e.message) || e) }, 502, env);
    }
  },
};
