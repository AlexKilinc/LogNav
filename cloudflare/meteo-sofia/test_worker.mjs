/* test_worker.mjs — le Worker complet contre la doublure stricte de SOFIA et
   d'aviation.meteo.fr (poc/temsi_wintem/faux_meteo.js).

   La doublure n'est pas complaisante : POST sans JSESSIONID -> 403, réponse de
   préparation vide, double JSON, expiration==date, lien relatif au login
   éphémère, « No content » sur zone inconnue. Un Worker qui passe ici a
   appliqué la note à la lettre.

     node test_worker.mjs
*/
import { spawn } from "node:child_process";

let ok = 0, ko = 0;
const dit = (b, t) => { b ? ok++ : ko++; console.log((b ? "OK    " : "ÉCHEC ") + t); };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/* une doublure par scénario, chacune sur son port et avec ses options */
const lance = (port, env = {}) => spawn(process.execPath,
  ["../../poc/temsi_wintem/faux_meteo.js", String(port)],
  { stdio: "ignore", env: { ...process.env, ...env } });

const REF = "2026-08-28T13:00:00Z";   /* référence -> échéances 09/12/15/18 */
const doublure = lance(8871, { FM_REF: REF });
const doublureVide = lance(8872, { FM_REF: REF, FM_VIDE: "1" });
const doublureHtml = lance(8873, { FM_REF: REF, FM_HTML: "1" });
await dors(900);

const mod = await import("./src/index.js");
const worker = mod.default;
const envDe = (port) => ({ SOFIA_URL: "http://127.0.0.1:" + port,
  METEO_URL: "http://127.0.0.1:" + port });
const va = (chemin, port = 8871) =>
  worker.fetch(new Request("https://w.test" + chemin), envDe(port));

try {
  /* ===== 1. LE CATALOGUE, CLASSÉ ================================= */
  let r = await va("/api/meteo/catalog?product=temsi-france&reference=" + REF);
  let j = await r.json();
  dit(r.status === 200, "catalogue TEMSI France : HTTP " + r.status);
  dit(j.source === "SOFIA", "servi par SOFIA · " + j.source);
  dit(j.courante && j.courante.validAt === "2026-08-28T12:00:00Z",
      "la carte EN VIGUEUR à 13:00Z est celle de 12:00Z · "
      + (j.courante && j.courante.validAt));
  dit(j.futures.length === 2 && j.futures[0].validAt === "2026-08-28T15:00:00Z",
      "deux À VENIR, la première à 15:00Z");
  dit(j.perimees.length === 1, "une périmée (09:00Z)");
  const brut = JSON.stringify(j);
  dit(!/login=[^…&\"]{4}/.test(brut) || /login=…/.test(brut),
      "le login éphémère ne sort JAMAIS du Worker (liens masqués)");
  dit(j.courante.lienMasque && /login=/.test(j.courante.lienMasque),
      "mais le lien masqué montre bien qu'il en fallait un");

  /* ===== 2. LE PDF, VÉRIFIÉ ====================================== */
  r = await va("/api/meteo/pdf?product=temsi-france&reference=" + REF);
  const buf = new Uint8Array(await r.arrayBuffer());
  dit(r.status === 200, "PDF sans échéance : HTTP " + r.status);
  dit(String.fromCharCode(...buf.slice(0, 5)) === "%PDF-",
      "et ce sont de VRAIS octets de PDF · " + buf.length + " o");
  dit(r.headers.get("X-Meteo-Valide") === "2026-08-28T12:00:00Z"
      && r.headers.get("X-Meteo-Statut") === "en vigueur",
      "l'en-tête dit quelle carte et pourquoi · "
      + r.headers.get("X-Meteo-Valide") + " (" + r.headers.get("X-Meteo-Statut") + ")");
  dit(r.headers.get("Access-Control-Allow-Origin") === "*",
      "CORS ouvert : l'application peut lire les octets");
  dit((r.headers.get("X-Cartes-Date") || "").startsWith("20260828120"),
      "et l'en-tête X-Cartes-Date parle la langue du relais");

  r = await va("/api/meteo/pdf?product=temsi-france&valid=2026-08-28T15:00:00Z");
  dit(r.status === 200 && r.headers.get("X-Meteo-Statut") === "demandée",
      "une échéance PRÉCISE se demande aussi · 15:00Z, statut « demandée »");

  r = await va("/api/meteo/pdf?product=temsi-france&valid=2026-08-28T13:37:00Z");
  j = await r.json();
  dit(r.status === 404 && Array.isArray(j.disponibles) && j.disponibles.length === 4,
      "une échéance ABSENTE rend 404 et la liste des disponibles · " + r.status);

  /* ===== 3. LES TROIS PRODUITS =================================== */
  for (const p of ["temsi-euroc", "wintem-france"]) {
    r = await va("/api/meteo/pdf?product=" + p + "&reference=" + REF);
    const b2 = new Uint8Array(await r.arrayBuffer());
    dit(r.status === 200 && String.fromCharCode(...b2.slice(0, 5)) === "%PDF-",
        p + " : un vrai PDF aussi · " + b2.length + " o");
  }
  r = await va("/api/meteo/pdf?product=temsi-belgique");
  dit(r.status === 400, "un produit inconnu rend 400, pas un silence");

  /* ===== 4. LES PANNES SE DISENT ================================= */
  r = await va("/api/meteo/catalog?product=temsi-france&reference=" + REF, 8872);
  j = await r.json();
  dit(r.status === 502 && /aucun catalogue/.test(j.erreur || ""),
      "catalogue vide -> 502 et le motif en clair · " + (j.erreur || "").slice(0, 48));
  r = await va("/api/meteo/pdf?product=temsi-france&reference=" + REF, 8873);
  j = await r.json();
  dit(r.status === 502 && /n'est pas un PDF/.test(j.erreur || ""),
      "un 200 « application/pdf » qui porte du HTML est DÉMASQUÉ · "
      + (j.erreur || "").slice(0, 56));

  /* ===== 5. LA PORTE D'ENTRÉE ==================================== */
  r = await va("/");
  j = await r.json();
  dit(r.status === 200 && (j.produits || []).length === 3,
      "la racine dit ce que le Worker sert · " + (j.produits || []).join(", "));
} finally {
  for (const d of [doublure, doublureVide, doublureHtml]) { try { d.kill(); } catch { /* mort */ } }
}
console.log("\n=== " + ok + " OK / " + ko + " ÉCHEC ===");
process.exit(ko ? 1 : 0);
