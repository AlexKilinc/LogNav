/* faux_meteo.js — doublure de SOFIA-Briefing (catalogue météo) et
   d'aviation.meteo.fr (le PDF), pour prouver le client ICI : l'accès sortant
   vers ces deux hôtes est refusé par la politique réseau de cette session.

   Elle n'est pas complaisante. Elle applique la note technique à la lettre et
   RECRACHE une erreur sur chacun de ses pièges :

     · POST sans JSESSIONID                              -> HTTP 403
     · postsaveinsessionprepa rend « » (vide), PAS le catalogue
       (le lire comme résultat final est le piège n°3)
     · status.message est une CHAÎNE de JSON : double décodage obligatoire
     · expiration == date, TOUJOURS — et jamais une fin de validité
     · le lien rendu est RELATIF et porte un login éphémère
     · zone inconnue -> { "message": "No content" }
     · pas de Content-Type urlencodé                     -> HTTP 415

   Le catalogue est bâti autour d'une heure de référence passée en paramètre,
   pour que le banc puisse éprouver « en vigueur », « à venir » et « périmée »
   sans dépendre de l'heure qu'il est.

   Options (variables d'environnement, pour les cas tordus du banc) :
     FM_TROU=1      retire l'échéance du milieu — un trou au catalogue
     FM_EXPDIFF=1   fait différer expiration de date — changement de schéma
     FM_HTML=1      le « PDF » rendu est en fait du HTML servi en 200
     FM_VIDE=1      catalogue vide (No content)
     FM_AEROWEB=1   AEROWEB répond ; sinon il rend 403 (pas d'identifiant)
*/
const http = require("http");
const { randomUUID } = require("crypto");

const sessions = new Set();
const opt = (n) => process.env["FM_" + n] === "1";

/* ---- un vrai PDF minimal, valide, d'un peu plus de 1 ko ---- */
function fabriquePdf(titre) {
  const contenu = "BT /F1 18 Tf 40 700 Td (" + titre.replace(/[()\\]/g, "") + ") Tj ET";
  const objets = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
      + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length " + contenu.length + " >>\nstream\n" + contenu + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const pos = [];
  objets.forEach((o, i) => { pos.push(pdf.length); pdf += (i + 1) + " 0 obj\n" + o + "\nendobj\n"; });
  /* Rembourrage : le client refuse un PDF de moins de 1 ko, et un vrai TEMSI
     en fait des centaines. Il se pose ICI, en commentaire, AVANT la table de
     références — et surtout pas après « %%EOF », qui doit rester le dernier
     mot du fichier. Le mettre en queue produisait un PDF qu'aucun lecteur
     strict n'aurait accepté : une doublure doit être fidèle jusque dans sa
     ponctuation, sinon elle valide des choses qui échoueront en vrai. */
  pdf += "%" + "x".repeat(1400) + "\n";
  const xref = pdf.length;
  pdf += "xref\n0 " + (objets.length + 1) + "\n0000000000 65535 f \n"
    + pos.map((p) => String(p).padStart(10, "0") + " 00000 n \n").join("");
  pdf += "trailer\n<< /Size " + (objets.length + 1) + " /Root 1 0 R >>\nstartxref\n"
    + xref + "\n%%EOF\n";
  return Buffer.from(pdf, "latin1");
}

/* ---- le catalogue, bâti autour d'une référence ---- */
function pad(n) { return String(n).padStart(2, "0"); }
function fmtSofia(d) {
  return pad(d.getUTCDate()) + " " + pad(d.getUTCMonth() + 1) + " " + d.getUTCFullYear()
    + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
}
function fmtEcheance(d) {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
    + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00";
}
/* REFERENCE : par défaut une heure ronde de multiple de 3 h, pour que le banc
   sache exactement ce qu'il doit trouver. Réglable par FM_REF (ISO). */
function reference() {
  const t = process.env.FM_REF ? Date.parse(process.env.FM_REF) : Date.now();
  const d = new Date(t);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(Math.floor(d.getUTCHours() / 3) * 3);
  return d;
}
/* Quatre échéances : une passée, celle en cours, deux à venir. */
function echeances() {
  const r = reference();
  const l = [-3, 0, 3, 6].map((h) => new Date(r.getTime() + h * 3600e3));
  if (opt("TROU")) l.splice(2, 1);      /* on retire +3 h : un trou */
  return l;
}
const NIVEAU = { "temsi/FRANCE": "FL20-150", "temsi/EUROC": "FL20-450",
                 "wintem/FRANCE": "FL20-100" };
const COUCHE = { "temsi/FRANCE": "sigwx/fr/france", "temsi/EUROC": "sigwx/fr/teuroc",
                 "wintem/FRANCE": "wintemp/fr/france/fl020" };

function catalogue(fam, zone) {
  const cle = fam + "/" + zone;
  if (!NIVEAU[cle]) return { message: "No content" };
  const liste = echeances().map((d) => {
    const dt = fmtSofia(d);
    return {
      type: fam === "temsi" ? "TEMSI" : "WINTEM",
      level: NIVEAU[cle], zone,
      date: dt,
      /* PIÈGE : expiration vaut date. Toujours. */
      expiration: opt("EXPDIFF") ? fmtSofia(new Date(d.getTime() + 3600e3)) : dt,
      deadline: pad(d.getUTCHours()) + " UTC",
      /* lien RELATIF, avec un login éphémère */
      link: "/FR/aviation/affiche_image.php?login=" + randomUUID().slice(0, 12)
        + "&layer=" + COUCHE[cle] + "&echeance=" + fmtEcheance(d),
    };
  });
  const o = { zones: [{ id: zone, name: zone }] };
  o.zones[0][fam] = liste;
  return o;
}

/* ---- décodage x-www-form-urlencoded en gardant les répétitions ---- */
function paires(c) {
  return c.split("&").filter(Boolean).map((m) => {
    const i = m.indexOf("=");
    return [decodeURIComponent((i < 0 ? m : m.slice(0, i)).replace(/\+/g, " ")),
            decodeURIComponent((i < 0 ? "" : m.slice(i + 1)).replace(/\+/g, " "))];
  });
}
const une = (ps, k) => { const t = ps.filter((x) => x[0] === k); return t.length ? t[0][1] : undefined; };
const rep = (res, code, corps, ent = {}) => {
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=UTF-8" }, ent));
  res.end(typeof corps === "string" ? corps : JSON.stringify(corps));
};

const serveur = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  /* ---- SOFIA : les deux pages de recherche posent le JSESSIONID ---- */
  if (req.method === "GET" && /^\/sofia\/pages\/meteosearch(temsi|wintem)\.html$/.test(url.pathname)) {
    const sid = randomUUID().replace(/-/g, "").toUpperCase();
    sessions.add(sid);
    res.writeHead(200, { "Content-Type": "text/html; charset=UTF-8",
      "Set-Cookie": "JSESSIONID=" + sid + ";Path=/;HttpOnly" });
    return res.end("<!doctype html><html><body>formulaire</body></html>");
  }

  /* ---- SOFIA : l'endpoint applicatif ---- */
  if (req.method === "POST" && url.pathname === "/sofia") {
    let brut = "";
    req.on("data", (c) => (brut += c));
    req.on("end", () => {
      if (!/application\/x-www-form-urlencoded/i.test(req.headers["content-type"] || "")) {
        return rep(res, 415, { error: "Unsupported Media Type" });
      }
      const m = (req.headers["cookie"] || "").match(/JSESSIONID=([^;\s]+)/);
      if (!m || !sessions.has(m[1])) return rep(res, 403, { error: "Session invalide" });

      const ps = paires(brut);
      const op = une(ps, ":operation");
      const zone = une(ps, "zone") || "";

      /* la préparation ne rend PAS le catalogue : c'est le piège n°3 */
      if (op === "postsaveinsessionprepa") {
        return rep(res, 200, { "status.code": "200", "status.message": "" });
      }
      if (op === "postTemsi" || op === "postWintem") {
        const fam = op === "postTemsi" ? "temsi" : "wintem";
        const cat = opt("VIDE") ? { message: "No content" } : catalogue(fam, zone);
        /* DOUBLE ENCODAGE : status.message est une CHAÎNE de JSON */
        return rep(res, 200, { "status.code": "200", "status.message": JSON.stringify(cat) });
      }
      return rep(res, 400, { error: "opération inconnue : " + op });
    });
    return;
  }

  /* ---- Météo-France : le document ---- */
  if (req.method === "GET" && url.pathname === "/FR/aviation/affiche_image.php") {
    const layer = url.searchParams.get("layer") || "";
    const ech = url.searchParams.get("echeance") || "";
    if (!url.searchParams.get("login")) return rep(res, 403, { error: "login absent" });
    if (!layer || !ech) return rep(res, 400, { error: "layer et echeance attendus" });
    /* le cas vicieux : 200 + Content-Type application/pdf, mais du HTML */
    if (opt("HTML")) {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      return res.end("<html><body>Service momentanément indisponible</body></html>");
    }
    const buf = fabriquePdf(layer + " " + ech);
    res.writeHead(200, { "Content-Type": "application/pdf",
      "Content-Length": String(buf.length) });
    return res.end(buf);
  }

  /* ---- AEROWEB : la voie officielle, sous convention ---- */
  if (req.method === "GET" && url.pathname === "/FR/aviation/serveur_donnees.jsp") {
    if (!opt("AEROWEB")) { res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("acces refuse"); }
    const vue = url.searchParams.get("VUE_CARTE") || "";
    const alt = url.searchParams.get("ALTITUDE") || "";
    const zn = (url.searchParams.get("ZONE") || "").toUpperCase();
    const cle = /WINTEM/.test(vue) ? "wintem/FRANCE"
      : (/EUROC/.test(zn) ? "temsi/EUROC" : "temsi/FRANCE");
    const couche = /WINTEM/.test(vue) ? "wintemp/fr/france/fl" + (alt || "020") : COUCHE[cle];
    const liens = echeances().map((d) =>
      "<carte>https://aviation.meteo.fr/FR/aviation/affiche_image.php?login=AW"
      + randomUUID().slice(0, 8) + "&amp;layer=" + couche
      + "&amp;echeance=" + fmtEcheance(d) + "</carte>").join("\n");
    res.writeHead(200, { "Content-Type": "text/xml; charset=UTF-8" });
    return res.end('<?xml version="1.0"?>\n<cartes>\n' + liens + "\n</cartes>");
  }

  rep(res, 404, { error: "Not found" });
});

function demarre(port = 0) {
  return new Promise((r) => serveur.listen(port, "127.0.0.1", () => r(serveur.address().port)));
}
function arrete() { return new Promise((r) => serveur.close(r)); }

module.exports = { demarre, arrete, serveur, reference, echeances, fabriquePdf };

if (require.main === module) {
  /* « 0 » demande un port éphémère — et il faut le lire comme tel : avec un
     « || 8897 », zéro étant falsy, toutes les doublures d'un même banc
     retombaient sur LE MÊME port fixe, et toutes sauf la première échouaient
     à s'attacher sans rien dire. */
  const dem = process.argv[2] !== undefined ? Number(process.argv[2]) : 8897;
  demarre(Number.isFinite(dem) ? dem : 8897).then((p) =>
    console.log("doublure SOFIA météo + Météo-France sur http://127.0.0.1:" + p));
}
