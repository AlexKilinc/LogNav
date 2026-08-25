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
 *   GET ?lien=1&souple=1&...   -> le lien le plus récent même si l'échéance
 *        demandée manque au catalogue (avec sa vraie date, jamais maquillée)
 *   GET ?essai=1&type=...&date=...                  -> journal JSON de la voie SOFIA
 *   GET ?poste=1&op=postTemsi&zone=FRANCE           -> rejouer un POST SOFIA (diagnostic)
 *   GET ?version=1                                  -> version du code déployé
 *
 * Déploiement : Supabase > Edge Functions > fonction « cartes », coller ce
 * fichier EN ENTIER (vérifier que la dernière ligne dans l'éditeur est bien
 * « }); »), déployer, et laisser « Enforce JWT verification » DÉSACTIVÉ.
 * Aucun secret requis. Vérification : ouvrir ?version=1 -> doit répondre 7.29.
 */

const VERSION = "7.38";
const AERO = "https://aviation.meteo.fr";
const SOFIA = "https://sofia-briefing.aviation-civile.gouv.fr";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/* Un lien d'image : couche, validité, adresse complète. */
type Lien = { url: string; couche: string; date: string; brut?: string; urlOrigine?: string };

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

/* La réponse SOFIA est du JSON structuré : status.message contient zones[],
   et chaque entrée temsi[]/wintem[] porte SES métadonnées (level, zone, date)
   avec son lien signé. L'étiquette layer du lien, elle, est un gabarit
   constant (toujours fl020 pour les WINTEM) : elle ment. La vérité vient des
   métadonnées. */
function recolteSofia(texte: string): Lien[] {
  try {
    const j = JSON.parse(texte);
    let sm: unknown = j && (j["status.message"]);
    if (typeof sm === "string") sm = JSON.parse(sm);
    const zones = ((sm as { zones?: unknown[] }) || {}).zones || [];
    const out: Lien[] = [];
    for (const z of zones as Record<string, unknown>[]) {
      for (const fam of ["temsi", "wintem"]) {
        for (const it of ((z && z[fam]) || []) as Record<string, unknown>[]) {
          if (!it || !it.link) continue;
          let u = String(it.link);
          if (!/^https?:/.test(u)) { try { u = new URL(u, SOFIA + "/sofia/pages/").href; } catch { continue; } }
          let couche = "", brut = "";
          if (fam === "wintem") {
            brut = String(it.level ?? "");
            const grp = brut.match(/\d{1,3}/g) || [];
            let fl = "";
            if (grp.length === 1) fl = grp[0].padStart(3, "0");
            else {
              /* métadonnée absente ou MULTIPLE ([20,100]) : vérifié en vivo,
                 ces liens dessinent la couche de leur étiquette (le fl020 par
                 défaut) — jamais le niveau posté. L'étiquette fait foi. */
              const um = u.match(/fl0*(\d{1,3})/i);
              if (um) fl = um[1].padStart(3, "0");
            }
            if (fl) couche = "wintemp/fr/france/fl" + fl;
          } else {
            const zn = /euroc/i.test(String(it.zone || z.id || z.name || "")) ? "euroc" : "france";
            couche = "sigwx/fr/" + zn;
          }
          let date = "";
          try { const q2 = new URL(u).searchParams;
            date = q2.get("echeance") || q2.get("date") || ""; } catch { /* rien */ }
          const md = String(it.date || "").match(/^(\d{2}) (\d{2}) (\d{4}) (\d{2}):(\d{2})/);
          if (md) date = md[3] + md[2] + md[1] + md[4] + md[5] + "00";
          if (couche) out.push({ url: u, couche, date, brut });
        }
      }
    }
    return out;
  } catch { return []; }
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
    return [{ op: "postTemsi", champs: { zone: "EUROC" } },
            { op: "postTemsi", champs: { zone: "AERO_EUROC" } }];
  }
  const m = t.match(/^wintemp\/fr\/france\/fl(\d{3})$/);
  if (m) {
    const fl = m[1];
    const jeux: { op: string; champs: Record<string, string> }[] = [];
    const pousse = (champs: Record<string, string>) => {
      const k = JSON.stringify(champs);
      if (!jeux.some((j) => JSON.stringify(j.champs) === k)) jeux.push({ op: "postWintem", champs });
    };
    /* la forme gagnante memorisee, puis le niveau exact sous plusieurs ecritures */
    if (wintemGagnant) {
      const c: Record<string, string> = { zone: "FRANCE" };
      for (const k of Object.keys(wintemGagnant)) c[k] = wintemGagnant[k].replace(/\d{2,3}/, fl);
      pousse(c);
    }
    /* multi-choix en clé répétée : level=020&level=050&level=100 — si SOFIA
       répond par niveau, les métadonnées départageront proprement */
    pousse({ zone: "FRANCE", "level|": "020|050|100" });
    /* vocabulaire alternatif (français / Aéroweb) */
    pousse({ zone: "FRANCE", niveau: fl });
    pousse({ zone: "FRANCE", "niveau|": "020|050|100" });
    pousse({ zone: "FRANCE", altitude: fl });
    pousse({ zone: "FRANCE", "altitude|": "020|050|100" });
    pousse({ zone: "FRANCE", level: "FL" + fl });
    pousse({ zone: "FRANCE", "level|": "FL020|FL050|FL100" });
    /* level=NNN simple : PROUVE inoperant (l'image reste le fl020 par defaut),
       garde en recolte croisee au cas ou la reponse contiendrait un jour tous
       les niveaux avec leurs metadonnees — le filtre memeCouche fera le tri */
    pousse({ zone: "FRANCE", level: fl });
    pousse({ zone: "FRANCE", level: "020" });
    return jeux.slice(0, 18);
  }
  return [];
}

/* SOFIA pose des témoins de session (pare-feu applicatif, équilibreur) : un
   GET d'image sans eux peut être refusé alors que le POST du catalogue passe.
   On garde donc les témoins reçus, et on les présente en allant chercher
   l'image sur le même hôte. */
const temoinsSofia = new Map<string, string>();
function gardeTemoins(r: Response): void {
  try {
    const brut: string[] = typeof (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (r.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie") as string] : []);
    for (const l of brut) {
      const m = /^\s*([^=;,\s]+)=([^;]*)/.exec(l);
      if (m) temoinsSofia.set(m[1], m[2]);
    }
  } catch { /* témoins illisibles : tant pis */ }
}
function presenteTemoins(): string {
  return Array.from(temoinsSofia).map(([k, v]) => k + "=" + v).join("; ");
}

/* POST vers /sofia, mémorisé 2 minutes pour ne pas marteler le service quand
   le dossier météo charge cinq cartes d'un coup. */
const memoPoste = new Map<string, { t: number; texte: string }>();
async function posteSofia(op: string, champs: Record<string, string>): Promise<string> {
  const corps = new URLSearchParams();
  corps.set(":operation", op);
  for (const k of Object.keys(champs)) {
    /* "cle|" : valeur "a|b|c" à poster en clé répétée (multi-choix du formulaire) */
    if (k.endsWith("|")) for (const part of champs[k].split("|")) corps.append(k.slice(0, -1), part);
    else corps.set(k, champs[k]);
  }
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
  gardeTemoins(r);
  const texte = await r.text();
  if (r.ok) memoPoste.set(cle, { t: Date.now(), texte });
  return texte;
}

/* Voie officielle AEROWEB : active dès que le code d'accès (convention
   Météo-France, webmaster.aeroweb@meteo.fr) est posé en secret AEROWEB_ID
   dans Supabase (Edge Functions > cartes > Secrets). Jamais dans GitHub.
   L'API serveur_donnees.jsp rend un XML dont les liens sont signés. */
function paramsAeroweb(type: string): string | null {
  const t = type.toLowerCase();
  if (t === "sigwx/fr/france") return "VUE_CARTE=AERO_TEMSI";
  if (t === "sigwx/fr/euroc" || t === "sigwx/eur/euroc") {
    return "VUE_CARTE=AERO_TEMSI&ZONE=AERO_EUROC";
  }
  const m = t.match(/^wintemp\/fr\/france\/fl(\d{3})$/);
  if (m) return "VUE_CARTE=AERO_WINTEM&ALTITUDE=" + m[1];
  return null;
}

async function viaAeroweb(type: string, date: string, journal: Record<string, unknown>[]): Promise<Lien | null> {
  const id = Deno.env.get("AEROWEB_ID") || "";
  const pa = paramsAeroweb(type);
  if (!id || !pa) return null;
  const u = AERO + "/FR/aviation/serveur_donnees.jsp?ID=" + encodeURIComponent(id) +
    "&TYPE_DONNEES=CARTES&BASE_COMPLETE=non&" + pa;
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "*/*" }, redirect: "follow" });
    const texte = await r.text();
    const liens = recolte(texte, AERO + "/FR/aviation/");
    journal.push({ voie: "AEROWEB (code officiel)", http: r.status, liens: liens.length,
      apercu: liens.length ? undefined : texte.slice(0, 160) });
    if (!liens.length) return null;
    const cible = Number((date || "0").padEnd(14, "0"));
    const dispo = liens.filter((l) => memeCouche(type, l.couche));
    if (!dispo.length) return null;
    const tri = dispo.sort((a, b) =>
      Math.abs(Number(a.date || "0") - cible) - Math.abs(Number(b.date || "0") - cible));
    const chemin = tri[0].url.replace(/^https?:\/\/[^/]+/, "");
    return { url: AERO + chemin, couche: tri[0].couche, date: tri[0].date };
  } catch (e) {
    journal.push({ voie: "AEROWEB (code officiel)", erreur: String(e).slice(0, 120) });
    return null;
  }
}

/* validité « AAAAMMJJHHMMSS » -> millisecondes UTC */
function tempsDe(d: string): number {
  if (!/^\d{14}$/.test(d)) return NaN;
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
    +d.slice(8, 10), +d.slice(10, 12), +d.slice(12, 14));
}
/* au-delà de cet écart, le lien ne correspond plus à l'échéance demandée :
   mieux vaut « pas encore publiée » qu'une vieille carte sous étiquette neuve */
const TOLERANCE = 100 * 60 * 1000;

/* Le relais ne doit JAMAIS servir une carte d'un autre type que celui demandé
   (jamais un TEMSI pour un WINTEM, ni un mauvais niveau). On compare par famille
   (WINTEM vs TEMSI), et par niveau de vol pour le WINTEM / zone pour le TEMSI. */
function familleCouche(s: string): string {
  s = (s || "").toLowerCase();
  if (/wintem/.test(s)) return "wintem";
  if (/sigwx|temsi/.test(s)) return "temsi";
  return s.split("/")[0];
}
function flCouche(s: string): string {
  const m = (s || "").toLowerCase().match(/fl0*(\d{1,3})/);
  return m ? m[1] : "";
}
function zoneCouche(s: string): string {
  s = (s || "").toLowerCase();
  return /euroc/.test(s) ? "euroc" : (/france/.test(s) ? "france" : "");
}
function memeCouche(req: string, lien: string): boolean {
  if (familleCouche(req) !== familleCouche(lien)) return false;
  if (familleCouche(req) === "wintem") return flCouche(req) === flCouche(lien);
  return zoneCouche(req) === zoneCouche(lien);
}

async function viaSofia(type: string, date: string, journal: Record<string, unknown>[], souple = false): Promise<Lien | null> {
  for (const jeu of opsPour(type)) {
    let texte = "";
    try { texte = await posteSofia(jeu.op, jeu.champs); } catch (e) {
      journal.push({ op: jeu.op, champs: jeu.champs, erreur: String(e).slice(0, 100) });
      continue;
    }
    let liens = recolteSofia(texte);
    if (!liens.length) liens = recolte(texte, SOFIA + "/sofia/pages/");
    const entree: Record<string, unknown> = { op: jeu.op, champs: jeu.champs, liens: liens.length };
    if (!liens.length) entree.apercu = texte.slice(0, 160);
    journal.push(entree);
    if (!liens.length) continue;
    /* la couche demandée, à la validité la plus proche — jamais un autre type */
    const cible = tempsDe((date || "").padEnd(14, "0"));
    const dispo = liens.filter((l) => memeCouche(type, l.couche));
    if (!dispo.length) {
      journal.push({ op: jeu.op, coucheAbsente: type,
        recu: liens.map((l) => l.couche + (l.brut ? " (level brut : " + l.brut + ")" : "")).slice(0, 6) });
      continue;
    }
    /* la forme n'est « gagnante » que si elle a livre la bonne couche */
    if (jeu.op === "postWintem") wintemGagnant = jeu.champs;
    const tri = dispo.sort((a, b) =>
      Math.abs((tempsDe(a.date) || 0) - cible) - Math.abs((tempsDe(b.date) || 0) - cible));
    /* échéance demandée absente du catalogue : on le dit, on ne maquille pas —
       sauf en mode souple, où l'on rend le plus proche AVEC sa vraie date,
       à charge pour l'appelant d'afficher l'avertissement */
    const ecart = Math.abs((tempsDe(tri[0].date) || 0) - cible);
    if (!souple && isFinite(cible) && ecart > TOLERANCE) {
      journal.push({ nonPubliee: date, plusProche: tri[0].date,
        note: "échéance demandée absente du catalogue SOFIA (carte pas encore publiée ?)" });
      return null;
    }
    /* l'image vit chez Météo-France : le lien signé, posé sur l'hôte AERO —
       c'est le navigateur du pilote qui ira la chercher (redirection), car
       aviation.meteo.fr refuse les adresses IP de centres de données. */
    /* le lien signe part TEL QUEL : la signature couvre la valeur exacte de
       layer, toute retouche provoque un « internal error » chez Météo-France.
       La couche vraie voyage à côté (JSON et en-tête), jamais dans le lien. */
    const chemin = tri[0].url.replace(/^https?:\/\/[^/]+/, "");
    /* urlOrigine : l'adresse TELLE QUE SOFIA l'a donnée. Le lien rendu est
       réécrit sur l'hôte AERO pour le navigateur du pilote, mais c'est sur
       son hôte d'origine que le relais, lui, peut aller chercher les octets. */
    return { url: AERO + chemin, couche: tri[0].couche, date: tri[0].date,
      urlOrigine: tri[0].url };
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

/* Catalogue d'une couche : les échéances RÉELLEMENT publiées par SOFIA —
   pour que l'application ne propose jamais une carte qui n'existe pas encore
   (même politique que loxodrome). ?dates=1&type=sigwx/fr/euroc ->
   { type, dates: ["20260822180000", "20260822210000"] } */
async function datesDe(q: URLSearchParams): Promise<Response> {
  const type = (q.get("type") || q.get("layer") || "").toLowerCase();
  if (!type) return reponseJson({ erreur: "type attendu (ex. sigwx/fr/euroc)" }, 400);
  const journal: Record<string, unknown>[] = [];
  for (const jeu of opsPour(type)) {
    let texte = "";
    try { texte = await posteSofia(jeu.op, jeu.champs); } catch (e) {
      journal.push({ op: jeu.op, erreur: String(e).slice(0, 80) }); continue;
    }
    let liens = recolteSofia(texte);
    if (!liens.length) liens = recolte(texte, SOFIA + "/sofia/pages/");
    const dispo = liens.filter((l) => memeCouche(type, l.couche) && /^\d{14}$/.test(l.date));
    if (dispo.length) {
      return reponseJson({ type, dates: [...new Set(dispo.map((l) => l.date))].sort() });
    }
  }
  return reponseJson({ type, dates: [], sofia: journal });
}

/* NOTAM : relais vers autorouter.aero, qui republie les NOTAM de la base
   EUROCONTROL (EAD) par indicateur OACI (item A), en JSON et sans
   authentification pour la lecture. autorouter fournit la ligne Q déjà
   décodée (lat/lon en degrés, rayon en NM, planchers/plafonds en FL).
   ?notam=1&ad=LFPN,LFPO,... -> { terrains, total, notams:[...] } + CORS.
   Mémo 10 minutes par jeu de terrains, pour ménager le service. */
const memoNotam = new Map<string, { t: number; corps: string }>();

/* Jeton OAuth2 autorouter (client_credentials : l'e-mail et le mot de passe
   d'un compte gratuit), pose en secrets AUTOROUTER_ID / AUTOROUTER_MDP dans
   Supabase (Edge Functions > cartes > Secrets) — jamais dans le code ni dans
   GitHub. Le jeton est memorise et renouvele avant son expiration. */
let arJeton: { t: string; fin: number } | null = null;
/* Plus d'un jeton par jour est deja anormal ; six est une marge confortable
   pour un incident isole, et reste tres loin des 20 jetons actifs
   qu'autorouter tolere. */
const JETONS_PAR_JOUR = 6;
/* ===== Jeton autorouter : UN SEUL pour tout le relais =====
   autorouter plafonne les jetons d'acces actifs (20) et refuse ensuite avec
   « toomanytokens ». Or une fonction Edge est recreee sans cesse : une memoire
   d'instance fabrique un jeton neuf a chaque demarrage a froid, et le quota se
   remplit en une journee. On range donc le jeton dans la base du projet, que
   toutes les instances partagent ; la memoire d'instance ne sert plus que de
   cache de premier niveau.
   Mise en place (une seule fois, Supabase > SQL Editor) :
     create table if not exists relais_memo (
       cle text primary key, valeur text not null, expire timestamptz);
     alter table relais_memo enable row level security;
   Aucune policy : seule la cle de service, qui contourne RLS, y accede.
   Si la table n'existe pas, le relais retombe sur l'ancien comportement. */
function memoUrl(): string {
  const b = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
  return b ? b + "/rest/v1/relais_memo" : "";
}
function memoEntetes(): Record<string, string> {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  return { "apikey": k, "Authorization": "Bearer " + k,
           "Content-Type": "application/json" };
}
/* Etat complet : la TABLE existe-t-elle, et porte-t-elle une ligne ?
   Les deux cas sont differents et appellent des remedes opposes — une table
   absente se cree, une table vide attend simplement son premier jeton. Les
   confondre envoie sur une fausse piste. */
async function memoEtat(cle: string):
    Promise<{ table: boolean; ligne: { valeur: string; fin: number } | null }> {
  const u = memoUrl(); if (!u) return { table: false, ligne: null };
  try {
    const r = await fetch(u + "?cle=eq." + encodeURIComponent(cle) + "&select=valeur,expire",
      { headers: memoEntetes() });
    if (!r.ok) return { table: false, ligne: null };
    const j = await r.json();
    const l = Array.isArray(j) ? j[0] : null;
    if (!l || !l.valeur) return { table: true, ligne: null };   /* table prete, vide */
    const fin = l.expire ? Date.parse(l.expire) : 0;
    return { table: true, ligne: { valeur: String(l.valeur), fin: isFinite(fin) ? fin : 0 } };
  } catch { return { table: false, ligne: null }; }
}
async function memoLit(cle: string): Promise<{ valeur: string; fin: number } | null> {
  return (await memoEtat(cle)).ligne;
}
/* Les memoires de contenu (NOTAM, SUP AIP, cartes) vivent dans l'INSTANCE.
   Or une fonction Edge est recreee sans cesse, et chaque deploiement les
   efface toutes : une instance neuve refait alors tout le chemin vers la
   source, d'ou l'attente ressentie apres chaque mise a jour du relais.
   On double donc la memoire d'instance d'une memoire PARTAGEE, rangee dans
   la meme table que le jeton : n'importe quelle instance peut servir une
   reponse recente sans rien redemander a autorouter ni au SIA.
   Regle absolue, la meme que pour le garde-fou : si la base est muette, on
   n'en tient aucun compte — elle ne doit jamais devenir une panne de plus. */
async function memoFrais(cle: string): Promise<{ valeur: string; reste: number } | null> {
  try {
    const l = await memoLit(cle);
    if (!l || !l.valeur) return null;
    const reste = (l.fin || 0) - Date.now();
    if (reste <= 0) return null;              /* perimee : on ira a la source */
    return { valeur: l.valeur, reste };
  } catch { return null; }
}
/* au-dela, l'ecriture couterait plus de temps qu'elle n'en fera gagner */
const PARTAGE_MAX = 400_000;
async function memoRange(cle: string, corps: string, duree: number): Promise<void> {
  if (corps.length > PARTAGE_MAX) return;
  try { await memoEcrit(cle, corps, Date.now() + duree); } catch { /* muette : tant pis */ }
}
async function memoEcrit(cle: string, valeur: string, fin: number):
    Promise<{ ok: boolean; status: number; corps: string }> {
  const u = memoUrl(); if (!u) return { ok: false, status: 0, corps: "SUPABASE_URL absente" };
  try {
    const r = await fetch(u, { method: "POST",
      headers: { ...memoEntetes(), "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify([{ cle, valeur, expire: new Date(fin).toISOString() }]) });
    return { ok: r.ok, status: r.status, corps: r.ok ? "" : (await r.text()).slice(0, 140) };
  } catch (e) { return { ok: false, status: 0, corps: String(e).slice(0, 140) }; }
}
/* Constat du 24 aout : le dernier jeton delivre datait de 06:53 UTC et, eleven
   heures plus tard, autorouter refusait toujours (« toomanytokens »). Un jeton
   reste donc COMPTE COMME ACTIF bien au-dela de l'heure annoncee par
   expires_in — vraisemblablement jusqu'a 24 h, ou jusqu'a revocation.
   Consequence : jeter un jeton parce que son expires_in est passe, c'est en
   fabriquer un de plus tout en gardant l'ancien sur le dos. On garde donc le
   jeton range TANT QU'AUTOROUTER L'ACCEPTE, et on n'en redemande un que
   lorsqu'il est reellement refuse (401). C'est le seul reglage qui borne le
   nombre de jetons crees par jour. */
async function jetonAutorouter(neuf = false): Promise<string | null> {
  const id = (Deno.env.get("AUTOROUTER_ID") || "").trim();
  const mdp = (Deno.env.get("AUTOROUTER_MDP") || "").trim();
  if (!id || !mdp) return null;
  /* 1. memoire d'instance */
  if (!neuf && arJeton) return arJeton.t;
  /* 2. jeton partage, range en base : evite d'en fabriquer un par instance */
  if (!neuf) {
    const p = await memoLit("autorouter");
    if (p && p.valeur) {
      arJeton = { t: p.valeur, fin: p.fin };
      return p.valeur;
    }
  }
  /* 3. GARDE-FOU : jamais plus de JETONS_PAR_JOUR jetons dans la journee.
     Le 24 aout, un defaut du relais a fabrique un jeton par instance jusqu'a
     saturer le plafond des 20 jetons actifs ; il a fallu ecrire au support
     d'autorouter pour debloquer le compte. En usage normal le relais en
     fabrique UN par jour, au plus : au-dela, c'est forcement un defaut, et
     mieux vaut perdre les NOTAM une journee que le compte pour plusieurs.
     Le garde-fou s'efface si la base est muette (il ne doit jamais devenir
     lui-meme une panne). */
  const jour = new Date().toISOString().slice(0, 10);
  const cpt = await memoLit("autorouter_jour");
  let n = 0;
  if (cpt && cpt.valeur) {
    try {
      const c = JSON.parse(cpt.valeur) as { jour?: string; n?: number };
      if (c.jour === jour) n = Number(c.n) || 0;
    } catch { /* compteur illisible : on laisse passer */ }
  }
  if (n >= JETONS_PAR_JOUR) {
    const motif = "garde-fou du relais : " + n + " jetons deja demandes "
      + "aujourd'hui (plafond interne " + JETONS_PAR_JOUR + "). En usage normal "
      + "il en faut UN par jour — au-dela, c'est un defaut. Le relais s'arrete "
      + "de lui-meme pour ne pas saturer le compte autorouter (20 jetons "
      + "actifs). Le compteur repart demain.";
    await memoEcrit("autorouter_journal",
      JSON.stringify({ quand: new Date().toISOString(), evt: "garde-fou", motif }),
      Date.now() + 7 * 24 * 3600e3);
    throw new Error(motif);
  }
  await memoEcrit("autorouter_jour", JSON.stringify({ jour, n: n + 1 }),
    Date.now() + 2 * 24 * 3600e3);
  /* 4. seulement alors, en demander un nouveau */
  const r = await fetch("https://api.autorouter.aero/v1.0/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA, "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials",
      client_id: id, client_secret: mdp }).toString(),
  });
  const texte = await r.text();
  if (!r.ok) {
    /* garder trace du refus dans la base : les instances passent, le journal
       reste, et la sonde peut dire si le plafond est encore plein MAINTENANT
       ou si l'on regarde une vieille erreur */
    /* NE PAS masquer la reponse d'autorouter derriere un message maison :
       elle seule peut dire combien de temps un jeton reste « actif », ou
       comment en liberer. C'est ce texte qu'il faut lire. */
    const brut = texte.replace(/\s+/g, " ").trim().slice(0, 400);
    const motif = /toomanytokens/i.test(texte)
      ? "plafond de jetons autorouter atteint (20 actifs) \u2014 reponse : " + brut
      : "jeton autorouter refusé (" + r.status + ") " + brut;
    await memoEcrit("autorouter_journal",
      JSON.stringify({ quand: new Date().toISOString(), evt: "refus", motif }),
      Date.now() + 7 * 24 * 3600e3);
    throw new Error(motif);
  }
  const j = JSON.parse(texte);
  const duree = (Number(j.expires_in) || 3600) * 1000;
  const jt = String(j.access_token || "");
  if (!jt) throw new Error("jeton autorouter vide");
  const fin = Date.now() + duree;
  arJeton = { t: jt, fin };
  await memoEcrit("autorouter", jt, fin);
  await memoEcrit("autorouter_journal",
    JSON.stringify({ quand: new Date().toISOString(), evt: "succes",
      motif: "jeton obtenu (duree " + Math.round(duree / 60000) + " min), partage entre les instances" }),
    Date.now() + 7 * 24 * 3600e3);
  return jt;
}
const NOTAM_DUREE = 600000;   /* 10 min : la fraicheur attendue d'un NOTAM */
function reponseNotam(corps: string, voie: "memo" | "base" | "frais"): Response {
  return new Response(corps, { headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=600",
    "Access-Control-Allow-Origin": "*",
    "X-Cartes-Version": VERSION,
    "X-Cartes-Notam": voie,
  } });
}
async function notam(q: URLSearchParams): Promise<Response> {
  const ads = (q.get("ad") || "").toUpperCase().split(",").map((x) => x.trim())
    .filter((x) => /^[A-Z]{4}$/.test(x)).slice(0, 40);
  if (!ads.length) {
    return reponseJson({ erreur: "paramètre ad attendu : ad=LFPN,LFPO,… (codes OACI, 40 au plus)" }, 400);
  }
  const cle = ads.slice().sort().join(",");
  const su = memoNotam.get(cle);
  if (su && Date.now() - su.t < NOTAM_DUREE) return reponseNotam(su.corps, "memo");
  /* instance neuve : la reponse est peut-etre deja en base, posee par une
     autre instance il y a moins de dix minutes. Une lecture en base coute
     une fraction de l'aller-retour vers autorouter — et n'use pas le quota. */
  const pt = await memoFrais("notam:" + cle);
  if (pt) {
    /* on garde l'AGE d'origine : passer par la base ne rajeunit rien */
    memoNotam.set(cle, { t: Date.now() - (NOTAM_DUREE - pt.reste), corps: pt.valeur });
    return reponseNotam(pt.valeur, "base");
  }
  let jeton: string | null = null;
  try { jeton = await jetonAutorouter(); } catch (e) {
    /* large : c'est le texte d'autorouter qu'on veut lire en entier */
    return reponseJson({ erreur: "authentification autorouter impossible",
      detail: String(e).slice(0, 500) }, 502);
  }
  if (!jeton) {
    return reponseJson({ erreur: "identifiants autorouter absents",
      aide: "créer un compte gratuit sur autorouter.aero, puis poser AUTOROUTER_ID (e-mail) et "
        + "AUTOROUTER_MDP (mot de passe) dans Supabase > Edge Functions > cartes > Secrets, "
        + "et redéployer — jamais dans GitHub." }, 503);
  }
  /* autorouter plafonne limit à 100 : on pagine (4 pages au plus, largement
     assez pour une douzaine de terrains) */
  const lignes: Record<string, unknown>[] = [];
  try {
    let total = Infinity;
    for (let page = 0; page < 4 && lignes.length < total; page++) {
      const u = "https://api.autorouter.aero/v1.0/notam?itemas="
        + encodeURIComponent(JSON.stringify(ads)) + "&offset=" + (page * 100) + "&limit=100";
      let r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "application/json",
        "Authorization": "Bearer " + jeton } });
      /* Un seul motif justifie de fabriquer un jeton de plus : le notre est
         REFUSE (401). Un 403 est un droit manquant — en reclamer un neuf
         ne le corrigerait pas et gaspillerait une place du plafond. */
      if (r.status === 401) {
        /* le jeton partage est mort : l'effacer, sinon l'instance suivante
           le relira et refera ce meme aller-retour inutile */
        arJeton = null;
        await memoEcrit("autorouter", "", Date.now());
        try { jeton = await jetonAutorouter(true); } catch { jeton = null; }
        if (jeton) r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "application/json",
          "Authorization": "Bearer " + jeton } });
      }
      const texte = await r.text();
      if (!r.ok) {
        return reponseJson({ erreur: "autorouter répond " + r.status, apercu: texte.slice(0, 200) }, 502);
      }
      let j: { total?: number; rows?: Record<string, unknown>[] };
      try { j = JSON.parse(texte); } catch {
        return reponseJson({ erreur: "réponse autorouter illisible", apercu: texte.slice(0, 200) }, 502);
      }
      const lot = (j.rows || []) as Record<string, unknown>[];
      total = (typeof j.total === "number") ? j.total : lot.length;
      lignes.push(...lot);
      if (!lot.length) break;
    }
    /* autorouter marque « suppressed » les NOTAM qu'il considere annules ou
       remplaces. On les ecarte — mais SANS LE DIRE, un NOTAM manquant devient
       indiscernable d'un NOTAM qu'autorouter n'aurait pas du tout. On rend
       donc le compte brut et le nom de chaque ecarte : c'est la seule facon
       de trancher entre « la source ne l'a pas » et « nous l'avons filtre ». */
    const nomDe = (n: Record<string, unknown>) =>
      String(n.series || "") + String(n.number ?? "")
      + (n.year != null ? "/" + String(n.year).slice(-2) : "");
    const supprimes = lignes.filter((n) => n && n.suppressed).map(nomDe).slice(0, 40);
    const notams = lignes.filter((n) => n && !n.suppressed).map((n) => ({
      ad: String(n.itema || ""),
      serie: String(n.series || "") + String(n.number ?? "")
        + (n.year != null ? "/" + String(n.year).slice(-2) : ""),
      texte: String(n.iteme || ""),
      debut: n.startvalidity, fin: n.endvalidity, estimee: !!n.estimation,
      lat: n.lat, lon: n.lon, rayon: n.radius,
      bas: n.lower, haut: n.upper,
      qcode: String(n.code23 || "") + String(n.code45 || ""),
      portee: n.scope, horaire: n.itemd || undefined, fir: n.fir,
    }));
    const corps = JSON.stringify({ terrains: ads, total: notams.length,
      bruts: lignes.length, supprimes, notams });
    memoNotam.set(cle, { t: Date.now(), corps });
    await memoRange("notam:" + cle, corps, NOTAM_DUREE);
    return reponseNotam(corps, "frais");
  } catch (e) {
    return reponseJson({ erreur: "NOTAM indisponibles", detail: String(e).slice(0, 140) }, 502);
  }
}

/* SUP AIP : lecture de l'index officiel du SIA (Métropole) — la liste est
   rendue côté serveur dans la page (table listeSupAIP), chaque ligne portant
   le numéro, le titre, le lien du PDF officiel et les dates de validité.
   Structure relevée par sonde le 22/08/2026 :
     <a class="lien_sup_aip" href=".../documents/download/f/d/NNN/">
       <b>184/2026</b> <span>Titre… <i class="fas…"></i></span></a>
     … Valide du <strong>2026-09-07</strong> [au <strong>…</strong>]
   ?supaip=1 -> { maj, total, sups:[{num,titre,pdf,du,au}] } + CORS.
   Mémo 12 h : l'index ne bouge qu'aux cycles AIRAC. */
const SIA_SUP = "https://www.sia.aviation-civile.gouv.fr/documents/supaip/aip/id/6";
let memoSup: { t: number; corps: string } | null = null;
function nettoieTitre(t: string): string {
  return t.replace(/<[^>]+>/g, " ")
    .replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").replace(/&#x20;/g, " ")
    .replace(/&quot;/g, '"').replace(/&eacute;/gi, "é").replace(/&egrave;/gi, "è")
    .replace(/\s+/g, " ").trim();
}
const SUP_DUREE = 12 * 3600e3;
function reponseSup(corps: string, voie: "memo" | "base" | "frais"): Response {
  return new Response(corps, { headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
    "X-Cartes-Version": VERSION, "X-Cartes-Supaip": voie,
  } });
}
async function supAip(_q: URLSearchParams): Promise<Response> {
  if (memoSup && Date.now() - memoSup.t < SUP_DUREE) return reponseSup(memoSup.corps, "memo");
  /* l'index du SIA fait ~230 Ko a depouiller : c'est l'autre moitie de
     l'attente au listing. Une instance neuve le reprend en base plutot que
     de le redemander au SIA. */
  const pt = await memoFrais("supaip");
  if (pt) {
    memoSup = { t: Date.now() - (SUP_DUREE - pt.reste), corps: pt.valeur };
    return reponseSup(pt.valeur, "base");
  }
  try {
    const r = await fetch(SIA_SUP, { headers: { "User-Agent": UA, "Accept": "text/html" }, redirect: "follow" });
    const texte = await r.text();
    if (!r.ok) return reponseJson({ erreur: "le SIA répond " + r.status }, 502);
    const maj = (texte.match(/Date de derni\u00e8re mise \u00e0 jour de la liste\s*:\s*<b>([^<]+)<\/b>/) ||
                 texte.match(/mise . jour de la liste\s*:\s*<b>([^<]+)<\/b>/i) || [])[1] || "";
    const sups: { num: string; titre: string; pdf: string; du: string; au: string }[] = [];
    /* la page fait ~230 Ko : une expression unique avec retours en arriere
       depassait le budget CPU de la fonction (WORKER_RESOURCE_LIMIT constate
       en vivo). On decoupe donc ligne par ligne (<tr) et on n'applique que de
       petites expressions LOCALES a chaque morceau — cout lineaire. */
    const debut = texte.indexOf('class="listeSupAIP"');
    const zone = debut >= 0 ? texte.slice(debut) : texte;
    const lignes = zone.split(/<tr[\s>]/i).slice(1, 500);
    for (const lg of lignes) {
      const morceau = lg.slice(0, 4000);
      const a = morceau.match(/class="lien_sup_aip"\s+href="([^"]+)"[^>]*>\s*<b>([^<]*)<\/b>\s*<span>([\s\S]*?)<\/span>/i);
      if (!a) continue;
      const du = (morceau.match(/Valide du\s*<strong[^>]*>\s*([0-9-]+)/i) || [])[1] || "";
      const au = (morceau.match(/\bau\s*<strong[^>]*>\s*([0-9-]+)/i) || [])[1] || "";
      sups.push({ num: a[2].trim(), titre: nettoieTitre(a[3]), pdf: a[1], du, au });
      if (sups.length >= 400) break;
    }
    if (!sups.length) {
      return reponseJson({ erreur: "index SIA illisible (structure changée ?)", apercu: texte.slice(0, 300) }, 502);
    }
    const corps = JSON.stringify({ maj, total: sups.length, sups });
    memoSup = { t: Date.now(), corps };
    await memoRange("supaip", corps, SUP_DUREE);
    return reponseSup(corps, "frais");
  } catch (e) {
    return reponseJson({ erreur: "SUP AIP indisponibles", detail: String(e).slice(0, 140) }, 502);
  }
}

/* ================== AZBA / RTBA — activation des zones basse altitude =====
   Source officielle : l'API que consomme l'application AZBA du SIA
   (https://www.sia.aviation-civile.gouv.fr/azbaEx/, un client Angular/Ionic).
   Chemins relevés dans son code (26/08/2026) :
     v3/custom/currentDate                       -> plage publiée
     v3/r_t_b_as?itemsPerPage=600&debutIntervalTemps=…&finIntervalTemps=…
     v3/r_t_b_as?network=1     -> réseau : contours AIXM + créneaux (source
                                  principale ; les contours sont reconstruits
                                  ici, segments droits et arcs de cercle)
   Chaque requête porte deux en-têtes :
     Authorization: Basic base64(<AZBA_BASIC>)
     AUTH:          base64({"tokenUri": sha512(<AZBA_CLE> + "/api/" + chemin)})
   Les deux valeurs sont publiques (embarquées dans le paquet JS du SIA) mais
   restent des identifiants d'un tiers : elles vivent en SECRETS Supabase
   (AZBA_CLE, AZBA_BASIC), jamais dans le dépôt GitHub.
   ?azba=1            -> { maj, total, zones:[{nom,bas,haut,creneaux:[{debut,fin}],geometrie?}] }
   ?azba=1&brut=1     -> réponse brute de l'API (mise au point)
   ?azba=1&chemin=…   -> interroge un autre chemin de la même API
   Mémo 20 min. */
const AZBA_API = "https://bo-prod-sofia-vac.sia-france.fr/api/";
let memoAzba: { t: number; corps: string } | null = null;
async function sha512Hex(t: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function enB64(t: string): string {
  let s2 = ""; for (const o of new TextEncoder().encode(t)) s2 += String.fromCharCode(o);
  return btoa(s2);
}
function azbaDate(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") { const d = new Date(v > 4e10 ? v : v * 1000); return isNaN(+d) ? "" : d.toISOString(); }
  const t = String(v).trim(); if (!t) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:/.test(t) ? t.replace(" ", "T") : t);
  return isNaN(+d) ? "" : d.toISOString();
}
function azbaPrend(o: Record<string, unknown>, cles: string[]): unknown {
  for (const k of Object.keys(o)) if (cles.includes(k.toLowerCase())) {
    const v = o[k]; if (v !== null && v !== "" && v !== undefined) return v;
  }
  return undefined;
}
/* --- géométrie AIXM : « 463620N » / « 0022818E » -> degrés décimaux --- */
function azbaDms(v: unknown): number | null {
  const m = String(v ?? "").trim().match(/^(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])$/i);
  if (!m) return null;
  let d = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
  const h = m[4].toUpperCase();
  if (h === "S" || h === "W") d = -d;
  return isFinite(d) ? d : null;
}
/* arc de cercle entre deux points, autour d'un centre (rayon en NM) :
   CWA = sens horaire, CCA = sens anti-horaire (convention AIXM du SIA) */
function azbaArc(cLat: number, cLon: number, rNm: number,
  a: [number, number], b: [number, number], horaire: boolean): [number, number][] {
  const kx = Math.cos(cLat * Math.PI / 180) || 1;
  const ang = (p: [number, number]) => Math.atan2((p[1] - cLon) * kx, p[0] - cLat);
  const a0 = ang(a);
  let delta = ang(b) - a0;
  const TAU = 2 * Math.PI;
  if (horaire) { while (delta <= 0) delta += TAU; while (delta > TAU) delta -= TAU; }
  else { while (delta >= 0) delta -= TAU; while (delta < -TAU) delta += TAU; }
  const n = Math.max(2, Math.min(72, Math.ceil(Math.abs(delta) / (Math.PI / 36))));
  const pts: [number, number][] = [];
  for (let i = 1; i < n; i++) {
    const t = a0 + delta * i / n;
    pts.push([cLat + (rNm / 60) * Math.cos(t), cLon + (rNm / 60) * Math.sin(t) / kx]);
  }
  return pts;
}
/* contour d'une zone : le codeType d'un point décrit le segment qui EN PART
   (vérifié sur LFR139A/B : les deux extrémités de l'arc sont bien à 19 NM
   du centre annoncé). GRC/RHL/FNT -> segment droit ; CWA/CCA -> arc. */
function azbaContour(coords: unknown): [number, number][] | null {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const pts = coords.slice().sort((x, y) =>
    Number((x as Record<string, unknown>).coordPosition ?? 0) -
    Number((y as Record<string, unknown>).coordPosition ?? 0));
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Record<string, unknown>;
    const q = pts[(i + 1) % pts.length] as Record<string, unknown>;
    const lat = azbaDms(p.latitude), lon = azbaDms(p.longitude);
    if (lat == null || lon == null) return null;
    out.push([lat, lon]);
    const t = String(p.codeType ?? "").toUpperCase();
    const r = Number(p.valRadiusArc ?? 0);
    if ((t === "CWA" || t === "CCA") && r > 0) {
      const cLat = azbaDms(p.geoLatArc), cLon = azbaDms(p.geoLongArc);
      const qLat = azbaDms(q.latitude), qLon = azbaDms(q.longitude);
      if (cLat != null && cLon != null && qLat != null && qLon != null)
        out.push(...azbaArc(cLat, cLon, r, [lat, lon], [qLat, qLon], t === "CWA"));
    }
  }
  return out.length >= 3 ? out : null;
}
/* niveau lisible : 0 FT HEI -> SFC ; 800 FT HEI -> 800 ft ASFC ;
   3000 FT ALT -> 3000 ft AMSL ; 65 FL STD -> FL65 */
function azbaNiveau(o: Record<string, unknown>, sens: "bas" | "haut"): string {
  const V = sens === "bas"
    ? ["valdistverlower", "lower", "plancher", "floor", "lowerlimit", "altmin"]
    : ["valdistverupper", "upper", "plafond", "ceiling", "upperlimit", "altmax"];
  const U = sens === "bas" ? ["uomdistverlower", "uomlower"] : ["uomdistverupper", "uomupper"];
  const R = sens === "bas" ? ["codedistverlower", "reflower"] : ["codedistverupper", "refupper"];
  const vb = sens === "bas" ? o["valDistVerLower"] : o["valDistVerUpper"];
  const v = vb !== undefined && vb !== null ? vb : azbaPrend(o, V);
  if (v == null || v === "") return "";
  const u = String(azbaPrend(o, U) ?? "").toUpperCase();
  const r = String(azbaPrend(o, R) ?? "").toUpperCase();
  if (u === "FL") return "FL" + String(v);
  const ref = r === "HEI" ? "ASFC" : (r === "ALT" ? "AMSL" : r);
  if (Number(v) === 0 && (ref === "ASFC" || !ref)) return "SFC";
  return String(v) + (u ? " " + u.toLowerCase() : "") + (ref ? " " + ref : "");
}
type AzbaZone = { nom: string; bas: string; haut: string;
  creneaux: { debut: string; fin: string }[]; geometrie?: [number, number][] };
function azbaZonesDe(j: unknown): AzbaZone[] | null {
  const src = j as Record<string, unknown> | null;
  const brut = Array.isArray(j) ? j
    : (src && (src["hydra:member"] ?? src["member"] ?? src["data"] ?? src["zones"]));
  if (!Array.isArray(brut)) return null;
  const maintenant = Date.now(), horizon = maintenant + 8 * 24 * 3600e3;
  const zones: AzbaZone[] = [];
  for (const it of brut) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    /* le code officiel prime (LFR139A) ; à défaut le libellé (« 139 A ») */
    const nom = String(o["codeId"] ?? o["codeid"] ??
      azbaPrend(o, ["txtname", "name", "nom", "designation"]) ?? "")
      .replace(/^RTBA-/i, "").trim();
    if (!nom) continue;
    const slots = azbaPrend(o, ["timeslots", "creneaux", "slots", "activations"]);
    const creneaux: { debut: string; fin: string }[] = [];
    const vus = new Set<string>();
    if (Array.isArray(slots)) {
      for (const c of slots.slice(0, 200)) {
        if (!c || typeof c !== "object") continue;
        const co = c as Record<string, unknown>;
        const debut = azbaDate(azbaPrend(co, ["from", "debut", "start", "startdatetime", "starttime"]));
        const fin = azbaDate(azbaPrend(co, ["to", "fin", "end", "enddatetime", "endtime"]));
        if (!debut && !fin) continue;
        const cle = debut + "|" + fin;
        if (vus.has(cle)) continue;                 /* l'API renvoie des doublons */
        const tf = Date.parse(fin || debut) || 0;
        if (tf && tf < maintenant) continue;         /* déjà terminé */
        if ((Date.parse(debut) || 0) > horizon) continue;
        vus.add(cle); creneaux.push({ debut, fin });
      }
    }
    creneaux.sort((a, b) => (Date.parse(a.debut) || 0) - (Date.parse(b.debut) || 0));
    const z: AzbaZone = { nom, bas: azbaNiveau(o, "bas"), haut: azbaNiveau(o, "haut"), creneaux };
    const g = azbaContour(o["coordinates"]);
    if (g) z.geometrie = g;
    zones.push(z);
  }
  return zones.length ? zones : null;
}
async function azbaLit(chemin: string, cle: string, basic: string):
  Promise<{ http: number; j: unknown; apercu: string }> {
  const tokenUri = await sha512Hex(cle + "/api/" + chemin);
  const r = await fetch(AZBA_API + chemin, { headers: {
    "AUTH": enB64(JSON.stringify({ tokenUri })),
    "Authorization": "Basic " + enB64(basic),
    "Accept": "application/json",
    "User-Agent": UA,
  } });
  const texte = await r.text();
  let j: unknown = null; try { j = JSON.parse(texte); } catch { /* pas du JSON */ }
  return { http: r.status, j, apercu: texte.slice(0, 300) };
}
function azbaHorodate(d: Date, forme: number): string {
  const iso = d.toISOString().replace(/\.\d{3}Z$/, "");
  if (forme === 0) return iso + "Z";
  if (forme === 1) return iso + "+00:00";
  if (forme === 2) return iso;
  return iso.replace("T", " ");
}
async function azba(q: URLSearchParams): Promise<Response> {
  const cle = (Deno.env.get("AZBA_CLE") || "").trim();
  const basic = (Deno.env.get("AZBA_BASIC") || "").trim();
  if (!cle || !basic) {
    return reponseJson({ erreur: "identifiants AZBA absents",
      aide: "Ajouter les secrets AZBA_CLE (clé de signature) et AZBA_BASIC (identifiant:motdepasse) "
        + "dans Supabase > Edge Functions > Secrets. Ces valeurs ne doivent jamais figurer dans GitHub." }, 503);
  }
  const cheminLibre = q.get("chemin") || "";
  const brut = q.get("brut") === "1";
  const essais: { chemin: string; http?: number; membres?: number; apercu?: string; note?: string }[] = [];
  try {
    if (cheminLibre) {
      const r = await azbaLit(cheminLibre, cle, basic);
      if (brut) return reponseJson({ chemin: cheminLibre, http: r.http, reponse: r.j ?? r.apercu });
      const z = azbaZonesDe(r.j);
      return reponseJson({ chemin: cheminLibre, http: r.http, total: z ? z.length : 0,
        zones: z ?? [], apercu: z ? undefined : r.apercu }, z ? 200 : 502);
    }
    if (!brut && memoAzba && Date.now() - memoAzba.t < 20 * 60e3) {
      return new Response(memoAzba.corps, { headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
        "X-Cartes-Version": VERSION, "X-Cartes-Azba": "memo",
      } });
    }
    /* 1) le réseau complet : contours ET créneaux en un seul appel */
    {
      const chemin = "v3/r_t_b_as?network=1";
      const r = await azbaLit(chemin, cle, basic);
      const zones = azbaZonesDe(r.j);
      essais.push({ chemin, http: r.http, membres: zones ? zones.length : 0,
        apercu: zones ? undefined : r.apercu.slice(0, 160) });
      if (brut && r.http === 200) return reponseJson({ chemin, http: r.http, reponse: r.j ?? r.apercu });
      if (zones) {
        const avecGeo = zones.filter((z) => z.geometrie).length;
        const corps = JSON.stringify({ maj: new Date().toISOString(),
          source: "SIA — API AZBA v3 (réseau RTBA)", total: zones.length,
          avecGeometrie: avecGeo, zones });
        memoAzba = { t: Date.now(), corps };
        return new Response(corps, { headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
          "X-Cartes-Version": VERSION, "X-Cartes-Azba": "frais",
        } });
      }
    }
    /* 2) secours : la plage publiée, si l'API veut bien la dire */
    let plage: unknown = null;
    try { const rc = await azbaLit("v3/custom/currentDate", cle, basic);
      essais.push({ chemin: "v3/custom/currentDate", http: rc.http, apercu: rc.apercu.slice(0, 160) });
      plage = rc.j; } catch { /* pas bloquant */ }
    const d0 = new Date(), d1 = new Date(Date.now() + 48 * 3600e3);
    /* dates de la plage officielle si elle en donne, sinon 48 h glissantes */
    let deb0 = "", fin0 = "";
    if (plage && typeof plage === "object") {
      const po = plage as Record<string, unknown>;
      deb0 = String(azbaPrend(po, ["debut", "start", "startdate", "from", "debutintervaltemps"]) ?? "");
      fin0 = String(azbaPrend(po, ["fin", "end", "enddate", "to", "finintervaltemps"]) ?? "");
    }
    const jeux: [string, string][] = [];
    if (deb0 && fin0) jeux.push([deb0, fin0]);
    for (let f = 0; f < 4; f++) jeux.push([azbaHorodate(d0, f), azbaHorodate(d1, f)]);
    for (const [a, b] of jeux) {
      const chemin = "v3/r_t_b_as?itemsPerPage=600"
        + "&debutIntervalTemps=" + encodeURIComponent(a)
        + "&finIntervalTemps=" + encodeURIComponent(b);
      const r = await azbaLit(chemin, cle, basic);
      const zones = azbaZonesDe(r.j);
      essais.push({ chemin: chemin.slice(0, 120), http: r.http,
        membres: zones ? zones.length : 0, apercu: zones ? undefined : r.apercu.slice(0, 160) });
      if (brut && r.http === 200) return reponseJson({ chemin, http: r.http, reponse: r.j ?? r.apercu });
      if (!zones) continue;
      const corps = JSON.stringify({ maj: new Date().toISOString(), source: "SIA — API AZBA v3",
        intervalle: { debut: a, fin: b }, total: zones.length, zones });
      memoAzba = { t: Date.now(), corps };
      return new Response(corps, { headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
        "X-Cartes-Version": VERSION, "X-Cartes-Azba": "frais",
      } });
    }
    return reponseJson({ erreur: "AZBA : l'API n'a rien rendu d'exploitable", essais }, 502);
  } catch (e) {
    return reponseJson({ erreur: "AZBA indisponible", detail: String(e).slice(0, 140), essais }, 502);
  }
}

/* SIGMET : relais vers l'Aviation Weather Center (NOAA), qui sert les SIGMET
   internationaux des FIR (dont les FIR français) en GeoJSON. aviationweather.gov
   n'est pas bloqué pour les IP de datacenter (les METAR de l'appli en viennent
   déjà) ; on ajoute juste l'autorisation CORS pour un usage direct côté carte.
   ?sigmet=1[&fir=LFFF,LFRR,...] -> GeoJSON (filtré aux FIR demandés si fournis) */
async function sigmet(q: URLSearchParams): Promise<Response> {
  const firs = (q.get("fir") || "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
  const u = "https://aviationweather.gov/api/data/isigmet?format=geojson";
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    const texte = await r.text();
    let gj: { type?: string; features?: { properties?: Record<string, unknown> }[] };
    try { gj = JSON.parse(texte); } catch { gj = {}; }
    let feats = (gj && gj.features) || [];
    if (firs.length && feats.length) {
      feats = feats.filter((f) => {
        const p = (f && f.properties) || {};
        const fir = String(p.firId || p.fir || p.icaoId || "").toUpperCase();
        return firs.some((x) => fir.includes(x));
      });
    }
    return new Response(JSON.stringify({ type: "FeatureCollection", features: feats }), {
      headers: {
        "Content-Type": "application/geo+json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
        "X-Cartes-Version": VERSION,
        "X-Sigmet-Http": String(r.status),
      },
    });
  } catch (e) {
    return reponseJson({ erreur: "SIGMET indisponible", detail: String(e).slice(0, 140) }, 502);
  }
}

/* Chasse aux formes : ?chasse=fl050 (ou un type complet) essaie chaque jeu de
   champs postWintem/postTemsi et rapporte les couches presentes dans la reponse
   — pour trouver, en un clic, la forme que SOFIA accepte pour un niveau. */
async function chasse(q: URLSearchParams): Promise<Response> {
  let t = (q.get("chasse") || "").toLowerCase();
  if (/^fl?\d+$/.test(t)) t = "wintemp/fr/france/fl" + t.replace(/\D/g, "").padStart(3, "0");
  const rap: Record<string, unknown>[] = [];
  for (const jeu of opsPour(t)) {
    let texte = "";
    try { texte = await posteSofia(jeu.op, jeu.champs); } catch (e) {
      rap.push({ champs: jeu.champs, erreur: String(e).slice(0, 80) }); continue;
    }
    let liens = recolteSofia(texte);
    if (!liens.length) liens = recolte(texte, SOFIA + "/sofia/pages/");
    const couches = [...new Set(liens.map((l) => l.couche + (l.brut ? " (level brut : " + l.brut + ")" : "")))];
    const ch0 = liens.length ? liens[0].url.replace(/^https?:\/\/[^/]+/, "") : "";
    rap.push({ champs: jeu.champs, liens: liens.length, couches,
      ok: liens.some((l) => memeCouche(t, l.couche)),
      exemple: ch0 ? AERO + ch0 : undefined,
      apercu: liens.length ? undefined : texte.slice(0, 100) });
  }
  return reponseJson({ demande: t, essais: rap });
}

/* Enquête SOFIA : ?opsofia=1 — lit les pages de préparation de vol et leurs
   scripts, et liste TOUTES les opérations Sling (":operation": "postXxx")
   avec leur contexte. Sert à découvrir l'appel NOTAM anonyme (comme
   postWintem / postTemsi pour les cartes) sans ping-pong de sondes. */
async function opSofia(_q: URLSearchParams): Promise<Response> {
  const BASE = "https://sofia-briefing.aviation-civile.gouv.fr";
  const cibles = [
    BASE + "/sofia/pages/prepavol.html",
    BASE + "/sofia/pages/notamsearch.html",
    BASE + "/content/sofia/scripts/prepa/sessionManager.js",
    BASE + "/content/sofia/scripts/prepa/snowtam.js",
    BASE + "/content/sofia/scripts/prepa/firNotams.js",
    BASE + "/content/sofia/scripts/tools/tools_aero.js",
    BASE + "/content/sofia/scripts/navigation.js",
    BASE + "/content/sofia/scripts/tools/check_user_connection.js",
  ];
  const sources: { url: string; http?: number; octets?: number; note?: string;
    operations: { nom: string; contexte: string }[] }[] = [];
  for (const u of cibles) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "*/*" }, redirect: "follow" });
      const texte = await r.text();
      const ops: { nom: string; contexte: string }[] = [];
      const vus = new Set<string>();
      for (const m of texte.matchAll(/["']:operation["']\s*:\s*["']([^"']+)["']/g)) {
        const nom = m[1];
        if (vus.has(nom)) continue;
        vus.add(nom);
        const i = m.index ?? 0;
        ops.push({ nom, contexte: texte.slice(Math.max(0, i - 350), i + 350)
          .replace(/\s+/g, " ") });
        if (ops.length >= 25) break;
      }
      sources.push({ url: u, http: r.status, octets: texte.length, operations: ops });
    } catch (e) {
      sources.push({ url: u, note: String(e).slice(0, 120), operations: [] });
    }
  }
  return reponseJson({ but: "opérations Sling trouvées sur SOFIA (préparation de vol)",
    sources });
}

/* Sonde de page : ?sonde=<url>&motif=<regex>&portee=200&n=8 — extraits du code
   d'une page publique autour d'un motif (pour lire comment SOFIA appelle ses
   services). */
async function sonde(q: URLSearchParams): Promise<Response> {
  const cible = q.get("sonde") || "";
  const motif = q.get("motif") || "postWintem|postTemsi";
  const portee = Math.min(Number(q.get("portee") || "200"), 500);
  const nmax = Math.min(Number(q.get("n") || "8"), 30);
  try {
    const r = await fetch(cible, { headers: { "User-Agent": UA, "Accept": "*/*" }, redirect: "follow" });
    const texte = await r.text();
    const extraits: string[] = [];
    const re = new RegExp(motif, "gi");
    const vus = new Set<string>();
    let m2;
    while ((m2 = re.exec(texte)) && extraits.length < nmax) {
      const e = texte.slice(Math.max(0, m2.index - portee), m2.index + m2[0].length + portee);
      const cle = e.slice(0, 60);
      if (!vus.has(cle)) { vus.add(cle); extraits.push(e); }
      re.lastIndex = m2.index + m2[0].length + portee;
    }
    const scripts = [...texte.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)]
      .map((m) => { try { return new URL(m[1], cible).href; } catch { return m[1]; } }).slice(0, 20);
    return reponseJson({ url: cible, http: r.status, octets: texte.length, scripts, extraits });
  } catch (e) {
    return reponseJson({ url: cible, erreur: String(e).slice(0, 140) }, 502);
  }
}

Deno.serve(async (req: Request) => {
  /* pré-vérification CORS : un fetch avec en-têtes personnalisés commence par
     un OPTIONS ; sans cette réponse, le navigateur dit « Failed to fetch » */
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
      "Access-Control-Max-Age": "86400",
    } });
  }
  const q = new URL(req.url).searchParams;
  if (q.get("version") === "1") return reponseJson({ version: VERSION });
  if (q.get("opsofia") === "1") return opSofia(q);
  if (q.get("sonde")) return sonde(q);
  if (q.get("chasse")) return chasse(q);
  if (q.get("dates") === "1") return datesDe(q);
  if (q.get("autorouter") === "1") {
    const idB = Deno.env.get("AUTOROUTER_ID") || "";
    const mdpB = Deno.env.get("AUTOROUTER_MDP") || "";
    const etat: Record<string, unknown> = {
      AUTOROUTER_ID: idB ? {
        present: true, longueur: idB.length,
        ressembleEmail: /^\S+@\S+\.\S+$/.test(idB.trim()),
        espacesParasites: idB !== idB.trim(),
      } : { present: false },
      AUTOROUTER_MDP: mdpB ? {
        present: true, longueur: mdpB.length,
        espacesParasites: mdpB !== mdpB.trim(),
      } : { present: false },
    };
    if (idB && mdpB) {
      /* NE PAS forcer un jeton neuf ici : chaque appel en consommerait un du
         quota autorouter (20 actifs), ce qui finit par tout bloquer. On se
         contente de reutiliser celui du relais. */
      try {
        const jt = await jetonAutorouter();
        etat.jeton = jt ? "obtenu — l'authentification fonctionne" : "identifiants absents";
      } catch (e) { etat.jeton = String(e).slice(0, 220); }
      const e = await memoEtat("autorouter");
      etat.jetonPartage = e.ligne
        ? { table: true, present: true,
            /* garde tant qu'autorouter l'accepte : l'echeance annoncee ne dit
               pas quand la place se libere chez eux */
            expireDans: Math.round((e.ligne.fin - Date.now()) / 60000) + " min"
              + " (gardé tant qu'il est accepté)" }
        : e.table
          ? { table: true, present: false,
              aide: "table prete : elle attend le premier jeton, qui sera cree des "
                + "qu'une place se liberera chez autorouter" }
          : { table: false, present: false,
              aide: "table relais_memo absente : jouer relais_memo.sql, sinon le relais "
                + "fabrique un jeton par instance et epuise le quota autorouter" };
      /* combien de jetons demandes aujourd'hui : c'est ce chiffre qui a
         derape le 24 aout, il doit rester visible */
      const cj = await memoLit("autorouter_jour");
      let nj = 0;
      if (cj && cj.valeur) {
        try {
          const c = JSON.parse(cj.valeur) as { jour?: string; n?: number };
          if (c.jour === new Date().toISOString().slice(0, 10)) nj = Number(c.n) || 0;
        } catch { /* illisible */ }
      }
      etat.jetonsDuJour = nj + " / " + JETONS_PAR_JOUR
        + (nj <= 1 ? " (normal)" : nj < JETONS_PAR_JOUR ? " (à surveiller)" : " (plafond interne atteint)");
      /* le partage repose sur l'ECRITURE en base — or elle echouait en
         silence. On ecrit une ligne d'essai et on la relit : verdict net. */
      const ess = await memoEcrit("essai_ecriture",
        new Date().toISOString(), Date.now() + 3600e3);
      const relu = await memoLit("essai_ecriture");
      etat.ecriture = ess.ok && relu
        ? "OK — le relais peut ranger son jeton pour les autres instances"
        : (!ess.ok
          ? "ECHEC http " + ess.status + (ess.corps ? " · " + ess.corps : "")
          : "ecrite mais relue VIDE — RLS ? cle de service ?");
      /* la derniere tentative de jeton, TOUTES instances confondues : dit si
         le plafond autorouter est encore plein a l'instant, ou depuis quand
         le jeton se renouvelle normalement */
      const jl = await memoLit("autorouter_journal");
      if (jl) {
        try {
          const t = JSON.parse(jl.valeur) as { quand?: string; evt?: string; motif?: string };
          const min = Math.max(0, Math.round((Date.now() - Date.parse(t.quand || "")) / 60000));
          etat.derniereTentative = { quand: "il y a " + min + " min",
            evt: t.evt || "?", motif: (t.motif || "").slice(0, 400) };
        } catch { /* journal illisible : tant pis */ }
      }
    }
    return reponseJson(etat);
  }
  if (q.get("supaip") === "1") return supAip(q);
  if (q.get("azba") === "1") return azba(q);
  if (q.get("notam") === "1") return notam(q);
  if (q.get("sigmet") === "1") return sigmet(q);
  if (q.get("poste") === "1") return poste(q);
  const type = (q.get("type") || q.get("layer") || "").toLowerCase();
  const date = (q.get("date") || q.get("echeance") || "").replace(/\D/g, "");
  if (!type || !date) {
    return reponseJson({ erreur: "paramètres attendus : type (ex. sigwx/fr/france) et date (AAAAMMJJHH0000)", version: VERSION }, 400);
  }
  const souple = q.get("souple") === "1";
  const journal: Record<string, unknown>[] = [];
  let lien: Lien | null = null;
  try {
    lien = await viaAeroweb(type, date, journal);
    if (!lien) lien = await viaSofia(type, date, journal, souple);
  } catch (e) {
    journal.push({ erreur: String(e).slice(0, 160) });
  }
  if (q.get("essai") === "1" || q.get("debug") === "1") {
    return reponseJson({ demande: { type, date }, version: VERSION,
      lien: lien ? tronque(lien.url) : null, sofia: journal });
  }
  if (q.get("lien") === "1") {
    return lien ? reponseJson({ url: lien.url, couche: lien.couche, date: lien.date })
      : reponseJson({ erreur: "aucun lien signé obtenu", sofia: journal }, 404);
  }
  /* img=1 : le relais récupère lui-même les octets de l'image et les re-sert
     AVEC l'autorisation CORS. Si aviation.meteo.fr sert l'image à notre serveur
     (comme le proxy de loxodrome), le navigateur peut alors l'intégrer au PDF
     et l'afficher sur Chrome. Sinon, on rapporte l'échec en clair. */
  if (q.get("img") === "1") {
    if (!lien) return reponseJson({ erreur: "aucun lien signé obtenu", sofia: journal }, 404);
    /* Constate en production (25 aout) : le lien resolu vient d'AEROWEB, et
       aviation.meteo.fr refuse les serveurs (403). L'ancien code essayait
       alors CE MEME CHEMIN sur l'hote SOFIA — qui repondait 404, car les
       adresses n'ont rien de commun. Or SOFIA est justement l'hote qui parle
       aux serveurs (les cartes du dossier en viennent). On resout donc AUSSI
       le lien SOFIA, et on l'essaie en premier, sur sa propre adresse. */
    const aEssayer: string[] = [];
    /* 7.36 : l'adresse d'origine EN ENTIER d'abord. Le lien signé de SOFIA
       peut vivre sur un troisième hôte (ni AERO ni SOFIA) ; le réécrire
       perdait cet hôte-là, seul à servir l'image. On essaie donc, dans
       l'ordre : l'adresse telle que donnée, puis son chemin sur SOFIA, puis
       sur AERO. */
    if (lien.urlOrigine) aEssayer.push(lien.urlOrigine);
    try {
      const ls = await viaSofia(type, date, journal, souple);
      if (ls) {
        if (ls.urlOrigine) aEssayer.push(ls.urlOrigine);
        const ch = ls.url.replace(/^https?:\/\/[^/]+/, "");
        aEssayer.push(SOFIA + ch);
        aEssayer.push(AERO + ch);
      }
    } catch (e) { journal.push({ erreur: "viaSofia: " + String(e).slice(0, 120) }); }
    const chemin = lien.url.replace(/^https?:\/\/[^/]+/, "");
    for (const hote of [AERO, SOFIA]) aEssayer.push(hote + chemin);
    const essais: Record<string, unknown>[] = [];
    const dejaVu = new Set<string>();
    for (const cible of aEssayer) {
      if (dejaVu.has(cible)) continue;
      dejaVu.add(cible);
      try {
        /* les témoins de session ne se présentent qu'à l'hôte qui les a posés */
        const enTetes: Record<string, string> = {
          "User-Agent": UA,
          "Accept": "image/avif,image/webp,image/apng,image/png,image/*,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9",
          "Referer": SOFIA + "/sofia/pages/meteosearchtemsi.html",
        };
        const biscuits = presenteTemoins();
        if (biscuits && cible.indexOf(SOFIA) === 0) enTetes["Cookie"] = biscuits;
        const ri = await fetch(cible, { headers: enTetes, redirect: "follow" });
        const ct = ri.headers.get("Content-Type") || "";
        if (ri.ok && /^image\//i.test(ct)) {
          const buf = await ri.arrayBuffer();
          return new Response(buf, { headers: {
            "Content-Type": ct,
            "Cache-Control": "public, max-age=600",
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Timing-Allow-Origin": "*",
            "X-Cartes-Version": VERSION,
            "X-Cartes-Date": lien.date,
            "X-Cartes-Hote": cible.replace(/^https?:\/\//, "").split("/")[0],
          } });
        }
        const t = await ri.text();
        essais.push({ cible: cible.slice(0, 120), http: ri.status, contenu: ct, apercu: t.slice(0, 160) });
      } catch (e) { essais.push({ cible: cible.slice(0, 120), erreur: String(e).slice(0, 120) }); }
    }
    return reponseJson({ erreur: "octets d'image non obtenus côté serveur",
      version: VERSION, lien: tronque(lien.url), date: lien.date, essais }, 502);
  }
  if (lien) {
    return new Response(null, { status: 302, headers: {
      "Location": lien.url,
      "Cache-Control": "private, max-age=240",
      "Access-Control-Allow-Origin": "*",
      "X-Cartes-Version": VERSION,
      "X-Cartes-Voie": "redirection",
      "X-Cartes-Couche": lien.couche,
      "X-Cartes-Date": lien.date,
    } });
  }
  return reponseJson({ erreur: "aucun lien signé obtenu pour cette couche", demande: { type, date }, sofia: journal }, 404);
});
