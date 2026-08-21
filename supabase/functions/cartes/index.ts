/* LogNavAK — relais « cartes » : sert les cartes TEMSI / WINTEM à l'application.
 *
 * Mécanisme (le même que la page SOFIA et que loxodrome) : le point d'accès
 * applicatif public de SOFIA-Briefing (POST /sofia, :operation=postTemsi ou
 * postWintem) rend pour chaque carte un lien d'image fraîchement signé ;
 * le relais le demande, va chercher l'image, et la sert à l'application.
 *
 * Appels :
 *   GET ?type=sigwx/fr/france&date=20260822090000   -> l'image
 *   GET ?essai=1&type=...&date=...                  -> journal JSON de la voie SOFIA
 *   GET ?poste=1&op=postTemsi&zone=FRANCE           -> rejouer un POST SOFIA (diagnostic)
 *   GET ?version=1                                  -> version du code déployé
 *
 * Déploiement : Supabase > Edge Functions > fonction « cartes », coller ce
 * fichier EN ENTIER (vérifier que la dernière ligne dans l'éditeur est bien
 * « }); »), déployer, et laisser « Enforce JWT verification » DÉSACTIVÉ.
 * Aucun secret requis. Vérification : ouvrir ?version=1 -> doit répondre 7.3.
 */

const VERSION = "7.3";
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

async function viaSofia(type: string, date: string, journal: Record<string, unknown>[]): Promise<Response | null> {
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
    const lien = tri[0];
    /* l'image : d'abord sur l'hôte SOFIA (comme la page), sinon chez
       Météo-France ; si l'hôte répond une page HTML d'habillage, on y cherche
       la vraie adresse de l'image et on la suit. */
    const chemin = lien.url.replace(/^https?:\/\/[^/]+/, "");
    const referer = SOFIA + "/sofia/pages/" +
      (jeu.op === "postWintem" ? "meteosearchwintem" : "meteosearchtemsi") + ".html";
    for (const hote of [SOFIA, AERO]) {
      const brut = await chercheImage(hote + chemin, referer, journal, 0);
      if (brut) {
        journal.push({ servie: brut.tampon.byteLength + " octets" });
        return new Response(brut.tampon, { headers: {
          "Content-Type": brut.contenu,
          "Cache-Control": "public, max-age=600",
          "Access-Control-Allow-Origin": "*",
          "X-Cartes-Version": VERSION,
          "X-Cartes-Voie": "SOFIA " + jeu.op,
          "X-Cartes-Date": lien.date,
        } });
      }
    }
  }
  return null;
}

/* Les adresses d'images qu'une page HTML d'habillage peut contenir —
   triées : ce qui ressemble à une carte d'abord, les logos écartés. */
function candidatsDansHtml(html: string, base: string): string[] {
  const out: string[] = [];
  for (const l of recolte(html, base)) out.push(l.url);
  const re = /(?:src|href)=["']([^"']+\.(?:png|gif|jpe?g)[^"']*|[^"']*affiche[^"']*\?[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    try { out.push(new URL(m[1], base).href); } catch { /* ignore */ }
  }
  const note = (u: string) =>
    (/logo|icon|favicon|marianne|bandeau|banner|header|footer/i.test(u) ? -2 : 0) +
    (/wintem|temsi|sigwx|carte|chart|meteo|echeance|affiche/i.test(u) ? 2 : 0) +
    (/\d{10,14}/.test(u) ? 1 : 0);
  return [...new Set(out)].sort((a, b) => note(b) - note(a));
}

/* Une carte pèse des dizaines de kilo-octets ; un logo, quelques-uns. */
const IMAGE_MIN = 15000;
type Image = { tampon: ArrayBuffer; contenu: string };
async function chercheImage(u: string, referer: string, journal: Record<string, unknown>[], profondeur: number):
  Promise<Image | null> {
  let pisAller: Image | null = null;
  try {
    const r = await fetch(u, {
      headers: { "User-Agent": UA, "Referer": referer,
        "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8" },
      redirect: "follow",
    });
    const ct = r.headers.get("Content-Type") || "";
    if (r.ok && /^image\//i.test(ct)) {
      const tampon = await r.arrayBuffer();
      if (tampon.byteLength >= IMAGE_MIN) return { tampon, contenu: ct };
      journal.push({ image: u.slice(0, 90) + "…", petite: tampon.byteLength + " octets (vignette ?)" });
      pisAller = { tampon, contenu: ct };
    } else {
      const texte = await r.text();
      journal.push({ image: u.slice(0, 90) + "…", http: r.status, contenu: ct, apercu: texte.slice(0, 220) });
      if (profondeur < 1 && r.ok && /html/i.test(ct)) {
        for (const c of candidatsDansHtml(texte, u).slice(0, 5)) {
          if (c === u) continue;
          const ri = await chercheImage(c, u, journal, profondeur + 1);
          if (ri && ri.tampon.byteLength >= IMAGE_MIN) return ri;
          if (ri && (!pisAller || ri.tampon.byteLength > pisAller.tampon.byteLength)) pisAller = ri;
        }
      }
    }
  } catch (e) { journal.push({ image: u.slice(0, 90), erreur: String(e).slice(0, 100) }); }
  return pisAller;
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

/* Mode page (diagnostic) : montrer la page d'habillage d'une carte et le
   classement des adresses d'images qu'on y lit. */
async function pageMode(type: string, date: string): Promise<Response> {
  for (const jeu of opsPour(type)) {
    const texte = await posteSofia(jeu.op, jeu.champs).catch((e) => String(e));
    const liens = recolte(texte, SOFIA + "/sofia/pages/");
    if (!liens.length) continue;
    const chemin = liens[0].url.replace(/^https?:\/\/[^/]+/, "");
    const r = await fetch(SOFIA + chemin, {
      headers: { "User-Agent": UA, "Referer": SOFIA + "/sofia/pages/meteosearchtemsi.html",
        "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8" },
      redirect: "follow",
    });
    const ct = r.headers.get("Content-Type") || "";
    if (/^image\//i.test(ct)) {
      const t = await r.arrayBuffer();
      return reponseJson({ note: "l'adresse signée rend directement une image", contenu: ct, octets: t.byteLength });
    }
    const html = await r.text();
    return reponseJson({
      lien: tronque(liens[0].url), http: r.status, contenu: ct, octets: html.length,
      candidats: candidatsDansHtml(html, SOFIA + chemin).map(tronque),
      habillage: html.slice(0, 3500),
    });
  }
  return reponseJson({ erreur: "aucun lien signé obtenu pour cette couche" }, 404);
}

Deno.serve(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  if (q.get("version") === "1") return reponseJson({ version: VERSION });
  if (q.get("poste") === "1") return poste(q);
  if (q.get("page") === "1") {
    const t = (q.get("type") || "").toLowerCase();
    const d = (q.get("date") || "").replace(/\D/g, "");
    if (!t || !d) return reponseJson({ erreur: "page=1 demande type et date" }, 400);
    return pageMode(t, d);
  }
  const type = (q.get("type") || q.get("layer") || "").toLowerCase();
  const date = (q.get("date") || q.get("echeance") || "").replace(/\D/g, "");
  if (!type || !date) {
    return reponseJson({ erreur: "paramètres attendus : type (ex. sigwx/fr/france) et date (AAAAMMJJHH0000)", version: VERSION }, 400);
  }
  const journal: Record<string, unknown>[] = [];
  let image: Response | null = null;
  try { image = await viaSofia(type, date, journal); } catch (e) {
    journal.push({ erreur: String(e).slice(0, 160) });
  }
  if (q.get("essai") === "1" || q.get("debug") === "1") {
    return reponseJson({ demande: { type, date }, version: VERSION,
      image: image ? "obtenue (voie SOFIA)" : "non obtenue", sofia: journal });
  }
  if (image) return image;
  return reponseJson({ erreur: "aucune image obtenue pour cette couche", demande: { type, date }, sofia: journal }, 404);
});
