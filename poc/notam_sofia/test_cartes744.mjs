/* test_cartes744.mjs — le relais 7.44 COMPLET (supabase/functions/cartes/
   index.ts) contre la doublure stricte de SOFIA + Météo-France
   (poc/temsi_wintem/faux_meteo.js).

   Ce que 7.44 ajoute, et que ce banc éprouve :

   · ?img=1 emprunte désormais le PROTOCOLE COMPLET de la note — session
     (JSESSIONID), préparation (postsaveinsessionprepa), postTemsi/postWintem,
     lien frais — LÀ MÊME OÙ l'ancienne voie échoue : la doublure refuse tout
     POST sans session (403), comme le vrai SOFIA refusait la planche ;
   · le PDF est VÉRIFIÉ (octets « %PDF- »), pas supposé ;
   · en dernier recours, le Worker Cloudflare (secret CARTES_WORKER) ;
   · sans Worker configuré, l'échec le DIT ;
   · rien de l'existant n'est abîmé (?version=1, la branche ?sofia=1).

     node test_cartes744.mjs
*/
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";

let ok = 0, ko = 0;
const dit = (b, t) => { b ? ok++ : ko++; console.log((b ? "OK    " : "ÉCHEC ") + t); };

const REF = "2026-08-28T13:00:00Z";      /* échéances : 09 / 12 / 15 / 18 */
const port = 8875, portVide = 8876, portW = 8877;
const doubles = [
  spawn(process.execPath, ["../temsi_wintem/faux_meteo.js", String(port)],
    { stdio: "ignore", env: { ...process.env, FM_REF: REF } }),
  spawn(process.execPath, ["../temsi_wintem/faux_meteo.js", String(portVide)],
    { stdio: "ignore", env: { ...process.env, FM_REF: REF, FM_VIDE: "1" } }),
];
/* un Worker en toc, DANS SON PROPRE PROCESSUS : le banc passe par
   execFileSync, qui gèle sa propre boucle d'événements — un serveur logé ici
   ne répondrait jamais (constaté : le relais attendait 25 s pour rien). */
const codeW = `
const http = require("http");
const PDF_W = Buffer.from("%PDF-1.4\\n% worker de secours " + "w".repeat(1200) + "\\n%%EOF\\n", "latin1");
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/meteo/pdf") {
    res.writeHead(200, { "Content-Type": "application/pdf",
      "X-Meteo-Valide": "2026-08-28T12:00:00Z" });
    return res.end(PDF_W);
  }
  res.writeHead(404); res.end("{}");
}).listen(${portW});
`;
doubles.push(spawn(process.execPath, ["-e", codeW], { stdio: "ignore" }));
const arrete = () => { for (const d of doubles) { try { d.kill(); } catch { /* mort */ } } };
await new Promise((r) => setTimeout(r, 900));

const src = fs.readFileSync("../../supabase/functions/cartes/index.ts", "utf8");
dit(src.includes('const VERSION = "7.44";'), "le fichier porte la version 7.44");
dit(src.includes('if (q.get("sofia") === "1") return notamSofia(q);'),
    "la branche NOTAM ?sofia=1 (7.42/7.43) est toujours là");
dit(src.trimEnd().endsWith("});"),
    "et la dernière ligne est bien « }); », comme l'exige le mode d'emploi");

/* le contexte Supabase en toc ; « __ENV » se règle depuis le banc */
const stub = `
const Deno = { env: { get: (k: string) => ((globalThis as any).__ENV || {})[k] || "" },
  serve: (h: (r: Request) => Promise<Response>) => { (globalThis as any).__H = h; } };
`;
const essai = "/tmp/verif_cartes_744.ts";
const pointe = (base) => src
  .replace('const SOFIA = "https://sofia-briefing.aviation-civile.gouv.fr";',
           `const SOFIA = "${base}";`)
  .replace('const AERO = "https://aviation.meteo.fr";',
           `const AERO = "${base}";`);
fs.writeFileSync(essai, stub + pointe("http://127.0.0.1:" + port) + `
const H = (globalThis as any).__H;
const sortie: unknown[] = [];
const va = async (qs: string, env?: Record<string, string>) => {
  (globalThis as any).__ENV = env || {};
  const r = await H(new Request("https://relais.test/functions/v1/cartes?" + qs));
  const ct = r.headers.get("Content-Type") || "";
  if (/^application\\/pdf|^image\\//.test(ct)) {
    const b = new Uint8Array(await r.arrayBuffer());
    sortie.push({ qs, http: r.status, contenu: ct, octets: b.length,
      magie: String.fromCharCode(...b.slice(0, 5)),
      voie: r.headers.get("X-Cartes-Voie"), date: r.headers.get("X-Cartes-Date"),
      cors: r.headers.get("Access-Control-Allow-Origin") });
    return;
  }
  const t = await r.text();
  let j: unknown = t; try { j = JSON.parse(t); } catch { /* pas du JSON */ }
  sortie.push({ qs, http: r.status, corps: j });
};
await va("version=1");
/* la voie royale : session + préparation + postTemsi + lien frais */
await va("type=sigwx/fr/france&date=20260828120000&img=1");
await va("type=sigwx/fr/euroc&date=20260828150000&img=1");
await va("type=wintemp/fr/france/fl020&date=20260828120000&img=1");
console.log("---JSON---" + JSON.stringify(sortie));
`);
let brut = "";
try {
  brut = execFileSync(process.execPath,
    ["--experimental-strip-types", "--no-warnings", essai],
    { encoding: "utf8", timeout: 90000 });
} catch (e) {
  console.error("le relais n'a pas tourné : " + e.message
    + "\n--- sortie ---\n" + (e.stdout || "") + "\n--- erreurs ---\n" + (e.stderr || ""));
  arrete(); process.exit(1);
}
const [v, tf, te, wf] = JSON.parse(brut.split("---JSON---")[1]);

dit(v.http === 200 && v.corps.version === "7.44", "?version=1 répond 7.44 · " + v.corps.version);

/* ===== 1. LA VOIE ROYALE : LE PROTOCOLE COMPLET ================== */
/* La doublure refuse tout POST sans JSESSIONID : l'ancienne voie (posteSofia
   sans session) n'y obtient RIEN. Si ces trois cartes sortent, c'est que la
   session, la préparation et le lien frais ont réellement été joués. */
dit(tf.http === 200 && tf.magie === "%PDF-",
    "TEMSI France ?img=1 : de VRAIS octets de PDF · " + tf.octets + " o");
dit(tf.voie === "sofia-session",
    "et l'en-tête nomme la voie · " + tf.voie);
dit(tf.date === "20260828120000",
    "l'échéance servie est celle demandée · " + tf.date);
dit(tf.cors === "*", "avec CORS : l'application pourra lire les pixels");
dit(te.http === 200 && te.magie === "%PDF-" && te.date === "20260828150000",
    "TEMSI EUROC aussi, à SON échéance · " + te.date);
dit(wf.http === 200 && wf.magie === "%PDF-",
    "WINTEM France aussi (carte unique FL20-100, level=100) · " + wf.octets + " o");

/* ===== 2. SANS CATALOGUE : L'ÉCHEC SE DIT, PUIS LE WORKER ======== */
fs.writeFileSync(essai, stub + pointe("http://127.0.0.1:" + portVide) + `
const H = (globalThis as any).__H;
const sortie: unknown[] = [];
const va = async (qs: string, env?: Record<string, string>) => {
  (globalThis as any).__ENV = env || {};
  const r = await H(new Request("https://relais.test/functions/v1/cartes?" + qs));
  const ct = r.headers.get("Content-Type") || "";
  if (/^application\\/pdf/.test(ct)) {
    const b = new Uint8Array(await r.arrayBuffer());
    sortie.push({ qs, http: r.status, magie: String.fromCharCode(...b.slice(0, 5)),
      voie: r.headers.get("X-Cartes-Voie"), hote: r.headers.get("X-Cartes-Hote") });
    return;
  }
  const t = await r.text();
  let j: unknown = t; try { j = JSON.parse(t); } catch { /* pas du JSON */ }
  sortie.push({ qs, http: r.status, corps: j });
};
await va("type=sigwx/fr/france&date=20260828120000&img=1");
await va("type=sigwx/fr/france&date=20260828120000&img=1",
  { CARTES_WORKER: "http://127.0.0.1:${portW}" });
console.log("---JSON---" + JSON.stringify(sortie));
`);
try {
  brut = execFileSync(process.execPath,
    ["--experimental-strip-types", "--no-warnings", essai],
    { encoding: "utf8", timeout: 90000 });
} catch (e) {
  console.error("2e passe en échec : " + e.message + "\n" + (e.stdout || "") + (e.stderr || ""));
  arrete(); process.exit(1);
}
const [sans, avec] = JSON.parse(brut.split("---JSON---")[1]);
const corps = sans.corps || {};
dit(sans.http >= 400, "catalogue vide, sans Worker : l'échec est un échec · HTTP " + sans.http);
const essaisTxt = JSON.stringify(corps.essais || corps);
dit(/sofia-session/.test(essaisTxt),
    "le journal montre que le protocole complet A ÉTÉ tenté");
dit(/CARTES_WORKER absent/.test(essaisTxt),
    "et dit en clair qu'aucun Worker de secours n'est configuré");
dit(avec.http === 200 && avec.magie === "%PDF-" && avec.voie === "worker",
    "le MÊME appel avec CARTES_WORKER posé : la planche arrive par le Worker · "
    + avec.voie + "/" + avec.hote);

/* ===== 3. LE LOGIN NE FUIT PAS =================================== */
dit(!/login=[A-Za-z0-9]{6}/.test(brut + essaisTxt),
    "aucun login en clair dans ce qui sort du relais (liens tronqués)");

arrete();
console.log("\n=== " + ok + " OK / " + ko + " ÉCHEC ===");
process.exit(ko ? 1 : 0);
