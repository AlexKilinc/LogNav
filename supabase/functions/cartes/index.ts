/* LogNavAK — relais « cartes » : sert les cartes TEMSI / WINTEM à l'application.
 *
 * Mécanisme (le même que la page SOFIA et que loxodrome) : le point d'accès
 * applicatif public de SOFIA-Briefing (POST /sofia, :operation=postTemsi ou
 * postWintem) rend pour chaque carte un lien d'image fraîchement signé ;
 * le relais le demande, va chercher l'image, et la sert à l'application.
 *
 * Appels :
 *   GET ?type=sigwx/fr/france&date=20260822090000   -> 302 vers l'image signée
 *   GET ?lien=1&type=...&date=...                   -> le lien signé, en JSON
 *   GET ?essai=1&type=...&date=...                  -> journal JSON de la voie SOFIA
 *   GET ?poste=1&op=postTemsi&zone=FRANCE           -> rejouer un POST SOFIA (diagnostic)
 *   GET ?version=1                                  -> version du code déployé
 *
 * Déploiement : Supabase > Edge Functions > fonction « cartes », coller ce
 * fichier EN ENTIER (vérifier que la dernière ligne dans l'éditeur est bien
 * « }); »), déployer, et laisser « Enforce JWT verification » DÉSACTIVÉ.
 * Aucun secret requis. Vérification : ouvrir ?version=1 -> doit répondre 7.4.
 */

const VERSION = "7.4";
const AERO = "https://aviation.meteo.fr";
const SOFIA = "https://sofia-briefing.aviation-civile.gouv.fr";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/* Un lien d'image : couche, validité, adresse complète. */
type Lien = { url: string; couche: string; date: string };

/* Déterre les adresses affiche_image.php d'un texte, quelles que soient les
   échappures (\/ des JSON, &amp; du HTML) et la forme des paramètres. */
function recolte(texte: string, origine: string): Lien[] {
  const net = texte.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/\\u0026/g, "&");
  const out: Lien[] = [];
  const re = /(?:https?:\/\/[A-Za-z0-9_.:-]+)?[A-Za-z0-9_\/.-]*affiche_image\.php\?[^"'`\s<>()\\]+/g;
  for (const brut of net.match(re) || []) {
    let u = brut;
    if (!/^https?:/.test(u)) {
      try { u = new URL(u, origine).href; } catch { continue; }
    }
    let couche = "", date = "";
    try {
      const q = new URL(u).searchParams;
      couche = (q.get("type") || q.get("layer") || "").toLowerCase();
      date = q.get("date") || q.get("echeance") || "";
    } catch { continue; }
    if (couche) out.push({ url: u, couche, date });
  }
  return out;
}

function tronque(u: string): string {
  return u.replace(/(login=[^&]{6})[^&]*/, "$1……");
}

function reponseJson(objet: unknown, statut = 200): Response {
  return new Response(JSON.stringify(objet, null, 1), {
    status: statut,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "X-Cartes-Version": VERSION,
    },
  });
}

/* Quels POST tenter pour une couche demandée. Le TEMSI est connu ; pour le
   WINTEM, la forme du champ des niveaux n'est pas documentée : on essaie des
   variantes plausibles, et la forme gagnante est mémorisée. */
let wintemGagnant: Record<string, string> | null = null;
function opsPour(type: string): { op: string; champs: Record<string, string> }[] {
  const t = type.toLowerCase();
  if (t === "sigwx/fr/france") return [{ op: "postTemsi", champs: { zone: "FRANCE" } }];
  if (t === "sigwx/fr/euroc" || t === "sigwx/eur/euroc") {
    return [{ op: "postTemsi", champs: { zone: "EUROC" } }];
  }
  const m = t.match(/^wintemp\/fr\/france\/fl(\d{3})$/);
  if (m) {
    const fl = m[1];
    const jeux: { op: string; champs: Record<string, string> }[] = [];
    /* forme confirmée en vrai le 22/08/2026 : level=020 (sans « FL ») */
    jeux.push({ op: "postWintem", champs: { zone: "FRANCE", level: fl } });
    if (wintemGagnant) {
      const c: Record<string, string> = { zone: "FRANCE" };
      for (const k of Object.keys(wintemGagnant)) c[k] = wintemGagnant[k].replace(/\d{2,3}/, fl);
      jeux.push({ op: "postWintem", champs: c });
    }
    for (const cle of ["levels", "level", "wintemLevels", "flightLevels"]) {
      for (const val of ["FL" + fl, fl, "FL" + String(Number(fl))]) {
        jeux.push({ op: "postWintem", champs: { zone: "FRANCE", [cle]: val } });
      }
    }
    return jeux.slice(0, 13);
  }
  return [];
}

/* POST vers /sofia, mémorisé 2 minutes pour ne pas marteler le service quand
   le dossier météo charge cinq cartes d'un coup. */
const memoPoste = new Map<string, { t: number; texte: string }>();
async function posteSofia(op: string, champs: Record<string, string>): Promise<string> {
  const corps = new URLSearchParams();
  corps.set(":operation", op);
  for (const k of Object.keys(champs)) corps.set(k, champs[k]);
  const cle = corps.toString();
  const su = memoPoste.get(cle);
  if (su && Date.now() - su.t < 120000) return su.texte;
  const r = await fetch(SOFIA + "/sofia", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Referer": SOFIA + "/sofia/pages/" + (op === "postWintem" ? "meteosearchwintem" : "meteosearchtemsi") + ".html",
      "Origin": SOFIA,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
    },
    body: cle,
    redirect: "follow",
  });
  const texte = await r.text();
  if (r.ok) memoPoste.set(cle, { t: Date.now(), texte });
  return texte;
}

async function viaSofia(type: string, date: string, journal: Record<string, unknown>[]): Promise<Lien | null> {
  for (const jeu of opsPour(type)) {
    let texte = "";
    try { texte = await posteSofia(jeu.op, jeu.champs); } catch (e) {
      journal.push({ op: jeu.op, champs: jeu.champs, erreur: String(e).slice(0, 100) });
      continue;
    }
    const liens = recolte(texte, SOFIA + "/sofia/pages/");
    const entree: Record<string, unknown> = { op: jeu.op, champs: jeu.champs, liens: liens.length };
    if (!liens.length) entree.apercu = texte.slice(0, 160);
    journal.push(entree);
    if (!liens.length) continue;
    if (jeu.op === "postWintem") wintemGagnant = jeu.champs;
    /* la couche demandée à la validité la plus proche ; sinon le premier lien */
    const cible = Number((date || "0").padEnd(14, "0"));
    const dispo = liens.filter((l) => l.couche === type);
    const tri = (dispo.length ? dispo : liens).sort((a, b) =>
      Math.abs(Number(a.date || "0") - cible) - Math.abs(Number(b.date || "0") - cible));
    /* l'image vit chez Météo-France : le lien signé, posé sur l'hôte AERO —
       c'est le navigateur du pilote qui ira la chercher (redirection), car
       aviation.meteo.fr refuse les adresses IP de centres de données. */
    const chemin = tri[0].url.replace(/^https?:\/\/[^/]+/, "");
    return { url: AERO + chemin, couche: tri[0].couche, date: tri[0].date };
  }
  return null;
}

/* Mode poste (diagnostic) : rejouer un POST applicatif SOFIA à la main.
   Tous les paramètres (hors poste/op/cible) deviennent des champs du POST. */
async function poste(q: URLSearchParams): Promise<Response> {
  const corps = new URLSearchParams();
  corps.set(":operation", q.get("op") || "postTemsi");
  q.forEach((v, k) => { if (!["poste", "op", "cible"].includes(k)) corps.set(k, v); });
  const cible = q.get("cible") || SOFIA + "/sofia";
  try {
    const r = await fetch(cible, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Referer": SOFIA + "/sofia/pages/meteosearchtemsi.html",
        "Origin": SOFIA,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
      },
      body: corps.toString(),
      redirect: "follow",
    });
    const ct = r.headers.get("Content-Type") || "";
    const texte = await r.text();
    const liens = recolte(texte, cible);
    return reponseJson({
      cible, envoye: corps.toString(), http: r.status, contenu: ct, octets: texte.length,
      liens: liens.map((l) => ({ couche: l.couche, date: l.date, url: tronque(l.url) })),
      apercu: texte.slice(0, 3000),
    });
  } catch (e) {
    return reponseJson({ cible, envoye: corps.toString(), erreur: String(e).slice(0, 160) });
  }
}

Deno.serve(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  if (q.get("version") === "1") return reponseJson({ version: VERSION });
  if (q.get("poste") === "1") return poste(q);
  const type = (q.get("type") || q.get("layer") || "").toLowerCase();
  const date = (q.get("date") || q.get("echeance") || "").replace(/\D/g, "");
  if (!type || !date) {
    return reponseJson({ erreur: "paramètres attendus : type (ex. sigwx/fr/france) et date (AAAAMMJJHH0000)", version: VERSION }, 400);
  }
  const journal: Record<string, unknown>[] = [];
  let lien: Lien | null = null;
  try { lien = await viaSofia(type, date, journal); } catch (e) {
    journal.push({ erreur: String(e).slice(0, 160) });
  }
  if (q.get("essai") === "1" || q.get("debug") === "1") {
    return reponseJson({ demande: { type, date }, version: VERSION,
      lien: lien ? tronque(lien.url) : null, sofia: journal });
  }
  if (q.get("lien") === "1") {
    return lien ? reponseJson({ url: lien.url, date: lien.date })
      : reponseJson({ erreur: "aucun lien signé obtenu", sofia: journal }, 404);
  }
  if (lien) {
    return new Response(null, { status: 302, headers: {
      "Location": lien.url,
      "Cache-Control": "private, max-age=240",
      "Access-Control-Allow-Origin": "*",
      "X-Cartes-Version": VERSION,
      "X-Cartes-Voie": "redirection",
      "X-Cartes-Date": lien.date,
    } });
  }
  return reponseJson({ erreur: "aucun lien signé obtenu pour cette couche", demande: { type, date }, sofia: journal }, 404);
});
