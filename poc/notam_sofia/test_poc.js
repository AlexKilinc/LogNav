/* test_poc.js — banc du POC SOFIA.

   Ce banc ne prouve PAS que le vrai SOFIA répond : l'accès sortant vers
   sofia-briefing.aviation-civile.gouv.fr est refusé par la politique réseau
   de cette session (403 au CONNECT). Il prouve autre chose, et c'est la
   moitié qui est démontrable ici : que le client parle EXACTEMENT le
   protocole décrit dans le document, et qu'il tombe juste sur chacun des
   pièges du § 7 — dont chacun est armé dans la doublure.

   node test_poc.js
*/
const { recuperePib, corpsBrut, isoUtcSecondes, valideRoute, aplatis } = require("./sofia_client");
const faux = require("./faux_sofia");

let ok = 0, ko = 0;
const dit = (b, t) => { b ? ok++ : ko++; console.log((b ? "OK    " : "ÉCHEC ") + t); };
async function echoue(fn, motif, titre) {
  try { await fn(); dit(false, titre + " — aucune erreur levée"); }
  catch (e) { dit(motif.test(String(e.message)), titre + " · « " + e.message + " »"); }
}

(async () => {
  const port = await faux.demarre(0);
  const origin = "http://127.0.0.1:" + port;
  console.log("doublure SOFIA sur " + origin + "\n");

  /* ===== 1. LE CORPS EST CONFORME AU TEST POWERSHELL VALIDÉ ========== */
  const corps = corpsBrut([
    [":operation", "postsaveinsessionprepa"],
    ["valid_from", "2026-08-26T14:46:11Z"],
    ["route[]", "LFPN"], ["route[]", "LFPZ"],
    ["target", "#aside-target"], ["href", "/sofia/pages/notamroute.html"],
  ]);
  dit(corps.startsWith("%3Aoperation=postsaveinsessionprepa"),
      "« :operation » est en tête et son deux-points est encodé %3A");
  dit((corps.match(/route%5B%5D=/g) || []).length === 2,
      "route[] est encodé route%5B%5D et répété une fois par point");
  dit(corps.includes("valid_from=2026-08-26T14%3A46%3A11Z"),
      "valid_from est encodé comme EscapeDataString du PowerShell");
  dit(corps.includes("target=%23aside-target") && corps.includes("href=%2Fsofia%2Fpages%2Fnotamroute.html"),
      "target et href sont encodés %23 et %2F");
  dit(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(isoUtcSecondes(new Date())),
      "valid_from par défaut : UTC, secondes, terminé par Z, sans millisecondes");

  /* ===== 2. LA SÉQUENCE COMPLÈTE PASSE ============================== */
  const r = await recuperePib({ route: ["LFPN", "LFPZ"], origin });
  dit(r.ok === true, "la séquence complète aboutit");
  const etapes = r.trace.map((t) => t.etape);
  dit(etapes.join(",") === "session,preparation,pib",
      "les trois étapes sont jouées dans l'ordre · " + etapes.join(" → "));
  dit(r.trace.every((t) => t.code === 200), "et toutes répondent 200");
  dit(r.trace[0].cookiesRecus.includes("JSESSIONID"),
      "la première étape reçoit bien un JSESSIONID");

  /* ===== 3. LE RÉSULTAT EST CELUI DU § 6 DU DOCUMENT ================= */
  dit(r.pib.pibUid === "NW432608262157", "pibUid · " + r.pib.pibUid);
  dit(r.pib.validFrom === "2026-08-26T14:13:56.000Z", "validFrom · " + r.pib.validFrom);
  dit(r.pib.validTo === "2026-08-27T02:13:00.000Z", "validTo · " + r.pib.validTo);
  dit(r.pib.listnotams.ADDep.code === "LFPN" && /PARIS SACLAY/.test(r.pib.listnotams.ADDep.name),
      "ADDep · " + r.pib.listnotams.ADDep.code + " " + r.pib.listnotams.ADDep.name);
  dit(r.pib.listnotams.ADDes.code === "LFPZ" && /SAINT CYR/.test(r.pib.listnotams.ADDes.name),
      "ADDes · " + r.pib.listnotams.ADDes.code + " " + r.pib.listnotams.ADDes.name);

  /* ===== 4. LE DOUBLE DÉCODAGE EST BIEN FAIT ======================== */
  const direct = await fetch(origin + "/sofia/pages/notamform.html");
  const sid = (direct.headers.get("set-cookie") || "").match(/JSESSIONID=([^;]+)/)[1];
  const commun = "&valid_from=2026-08-27T10%3A00%3A00Z&duration=1200&traffic=VI&fl_lower=0"
    + "&fl_upper=999&width=15&radiusAD=30&route%5B%5D=LFPN&route%5B%5D=LFPZ"
    + "&uuid=" + crypto.randomUUID() + "&isFromSofia=true&operation=postNarrowRoutePibRequest"
    + "&target=%23aside-target&href=%2Fsofia%2Fpages%2Fnotamroute.html&typeVol=N"
    + "&departure_date=27-08-2026&departure_time=1000&lang=fr&routeVal=false";
  const ent = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Cookie: "JSESSIONID=" + sid };
  await fetch(origin + "/sofia", { method: "POST", headers: ent, body: "%3Aoperation=postsaveinsessionprepa" + commun });
  const rep = await fetch(origin + "/sofia", { method: "POST", headers: ent, body: "%3Aoperation=postNarrowRoutePibRequest" + commun });
  const externe = await rep.json();
  dit(typeof externe["status.message"] === "string",
      "status.message est une CHAÎNE, pas un objet — le premier décodage ne suffit pas");
  dit(typeof JSON.parse(externe["status.message"]).listnotams === "object",
      "et son second décodage donne listnotams");

  /* ===== 5. CHACUN DES PIÈGES DU § 7 ================================ */
  await echoue(() => recuperePib({ route: ["LFPN"], origin }),
    /2 à 20 points/, "piège : route à un seul point refusée avant tout appel réseau");
  await echoue(() => recuperePib({ route: ["LFPN", "LF PZ!"], origin }),
    /point de route invalide/, "piège : point de route mal formé refusé");
  await echoue(() => recuperePib({ route: ["LFPN", "LFPZ"], origin, validFrom: "2026-08-27T10:00:00" }),
    /terminer par Z/, "piège : valid_from sans Z refusé (§ 7, dates/UTC)");
  await echoue(() => recuperePib({ route: ["LFPN", "LFPZ"], origin, sansPreparation: true }),
    /HTTP 409/, "piège : PIB sans postsaveinsessionprepa rejeté par le serveur (§ 11.9)");

  /* route[] agrégé — l'échec Hashtable PowerShell, reproduit à la main */
  const d2 = await fetch(origin + "/sofia/pages/notamform.html");
  const sid2 = (d2.headers.get("set-cookie") || "").match(/JSESSIONID=([^;]+)/)[1];
  const agrege = commun.replace("route%5B%5D=LFPN&route%5B%5D=LFPZ", "route%5B%5D=LFPN%2CLFPZ");
  const rAg = await fetch(origin + "/sofia", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Cookie: "JSESSIONID=" + sid2 },
    body: "%3Aoperation=postsaveinsessionprepa" + agrege });
  dit(rAg.status === 500,
      "piège : route[] agrégé en « LFPN,LFPZ » -> HTTP " + rAg.status + " (l'échec Hashtable du § 7)");

  /* session absente */
  const rSansSid = await fetch(origin + "/sofia", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "%3Aoperation=postsaveinsessionprepa" + commun });
  dit(rSansSid.status === 403,
      "piège : sans JSESSIONID -> HTTP " + rSansSid.status + " (l'UUID ne remplace pas la session)");

  /* le JSESSIONID est bien conservé entre les deux POST */
  const cookiesTrace = r.trace.filter((t) => t.etape !== "session")
    .every((t) => !t.cookiesRecus || !t.cookiesRecus.length);
  dit(cookiesTrace, "aucune nouvelle session n'est ouverte entre la préparation et le PIB");

  /* ===== 6. AUCUN SECRET NE FUIT DANS LA TRACE ====================== */
  const j = JSON.stringify(r);
  dit(!/JSESSIONID=/.test(j), "la réponse ne contient aucune valeur de JSESSIONID");
  dit(!/"Cookie"/.test(j), "ni aucun en-tête Cookie");
  dit(r.trace.every((t) => !("cookieValeur" in t)), "la trace ne journalise que les NOMS de cookies");

  /* ===== 7. L'APLATISSAGE, TOLÉRANT À LA FORME RÉELLE =============== */
  dit(r.notams.length === 5, "les 5 NOTAM du § 6 sont extraits · " + r.notams.length);
  dit(r.notams.some((n) => n.id === "E 3550/26" && /NIGHT VFR PROHIBITED/.test(n.texte)),
      "dont E 3550/26 « RWY 07R/25L NIGHT VFR PROHIBITED. »");
  dit(r.notams.filter((n) => n.terrain === "LFPZ").length === 4,
      "et les 4 NOTAM LFPZ sont rattachés au bon terrain");
  /* forme différente : l'aplatissage ne doit pas s'effondrer */
  const autre = aplatis({ ADDep: { code: "LFXX", zones: { autre_cat: [{ id: "A 0001/26", text: "TEST." }] } } });
  dit(autre.length === 1 && autre[0].terrain === "LFXX",
      "l'aplatissage tient sur une arborescence différente (la forme réelle n'est pas documentée)");
  dit(JSON.stringify(r.pib).length > 0, "et le JSON brut du PIB est conservé à côté");

  /* ===== 8. CONTRÔLE DE COHÉRENCE ================================== */
  const r2 = await recuperePib({ route: ["LFPT", "LFOZ"], origin });
  dit(r2.pib.listnotams.ADDep.code === "LFPT" && r2.pib.listnotams.ADDes.code === "LFOZ",
      "une autre route est acceptée et renvoie les bons terrains · LFPT → LFOZ");
  const r3 = await recuperePib({ route: ["LFPN", "LFOZ", "LFPZ"], origin });
  dit(r3.trace.length === 3 && r3.pib.listnotams.ADDep.code === "LFPN",
      "une route à point tournant passe (§ 11.4, répétitions route[])");

  /* ===== 9. VALIDATION LOCALE ====================================== */
  dit(valideRoute([" lfpn ", "lfpz"]).join(",") === "LFPN,LFPZ", "la route est normalisée en majuscules");
  try { valideRoute(new Array(21).fill("LFPN")); dit(false, "21 points refusés"); }
  catch (e) { dit(/2 à 20/.test(e.message), "21 points refusés · « " + e.message + " »"); }

  await faux.arrete();
  console.log("\n=== " + ok + " OK / " + ko + " ÉCHEC ===");
  process.exit(ko ? 1 : 0);
})();
