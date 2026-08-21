/* LogNavAK — relais « cartes » : sert les cartes TEMSI / WINTEM à l'application.
 *
 * Pourquoi un relais : les images d'aviation.meteo.fr ne sont servies qu'avec
 * un jeton de session périssable (celui d'un compte Aéroweb connecté). Une
 * adresse recopiée meurt en quelques heures. Ce relais va donc, à chaque
 * demande, récolter un lien frais dans des pages publiques qui en affichent
 * (loxodrome.fr, SOFIA-Briefing, Aéroweb mobile), puis renvoie l'image.
 *
 * Appels :
 *   GET ?type=sigwx/fr/france&date=20260821210000   -> l'image (PNG/GIF)
 *   GET ?debug=1                                    -> rapport JSON de récolte
 *   GET ?debug=1&type=...&date=...                  -> rapport + choix détaillé
 *
 * Déploiement : Supabase > Edge Functions > nouvelle fonction « cartes »,
 * coller ce fichier, déployer, puis DÉSACTIVER « Enforce JWT verification »
 * (les cartes sont des données publiques ; l'appli les charge par <img>, qui
 * ne peut pas envoyer d'en-tête d'autorisation). Aucun secret requis.
 *
 * Option pour plus tard : si un code AEROWEB officiel est obtenu (convention
 * Météo-France), le poser en secret AEROWEB_ID — le relais l'utilisera en
 * premier, c'est la voie la plus fiable.
 */

const AERO = "https://aviation.meteo.fr";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/* Pages publiques où des liens d'images fraîchement signés peuvent se trouver. */
const SOURCES = [
  "https://loxodrome.fr/",
  "https://sofia-briefing.aviation-civile.gouv.fr/sofia/pages/meteotemsi.html",
  "https://sofia-briefing.aviation-civile.gouv.fr/sofia/pages/meteowintem.html",
  "https://aviation-mobile.meteo.fr/",
];

/* Couche demandée (type=) -> paramètres de l'API AEROWEB officielle (si ID). */
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

async function attrape(url: string, ms: number): Promise<{ http: number; texte: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": UA, "Accept": "*/*" },
      redirect: "follow",
    });
    const texte = await r.text();
    return { http: r.status, texte };
  } catch (e) {
    return { http: 0, texte: String(e).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

/* Un lien d'image récolté : couche, validité, adresse complète. */
type Lien = { url: string; couche: string; date: string };

/* Déterre toutes les adresses affiche_image.php d'un texte, quelles que soient
   les échappures (\/ des JSON, &amp; du HTML) et la forme des paramètres
   (layer=/echeance= comme type=/date=). */
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

/* Adresses des scripts d'une page (pour fouiller le JavaScript des pages qui
   construisent leurs images côté client). */
function scriptsDe(texte: string, origine: string, nmax = 6): string[] {
  const out: string[] = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(texte)) && out.length < nmax) {
    try { out.push(new URL(m[1], origine).href); } catch { /* ignore */ }
  }
  return out;
}

/* Pistes en clair (rapport debug) : bouts d'URL parlant de cartes météo. */
function pistes(texte: string): string[] {
  const re = /[A-Za-z0-9_\/.{}$-]{0,50}(?:temsi|wintem|sigwx|meteo\/image|carte)[A-Za-z0-9_\/.?=&{}$-]{0,70}/gi;
  const vus = new Set<string>();
  for (const m of texte.match(re) || []) {
    if (vus.size >= 12) break;
    vus.add(m);
  }
  return [...vus];
}

function tronque(u: string): string {
  return u.replace(/(login=[^&]{6})[^&]*/, "$1……");
}

function reponseJson(objet: unknown, statut = 200): Response {
  return new Response(JSON.stringify(objet, null, 1), {
    status: statut,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

/* Mode sonde : quand la récolte simple ne trouve rien, extraire le code qui
   entoure les mots-clés dans les pages et scripts des sources — c'est là que
   se lit la façon dont elles demandent leurs cartes.
   ?sonde=auto                        -> jeu d'extraits choisi d'avance
   ?sonde=<adresse>&motif=<regex>     -> extraits sur mesure d'une page donnée */
async function sonde(q: URLSearchParams): Promise<Response> {
  const cible = q.get("sonde") || "";
  const travaux: { url: string; motif: string }[] = [];
  const rap: Record<string, unknown>[] = [];
  const MOTIF_CHASSE = "affiche_image|serveur_donnees|aeroweb|sigwx/|wintemp/|temsi\\.|getTemsi|getWintem|/meteo/";
  if (cible === "auto") {
    /* Loxodrome : application monopage — le code des cartes vit dans des
       morceaux chargés à la demande, dont les noms sont inscrits dans le
       paquet d'entrée. On les énumère, puis on fouille chacun. */
    const acc = await attrape("https://loxodrome.fr/", 8000);
    for (const j of scriptsDe(acc.texte, "https://loxodrome.fr/", 3)) {
      const entree = await attrape(j, 9000);
      const noms = new Set<string>();
      for (const c of entree.texte.match(/assets\/[A-Za-z0-9._-]+\.js/g) || []) noms.add(c);
      travaux.push({ url: j, motif: MOTIF_CHASSE });
      for (const n of [...noms].slice(0, 14)) {
        if (j.endsWith(n)) continue;
        travaux.push({ url: new URL("/" + n, "https://loxodrome.fr/").href, motif: MOTIF_CHASSE });
      }
    }
    /* SOFIA : la page charge beaucoup de scripts — on les liste TOUS, et on
       fouille ceux dont le nom évoque la météo ou la préparation. */
    for (const page of [
      "https://sofia-briefing.aviation-civile.gouv.fr/sofia/pages/meteotemsi.html",
      "https://sofia-briefing.aviation-civile.gouv.fr/sofia/pages/meteowintem.html",
    ]) {
      const rp = await attrape(page, 9000);
      const tous = scriptsDe(rp.texte, page, 60);
      rap.push({ url: page, http: rp.http, scripts: tous });
      for (const sc of tous.filter((u) => /temsi|wintem|meteo|carte|prepa|image/i.test(u)).slice(0, 8)) {
        travaux.push({ url: sc, motif: MOTIF_CHASSE + "|\\$\\.ajax|\\.php" });
      }
    }
  } else {
    travaux.push({ url: cible, motif: q.get("motif") || "temsi|wintem|affiche_image" });
  }
  const portee = Math.min(Number(q.get("portee") || "150"), 400);
  const nmax = Math.min(Number(q.get("n") || "8"), 40);
  let muets = 0;
  for (const t of travaux) {
    const r = await attrape(t.url, 9000);
    const extraits: string[] = [];
    try {
      const re = new RegExp(t.motif, "gi");
      const vus = new Set<string>();
      let m;
      while ((m = re.exec(r.texte)) && extraits.length < nmax) {
        const e = r.texte.slice(Math.max(0, m.index - portee), m.index + m[0].length + portee);
        const cle = e.slice(0, 60);
        if (!vus.has(cle)) { vus.add(cle); extraits.push(e); }
        re.lastIndex = m.index + m[0].length + portee;
      }
    } catch (e) { extraits.push("motif irrecevable : " + String(e).slice(0, 80)); }
    /* les fichiers muets n'encombrent pas le rapport : on les compte —
       sauf quand la fouille est ciblée, où chaque réponse compte */
    if (extraits.length || r.http !== 200 || travaux.length <= 2) {
      rap.push({ url: t.url, http: r.http, octets: r.texte.length, extraits });
    } else muets++;
  }
  return reponseJson({ fouilles: travaux.length, muets, sonde: rap });
}

/* Voie directe : SOFIA hotlinke les images d'aviation.meteo.fr sans jeton ;
   le serveur semble filtrer sur l'en-tête Referer. Le relais essaie donc
   l'adresse construite, coiffée du Referer des pages SOFIA. */
function refererPour(type: string): string {
  const p = type.startsWith("wintemp") ? "meteosearchwintem" : "meteosearchtemsi";
  return "https://sofia-briefing.aviation-civile.gouv.fr/sofia/pages/" + p + ".html";
}

async function voieDirecte(type: string, date: string): Promise<{ essais: Record<string, unknown>[]; image: Response | null }> {
  const epoch = Math.floor(Date.now() / 1000);
  const u1 = AERO + "/affiche_image.php?time=" + epoch + "&type=" + type + "&date=" + date + "&mode=img&comment=";
  const u2 = AERO + "/FR/aviation/affiche_image.php?time=" + epoch + "&type=" + type + "&date=" + date + "&mode=img&comment=";
  const jeux: { u: string; nom: string; h: Record<string, string> }[] = [
    { u: u1, nom: "referer SOFIA", h: { "Referer": refererPour(type) } },
    { u: u1, nom: "sans referer", h: {} },
    { u: u1, nom: "referer aviation.meteo.fr", h: { "Referer": AERO + "/" } },
    { u: u2, nom: "chemin /FR/aviation + referer SOFIA", h: { "Referer": refererPour(type) } },
  ];
  const essais: Record<string, unknown>[] = [];
  for (const j of jeux) {
    try {
      const r = await fetch(j.u, {
        headers: { "User-Agent": UA, "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8", ...j.h },
        redirect: "follow",
      });
      const ct = r.headers.get("Content-Type") || "";
      if (r.ok && /^image\//i.test(ct)) {
        return { essais, image: new Response(r.body, { headers: {
          "Content-Type": ct, "Cache-Control": "public, max-age=600",
          "Access-Control-Allow-Origin": "*", "X-Cartes-Voie": j.nom, "X-Cartes-Date": date,
        } }) };
      }
      /* pas une image : on lit un bout de la réponse, elle dit souvent pourquoi */
      const corps = (await r.text()).slice(0, 220);
      essais.push({ essai: j.nom, http: r.status, contenu: ct, apercu: corps });
    } catch (e) {
      essais.push({ essai: j.nom, http: 0, erreur: String(e).slice(0, 120) });
    }
  }
  return { essais, image: null };
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  if (q.get("sonde")) return sonde(q);
  const type = (q.get("type") || q.get("layer") || "").toLowerCase();
  const date = (q.get("date") || q.get("echeance") || "").replace(/\D/g, "");
  const debug = q.get("debug") === "1";
  const rapport: Record<string, unknown>[] = [];
  const liens: { lien: Lien; via: string }[] = [];

  /* 0. La voie directe d'abord : c'est elle qui doit marcher au quotidien. */
  if (type && date && !debug) {
    const vd = await voieDirecte(type, date);
    if (vd.image) return vd.image;
    if (q.get("essai") === "1") return reponseJson({ demande: { type, date }, essais: vd.essais });
    rapport.push({ source: "voie directe", essais: vd.essais });
  } else if (q.get("essai") === "1") {
    return reponseJson({ erreur: "essai=1 demande type et date" }, 400);
  }

  /* 1. Voie officielle si un code AEROWEB est posé en secret. */
  const id = Deno.env.get("AEROWEB_ID") || "";
  if (id && type) {
    const pa = paramsAeroweb(type);
    if (pa) {
      const u = AERO + "/FR/aviation/serveur_donnees.jsp?ID=" + encodeURIComponent(id) +
        "&TYPE_DONNEES=CARTES&BASE_COMPLETE=non&" + pa;
      const r = await attrape(u, 9000);
      const trouves = recolte(r.texte, AERO + "/FR/aviation/");
      for (const l of trouves) liens.push({ lien: l, via: "AEROWEB (code officiel)" });
      rapport.push({ source: "AEROWEB serveur_donnees.jsp", http: r.http, liens: trouves.length });
    }
  }

  /* 2. Récolte dans les pages publiques ; on s'arrête dès qu'on a de quoi
     servir la demande (en mode debug on fouille tout, scripts compris). */
  for (const src of SOURCES) {
    const assez = !debug && type && liens.some((x) => x.lien.couche === type);
    if (assez) break;
    const r = await attrape(src, 8000);
    const trouves = recolte(r.texte, src);
    for (const l of trouves) liens.push({ lien: l, via: src });
    const entry: Record<string, unknown> = {
      source: src, http: r.http, octets: r.texte.length, liens: trouves.length,
    };
    if (debug) {
      entry.exemples = trouves.slice(0, 3).map((l) => tronque(l.url));
      entry.scripts = scriptsDe(r.texte, src);
      entry.pistes = pistes(r.texte);
    }
    rapport.push(entry);
    /* Rien dans la page ? Le JavaScript de la page, alors. */
    if (!trouves.length && debug) {
      for (const js of (entry.scripts as string[]).slice(0, 4)) {
        const rj = await attrape(js, 8000);
        const tj = recolte(rj.texte, js);
        for (const l of tj) liens.push({ lien: l, via: js });
        rapport.push({ source: js, http: rj.http, octets: rj.texte.length, liens: tj.length, pistes: pistes(rj.texte) });
      }
    }
  }

  /* 3. Choix : la couche demandée, à la validité la plus proche. */
  let choix: { lien: Lien; via: string } | null = null;
  if (type) {
    const dispo = liens.filter((x) => x.lien.couche === type);
    const cible = Number((date || "0").padEnd(14, "0"));
    dispo.sort((a, b) =>
      Math.abs(Number(a.lien.date || "0") - cible) - Math.abs(Number(b.lien.date || "0") - cible));
    choix = dispo[0] || null;
  }

  if (debug) {
    return new Response(JSON.stringify({
      demande: { type, date }, code_aeroweb: id ? "présent" : "absent",
      choix: choix ? { url: tronque(choix.lien.url), via: choix.via } : null,
      recolte: { total: liens.length }, sources: rapport,
    }, null, 1), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (!type) {
    return new Response(JSON.stringify({ erreur: "paramètre type manquant (ex. type=sigwx/fr/france)" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  }

  /* 4. L'image elle-même — en éliminant les réponses qui n'en sont pas
     (page de connexion servie en HTML, par exemple). */
  const candidats = choix
    ? [choix, ...liens.filter((x) => x.lien.couche === type && x !== choix)].slice(0, 4)
    : [];
  for (const c of candidats) {
    try {
      const r = await fetch(c.lien.url, {
        headers: { "User-Agent": UA, "Referer": c.via.startsWith("http") ? c.via : AERO },
        redirect: "follow",
      });
      const ct = r.headers.get("Content-Type") || "";
      if (r.ok && /^image\//i.test(ct)) {
        return new Response(r.body, {
          headers: {
            "Content-Type": ct,
            "Cache-Control": "public, max-age=600",
            "Access-Control-Allow-Origin": "*",
            "X-Cartes-Date": c.lien.date,
            "X-Cartes-Via": c.via.startsWith("http") ? new URL(c.via).hostname : c.via,
          },
        });
      }
    } catch { /* candidat suivant */ }
  }

  return new Response(JSON.stringify({
    erreur: "aucune image trouvée pour cette couche",
    type, date, recolte: rapport,
  }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
});
