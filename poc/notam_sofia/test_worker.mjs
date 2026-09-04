/* test_worker.mjs — banc de l'artefact DÉPLOYABLE (le Worker corrigé), et
   preuve chiffrée des deux corrections apportées au Worker v1 du document.

   node test_worker.mjs
*/
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const faux = require("./faux_sofia.js");
const worker = (await import("./worker_v1_corrige.js")).default;

let ok = 0, ko = 0;
const dit = (b, t) => { b ? ok++ : ko++; console.log((b ? "OK    " : "ÉCHEC ") + t); };

const port = await faux.demarre(0);
const env = { SOFIA_ORIGIN: "http://127.0.0.1:" + port, ALLOWED_ORIGIN: "https://alexkilinc.github.io" };
const poste = (corps, chemin = "/api/notams/route") =>
  worker.fetch(new Request("https://w.example" + chemin, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
  }), env);

/* ===== 1. L'ARTEFACT RÉPOND ======================================== */
const sante = await worker.fetch(new Request("https://w.example/health"), env);
dit(sante.status === 200 && (await sante.json()).ok === true, "GET /health répond 200 ok:true");

const r404 = await worker.fetch(new Request("https://w.example/autre", { method: "POST" }), env);
dit(r404.status === 404, "un autre chemin répond 404 · " + r404.status);

const pre = await worker.fetch(new Request("https://w.example/api/notams/route", { method: "OPTIONS" }), env);
dit(pre.status === 204 && pre.headers.get("access-control-allow-origin") === "https://alexkilinc.github.io",
    "le préflet CORS n'autorise que l'origine LOGNAVAK · " + pre.headers.get("access-control-allow-origin"));

/* ===== 2. LE FLUX COMPLET, À TRAVERS L'ARTEFACT ==================== */
const rep = await poste({ route: ["LFPN", "LFPZ"] });
const j = await rep.json();
dit(rep.status === 200 && j.ok === true, "POST /api/notams/route répond 200 · " + rep.status);
dit(j.pib.pibUid === "LFYN2608272364", "pibUid · " + j.pib.pibUid);
dit(j.pib.listnotams.ADDep.code === "LFPN" && j.pib.listnotams.ADDes.code === "LFPZ",
    "ADDep/ADDes · " + j.pib.listnotams.ADDep.code + " → " + j.pib.listnotams.ADDes.code);
dit(j.trace.map((t) => t.etape).join(",") === "session,preparation,pib",
    "la trace de diagnostic montre les trois étapes · " + j.trace.map((t) => t.etape + ":" + t.code).join(" "));
dit(!/JSESSIONID=/.test(JSON.stringify(j)), "et ne contient aucune valeur de JSESSIONID");
dit(typeof j.retrievedAt === "string" && /Z$/.test(j.retrievedAt),
    "retrievedAt est présent, pour l'affichage aviation · " + j.retrievedAt);
dit(j.source === "SOFIA-Briefing", "la source est nommée · " + j.source);

/* ===== 3. ERREUR CONTRÔLÉE, JAMAIS UN FAUX « AUCUN NOTAM » ========= */
const mauvaise = await poste({ route: ["LFPN"] });
const jm = await mauvaise.json();
dit(mauvaise.status === 502 && jm.ok === false && /2 à 20 points/.test(jm.error),
    "route invalide -> 502 avec message · « " + jm.error + " »");
dit(!("pib" in jm) && !("notams" in jm),
    "et surtout AUCUNE liste vide qui passerait pour « aucun NOTAM »");

const envMort = { SOFIA_ORIGIN: "http://127.0.0.1:1" };
const panne = await worker.fetch(new Request("https://w.example/api/notams/route", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ route: ["LFPN", "LFPZ"] }) }), envMort);
const jp = await panne.json();
dit(panne.status === 502 && jp.ok === false, "SOFIA injoignable -> 502 · « " + jp.error + " »");

/* ===== 4. LE CACHE COURT =========================================== */
const c1 = await (await poste({ route: ["LFPT", "LFOZ"] })).json();
const c2 = await (await poste({ route: ["LFPT", "LFOZ"] })).json();
dit(c1.cache === undefined && c2.cache === true, "la seconde requête identique sort du cache court");
dit(c1.retrievedAt === c2.retrievedAt, "et conserve retrievedAt du relevé d'origine · " + c2.retrievedAt);
const c3 = await (await poste({ route: ["LFPN", "LFPZ"], lang: "en" })).json();
dit(c3.cache === undefined, "un paramètre différent ne tape pas dans le même cache");

/* ===== 5. PREUVE DE LA CORRECTION n°1 ============================== */
/* Le Worker v1 du document faisait : new URLSearchParams(common) puis
   .set(":operation", …). set() sur une clé ABSENTE ajoute EN QUEUE. */
const u = new URLSearchParams();
u.append("valid_from", "2026-08-27T10:00:00Z");
u.append("route[]", "LFPN"); u.append("route[]", "LFPZ");
u.set(":operation", "postsaveinsessionprepa");
const v1 = u.toString();
dit(!v1.startsWith("%3Aoperation="),
    "v1 du document : « :operation » se retrouve EN QUEUE du corps · …" + v1.slice(-38));
dit(v1.endsWith("%3Aoperation=postsaveinsessionprepa"),
    "confirmé — URLSearchParams.set() ajoute en fin quand la clé est absente");
/* la copie URLSearchParams->URLSearchParams préserve bien les répétitions :
   ce point-là du v1 était correct, il faut le dire aussi */
dit((new URLSearchParams(u).toString().match(/route%5B%5D=/g) || []).length === 2,
    "en revanche new URLSearchParams(uneAutre) PRÉSERVE les route[] répétés — ce point du v1 était bon");

/* ===== 6. PREUVE DE LA CORRECTION n°2 ============================== */
/* Un Set-Cookie posé sur une 302 : redirect:"follow" le perd. */
const redir = http.createServer((req, res) => {
  if (req.url === "/depart") {
    res.writeHead(302, { Location: "/arrivee", "Set-Cookie": "JSESSIONID=ABC123;Path=/;HttpOnly" });
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html>ok</html>");
});
const pr = await new Promise((r) => redir.listen(0, "127.0.0.1", () => r(redir.address().port)));

const suivi = await fetch("http://127.0.0.1:" + pr + "/depart", { redirect: "follow" });
dit(suivi.status === 200 && !(suivi.headers.get("set-cookie") || "").includes("JSESSIONID"),
    "redirect:\"follow\" — la réponse finale ne porte PLUS le JSESSIONID de la 302");

const manuel = await fetch("http://127.0.0.1:" + pr + "/depart", { redirect: "manual" });
dit(manuel.status === 302 && (manuel.headers.get("set-cookie") || "").includes("JSESSIONID=ABC123"),
    "redirect:\"manual\" — le JSESSIONID est bien récolté sur la 302");
await new Promise((r) => redir.close(r));

/* ===== 7. PREUVE DE LA CORRECTION n°3 ============================== */
const lent = http.createServer(() => { /* ne répond jamais */ });
const pl = await new Promise((r) => lent.listen(0, "127.0.0.1", () => r(lent.address().port)));
const t0 = Date.now();
const bloque = await worker.fetch(new Request("https://w.example/api/notams/route", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ route: ["LFPN", "LFPZ"] }) }), { SOFIA_ORIGIN: "http://127.0.0.1:" + pl });
const ms = Date.now() - t0;
dit(bloque.status === 502 && ms < 25000,
    "SOFIA qui ne répond jamais : le délai de garde coupe · " + Math.round(ms / 1000) + " s, HTTP " + bloque.status);
lent.closeAllConnections?.(); await new Promise((r) => lent.close(r));

await faux.arrete();
console.log("\n=== " + ok + " OK / " + ko + " ÉCHEC ===");
process.exit(ko ? 1 : 0);
