/* test_cartes.mjs — éprouve le FICHIER COMPLET qui sera collé dans Supabase.

   test_greffe.mjs éprouvait le bloc SOFIA isolé. Ce banc-ci va plus loin : il
   charge cartes_7.43.ts EN ENTIER, récupère le vrai gestionnaire passé à
   Deno.serve, et lui envoie de vraies requêtes. Il vérifie donc aussi la ligne
   ajoutée au dispatcher, et surtout que RIEN de l'existant n'a été abîmé.

   Seule concession : la constante SOFIA est pointée sur la doublure locale,
   sinon le banc appellerait le vrai service à chaque exécution.

   node test_cartes.mjs
*/
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";

let ok = 0, ko = 0;
const dit = (b, t) => { b ? ok++ : ko++; console.log((b ? "OK    " : "ÉCHEC ") + t); };

/* la doublure dans son propre processus : execFileSync bloque celui-ci */
const port = 8861;
const doublure = spawn(process.execPath, ["faux_sofia.js", String(port)], { stdio: "ignore" });
const arrete = () => { try { doublure.kill(); } catch { /* déjà mort */ } };
await new Promise((r) => setTimeout(r, 800));

const src = fs.readFileSync("cartes_7.43.ts", "utf8");
dit(src.includes('const VERSION = "7.43";'), "le fichier porte la version 7.43");
dit(src.includes('if (q.get("sofia") === "1") return notamSofia(q);'),
    "le dispatcher porte la branche ?sofia=1");
dit(src.trimEnd().endsWith("});"),
    "et la dernière ligne est bien « }); », comme l’exige le mode d’emploi");

/* le contexte Supabase, en toc : aucun secret, aucune base */
const stub = `
const Deno = { env: { get: (_k: string) => "" },
  serve: (h: (r: Request) => Promise<Response>) => { (globalThis as any).__H = h; } };
`;
const essai = "/tmp/verif_cartes_complet.ts";
fs.writeFileSync(essai,
  stub + src.replace('const SOFIA = "https://sofia-briefing.aviation-civile.gouv.fr";',
                     `const SOFIA = "http://127.0.0.1:${port}";`) + `
const H = (globalThis as any).__H;
const sortie: unknown[] = [];
const va = async (qs: string) => {
  const r = await H(new Request("https://relais.test/functions/v1/cartes?" + qs));
  const t = await r.text();
  let j: unknown = t; try { j = JSON.parse(t); } catch { /* pas du JSON */ }
  sortie.push({ qs, http: r.status, voie: r.headers.get("X-Cartes-Sofia"),
    version: r.headers.get("X-Cartes-Version"), corps: j });
};
await va("version=1");
await va("sofia=1&route=LFPN,LFPZ");
await va("sofia=1&route=LFPN,LFPZ&essai=1");
await va("sofia=1&route=LFPN");
await va("notam=1&ad=LFPN");
await va("");
console.log("---JSON---" + JSON.stringify(sortie));
`);

let brut = "";
try {
  brut = execFileSync(process.execPath,
    ["--experimental-strip-types", "--no-warnings", essai],
    { encoding: "utf8", timeout: 90000 });
} catch (e) {
  console.error("le fichier complet n’a pas tourné : " + e.message
    + "\n--- sortie ---\n" + (e.stdout || "") + "\n--- erreurs ---\n" + (e.stderr || ""));
  arrete(); process.exit(1);
}
dit(true, "le fichier complet se charge et répond");

const [v, s, essaiD, court, auto, vide] =
  JSON.parse(brut.split("---JSON---")[1]);

/* ===== 1. LA NOUVELLE BRANCHE ===================================== */
dit(v.http === 200 && v.corps.version === "7.43",
    "?version=1 répond 7.43 · " + v.corps.version);
dit(s.http === 200 && s.corps.ok === true,
    "?sofia=1&route=LFPN,LFPZ aboutit · HTTP " + s.http);
dit(s.corps.total === 9 && s.corps.nbSofia === 9,
    "9 NOTAM extraits, le compte de SOFIA concorde · " + s.corps.total + "/" + s.corps.nbSofia);
dit(s.corps.traduits === 7, "7 sont traduits en français · " + s.corps.traduits + "/9");
/* le manque signalé : SOFIA rendait moins qu'autorouter parce que ADDeg et
   ADSur sont des tableaux de TERRAINS, pas de NOTAM */
dit(s.corps.notams.some((x) => x.ad === "LFOZ" && /TAXIWAY A FERME/.test(x.texte)),
    "le NOTAM du terrain SURVOLÉ est là (groupe ADSur)");
dit(s.corps.notams.some((x) => x.ad === "LFPT" && /AD FERME HORS HORAIRES/.test(x.texte)),
    "celui du DÉGAGEMENT aussi (groupe ADDeg)");
dit(Array.isArray(s.corps.couverts)
    && ["LFPN", "LFPZ", "LFOZ", "LFPT"].every((c) => s.corps.couverts.includes(c)),
    "et les terrains examinés par SOFIA sont rendus · " + (s.corps.couverts || []).join(" "));
const n = s.corps.notams.find((x) => x.serie === "E3550/26");
dit(!!n && n.texteFr === "PISTE 07R/25L VFR DE NUIT INTERDIT."
    && n.texteEn === "RWY 07R/25L NIGHT VFR PROHIBITED.",
    "les deux langues voyagent ensemble — la bascule FR/EN sera gratuite");
dit(!!n && n.ad === "LFPN" && n.qcode === "MRLC" && n.debut > 0,
    "et la forme interne de l’appli est respectée · " + (n && n.ad + " " + n.qcode));
dit(s.corps.notams.some((x) => x.fir_seul),
    "le bloc FIR est présent et marqué — l’appli lui fera sa place");
dit(essaiD.corps.sofia && essaiD.corps.sofia.map((x) => x.etape).join(",") === "session,preparation,pib",
    "&essai=1 montre les trois étapes · "
    + (essaiD.corps.sofia || []).map((x) => x.etape + ":" + x.http).join(" "));
dit(!JSON.stringify(s.corps).includes("JSESSIONID="),
    "aucune valeur de JSESSIONID ne sort du relais");
dit(court.http === 400 && /2 à 20 points/.test(court.corps.erreur),
    "une route trop courte est refusée proprement · " + court.http);
dit(!("notams" in court.corps),
    "et sans liste vide qui passerait pour « aucun NOTAM »");

/* ===== 2. RIEN DE L'EXISTANT N'A BOUGÉ ============================ */
dit(auto.http === 503 && /identifiants autorouter absents/.test(auto.corps.erreur),
    "?notam=1 répond toujours — ici sans secrets, donc 503 attendu · " + auto.http);
dit(vide.http === 400 && /paramètres attendus/.test(vide.corps.erreur),
    "une requête sans paramètre garde son ancien message · " + vide.http);
dit(vide.version === "7.43", "et l’en-tête de version suit partout · " + vide.version);

/* les branches de l'ancien fichier sont toutes encore routées */
for (const b of ["opsofia", "sonde", "chasse", "dates", "autorouter", "supaip",
                 "azba", "notam", "sigmet", "poste"]) {
  if (!src.includes('q.get("' + b + '")')) dit(false, "branche perdue : ?" + b);
}
dit(true, "les dix branches d’origine sont toutes encore dans le dispatcher");

arrete();
console.log("\n=== " + ok + " OK / " + ko + " ÉCHEC ===");
process.exit(ko ? 1 : 0);
