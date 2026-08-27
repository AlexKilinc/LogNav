/* test_greffe.mjs — éprouve la greffe telle qu'elle sera collée dans « cartes ».

   La greffe est écrite pour vivre au milieu du relais : elle s'appuie sur ses
   constantes (VERSION, UA, SOFIA) et sur ses aides (reponseJson, memoFrais,
   memoRange). Ce banc reconstitue exactement ce contexte, pointe SOFIA sur la
   doublure locale, et fait tourner notamSofia() comme le fera Supabase.

   node test_greffe.mjs
*/
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";

let ok = 0, ko = 0;
const dit = (b, t) => { b ? ok++ : ko++; console.log((b ? "OK    " : "ÉCHEC ") + t); };

/* La doublure vit dans SON PROPRE processus : execFileSync bloque la boucle
   du parent, et une doublure hébergée ici ne pourrait plus répondre — le
   banc s'attendrait lui-même. */
const port = 8859;
const ORIGINE = "http://127.0.0.1:" + port;
const doublure = spawn(process.execPath, ["faux_sofia.js", String(port)],
  { stdio: "ignore", detached: false });
const arrete = () => { try { doublure.kill(); } catch { /* déjà mort */ } };
await new Promise((r) => setTimeout(r, 800));

/* ---- le contexte du relais, reconstitué à l'identique ---- */
const contexte = `
const VERSION = "7.42";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const SOFIA = ${JSON.stringify(ORIGINE)};
function reponseJson(objet: unknown, statut = 200): Response {
  return new Response(JSON.stringify(objet, null, 1), { status: statut,
    headers: { "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*", "X-Cartes-Version": VERSION } });
}
/* la mémoire partagée du relais : ici en mémoire vive, le comportement est le même */
const base = new Map<string, { valeur: string; fin: number }>();
async function memoFrais(cle: string) {
  const l = base.get(cle); if (!l) return null;
  const reste = l.fin - Date.now(); if (reste <= 0) return null;
  return { valeur: l.valeur, reste };
}
async function memoRange(cle: string, corps: string, duree: number) {
  base.set(cle, { valeur: corps, fin: Date.now() + duree });
}
`;

/* la greffe, débarrassée de son mode d'emploi en tête */
const brut = fs.readFileSync("greffe_cartes_7.42.ts", "utf8");
const debut = brut.indexOf("/* ================== NOTAM via SOFIA-Briefing");
if (debut < 0) { console.error("bloc introuvable dans la greffe"); process.exit(1); }

const fichier = "/tmp/essai_greffe.ts";
fs.writeFileSync(fichier, contexte + brut.slice(debut) + `
/* ---- ce que le banc interroge ---- */
const sortie: unknown[] = [];
const appelle = async (qs: string) => {
  const r = await notamSofia(new URLSearchParams(qs));
  sortie.push({ http: r.status, voie: r.headers.get("X-Cartes-Sofia"),
    corps: JSON.parse(await r.text()) });
};
await appelle("route=LFPN,LFPZ");
await appelle("route=LFPN,LFPZ");                 // doit sortir de la mémoire
await appelle("route=LFPN,LFPZ&essai=1");         // doit contourner la mémoire
await appelle("route=LFPN");                      // route trop courte
await appelle("route=LFPN,LF PZ");                // point invalide
console.log("---JSON---" + JSON.stringify(sortie));
`);

let brutSortie = "";
try {
  brutSortie = execFileSync(process.execPath,
    ["--experimental-strip-types", "--no-warnings", fichier],
    { encoding: "utf8", timeout: 60000 });
} catch (e) {
  console.error("la greffe n'a pas tourné : " + e.message
    + "\n--- sortie ---\n" + (e.stdout || "") + "\n--- erreurs ---\n" + (e.stderr || ""));
  arrete(); process.exit(1);
}
dit(true, "la greffe se charge et s’exécute telle quelle (types TypeScript compris)");

const r = JSON.parse(brutSortie.split("---JSON---")[1]);
const [a, b, c, court, invalide] = r;

/* ===== 1. LA SÉQUENCE COMPLÈTE ==================================== */
dit(a.http === 200 && a.corps.ok === true, "la requête aboutit · HTTP " + a.http);
dit(a.voie === "frais", "et elle est allée à la source · " + a.voie);
dit(a.corps.pibUid === "LFYN2608272364", "pibUid · " + a.corps.pibUid);
dit(a.corps.route.join(",") === "LFPN,LFPZ", "la route est reprise · " + a.corps.route.join(","));
dit(a.corps.total === 7 && a.corps.nbSofia === 7,
    "les 7 NOTAM sont extraits et le compte de SOFIA concorde · "
    + a.corps.total + " / " + a.corps.nbSofia);
/* la doublure porte exprès deux NOTAM sans traduction — le taxiway C et le
   NOTAM FIR — pour éprouver le repli sur l'anglais */
dit(a.corps.traduits === 5,
    "5 des 7 sont traduits, 2 ne le sont pas · " + a.corps.traduits + "/7");

/* ===== 2. LA FORME INTERNE DE L'APPLI ============================= */
const n = a.corps.notams.find((x) => x.serie === "E3550/26");
dit(!!n, "le VRAI numéro est reconstitué en forme OACI · E3550/26");
dit(n && n.idSofia === "400000051804734" && n.serie !== n.idSofia,
    "l’identifiant interne reste à part · " + (n && n.idSofia));
dit(n && n.texteFr === "PISTE 07R/25L VFR DE NUIT INTERDIT."
    && n.texteEn === "RWY 07R/25L NIGHT VFR PROHIBITED.",
    "les DEUX langues voyagent ensemble — la bascule FR/EN ne coûtera rien");
dit(n && n.texte === n.texteFr, "et le texte par défaut est le français");
const sansTrad = a.corps.notams.find((x) => x.serie === "E2457/26");
dit(sansTrad && sansTrad.traduit === false && sansTrad.texte === "TAXIWAY C CLOSED.",
    "un NOTAM non traduit retombe sur l’anglais plutôt que de rester vide");
dit(n && n.ad === "LFPN" && n.qcode === "MRLC" && n.trafic === "IV",
    "ad, qcode et trafic sont posés · " + (n && n.ad + " " + n.qcode + " " + n.trafic));
dit(n && Math.abs(n.lat - 48.75) < 0.01 && Math.abs(n.lon - 2.1167) < 0.01,
    "« 4845N00207E » est décodé en degrés · " + (n && n.lat.toFixed(3) + " / " + n.lon.toFixed(3)));
dit(n && n.debut > 0 && n.fin > n.debut, "les validités sont en secondes epoch");
dit(n && n.src === "SOFIA", "la source est marquée — l’appli s’en sert pour la bascule de langue");
const fir = a.corps.notams.find((x) => x.fir_seul);
dit(!!fir && fir.ad === "LFFF",
    "le NOTAM du bloc FIR est marqué fir_seul et porte sa FIR · " + (fir && fir.ad));

/* ===== 3. LA MÉMOIRE ============================================== */
dit(b.voie === "memo" || b.voie === "base",
    "la seconde requête identique sort de la mémoire · " + b.voie);
dit(b.corps.releveA === a.corps.releveA,
    "et garde l’heure du relevé d’origine — passer par la mémoire ne rajeunit rien");
dit(c.voie === "frais" && Array.isArray(c.corps.sofia),
    "&essai=1 contourne la mémoire et rend le détail des étapes · "
    + c.corps.sofia.map((s) => s.etape + ":" + s.http).join(" "));
dit(c.corps.sofia.map((s) => s.etape).join(",") === "session,preparation,pib",
    "les trois étapes sont jouées dans l’ordre · "
    + c.corps.sofia.map((s) => s.etape).join(" → "));
dit(!JSON.stringify(c.corps).includes("JSESSIONID="),
    "aucune valeur de JSESSIONID ne fuit dans la réponse");
dit(c.corps.sofia.every((s) => Array.isArray(s.temoins)),
    "la trace ne journalise que les NOMS de témoins");

/* ===== 4. LES REFUS SONT CONTRÔLÉS ================================ */
dit(court.http === 400 && /2 à 20 points/.test(court.corps.erreur),
    "une route trop courte est refusée avant tout appel · " + court.http);
dit(invalide.http === 400 && /invalide/.test(invalide.corps.erreur),
    "un point mal formé aussi · « " + invalide.corps.erreur + " »");
dit(!("notams" in court.corps) && !("notams" in invalide.corps),
    "et jamais avec une liste vide qui passerait pour « aucun NOTAM »");

arrete();
console.log("\n=== " + ok + " OK / " + ko + " ÉCHEC ===");
process.exit(ko ? 1 : 0);
