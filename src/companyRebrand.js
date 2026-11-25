/**
 * Documents générés : les modèles Word fournis ont été rédigés pour la société fondatrice
 * (Cible RH Emploi) et contiennent son nom, son BP, son capital, son représentant et ses
 * références « CRHE/... » en TEXTE FIXE. Pour toute autre société (tenant), ces passages
 * sont remplacés par les informations de la société au moment où le document est ouvert,
 * imprimé ou téléchargé (anciens documents compris).
 *
 * Word découpe souvent un même texte en plusieurs morceaux (<w:t>) : le remplacement se fait
 * sur le texte reconstitué de chaque paragraphe, puis est réparti dans les morceaux.
 */
const PizZip = require("pizzip");
const { db } = require("./store");

function tenantOf(tid) { return (db.tenants || []).find(t => t.id === (tid || "t1")) || null; }

/** La société fondatrice garde ses modèles tels quels. */
function isFounding(tid) {
  const t = tenantOf(tid);
  if ((tid || "t1") === "t1") return true;
  return !!(t && /cible\s*rh/i.test(t.name || ""));
}

function companyOf(tid) {
  const t = tenantOf(tid) || {};
  let co = {};
  try { const s = require("./routes/settings").settings(tid); co = Object.assign({}, (s.branding && s.branding.company) || {}, ((s.branding && s.branding.letterhead) || {}).company || {}); } catch (e) {}
  const name = String(t.name || co.name || "").trim();
  const city = String(t.hqCity || co.city || "").trim();
  const bp = String(t.bp || "").trim();
  const bpFull = bp ? ("BP " + bp + (city ? " " + city : "")) : String(co.address || t.hqAddress || city || "").trim();
  const capRaw = String(t.shareCapital || co.capital || "").replace(/\s/g, "");
  const capital = /^\d+$/.test(capRaw) ? Number(capRaw).toLocaleString("fr-FR").replace(/[  ,]/g, " ") : capRaw;
  const rep = String(t.legalRep || co.dg || "").trim();
  const repTitle = String(t.legalRepTitle || "Directeur Général").trim();
  const acronym = String(t.acronym || name.split(/\s+/)[0] || "").trim().toUpperCase();
  return { name: name.toUpperCase(), city, bpFull, capital, rep, repTitle, acronym };
}

/** Paires [texte Cible, texte de la société], de la plus longue à la plus courte. */
function pairsFor(tid) {
  const c = companyOf(tid);
  const N = c.name || "LA SOCIÉTÉ";
  const rep = c.rep || "son représentant légal";
  return [
    ["CIBLE RH EMPLOI SA au capital de 35 000 000 FCFA dont le siège social est à Douala",
      N + (c.capital ? " au capital de " + c.capital + " FCFA" : "") + (c.city ? " dont le siège social est à " + c.city : "")],
    ["BP 3462 et représentée par Dr Théodoret Marie FANSI, Directeur Général",
      (c.bpFull ? c.bpFull + " " : "") + "et représentée par " + rep + ", " + c.repTitle],
    ["BP : 3462 Douala, représentée par son Directeur Général Dr FANSI Théodoret Marie",
      (c.bpFull ? c.bpFull + ", " : "") + "représentée par son " + c.repTitle + " " + rep],
    ["Dr Théodoret Marie FANSI", rep], ["Dr FANSI Théodoret Marie", rep],
    ["B.P 3462 DOUALA", c.bpFull || c.city], ["B.P 3462 Douala", c.bpFull || c.city], ["BP 3462 Douala", c.bpFull || c.city],
    ["Signature CIBLE RHE", "Signature " + N],
    ["CIBLE RH EMPLOI SA", N], ["CIBLE Rh Emploi SA", N], ["CIBLE RH EMPLOI", N], ["Cible RH Emploi S.A.", N], ["Cible RH Emploi", N],
    ["CIBLE RHE SA", N], ["CIBLE RH SA", N], ["CIBLE RHE", N], ["CIBLE RH", N],
    ["CRHE/", (c.acronym || "REF") + "/"],
  ].filter(p => p[1] !== undefined && p[1] !== null);
}

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Remplace dans un paragraphe Word, même quand le texte est découpé en plusieurs <w:t>. */
function replaceInParagraph(pXml, pairs) {
  const re = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
  const nodes = []; let m;
  // Espaces insécables (fréquents avant « : » et dans les montants) traitées comme des espaces normales.
  while ((m = re.exec(pXml))) nodes.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] || "", text: xmlUnesc(m[2]).replace(/[  ]/g, " "), changed: false });
  if (!nodes.length) return pXml;
  let full = nodes.map(n => n.text).join("");
  if (!pairs.some(([a]) => full.includes(a))) return pXml;
  for (const [find, repl] of pairs) {
    let from = 0, idx;
    while ((idx = full.indexOf(find, from)) >= 0) {
      // position -> (morceau, décalage)
      let acc = 0, si = -1, so = 0, ei = -1, eo = 0; const endPos = idx + find.length;
      for (let i = 0; i < nodes.length; i++) {
        const L = nodes[i].text.length;
        if (si < 0 && idx < acc + L) { si = i; so = idx - acc; }
        if (ei < 0 && endPos <= acc + L) { ei = i; eo = endPos - acc; break; }
        acc += L;
      }
      if (si < 0 || ei < 0) break;
      if (si === ei) { const t = nodes[si].text; nodes[si].text = t.slice(0, so) + repl + t.slice(eo); }
      else {
        nodes[si].text = nodes[si].text.slice(0, so) + repl;
        for (let k = si + 1; k < ei; k++) { nodes[k].text = ""; nodes[k].changed = true; }
        nodes[ei].text = nodes[ei].text.slice(eo); nodes[ei].changed = true;
      }
      nodes[si].changed = true;
      full = nodes.map(n => n.text).join("");
      from = idx + repl.length;
    }
  }
  let out = pXml;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]; if (!n.changed) continue;
    const attrs = /xml:space=/.test(n.attrs) ? n.attrs : n.attrs + ' xml:space="preserve"';
    out = out.slice(0, n.start) + "<w:t" + attrs + ">" + xmlEsc(n.text) + "</w:t>" + out.slice(n.end);
  }
  return out;
}
function replaceInXml(xml, pairs) {
  return xml.replace(/<w:p[\s>][\s\S]*?<\/w:p>/g, (p) => replaceInParagraph(p, pairs));
}

/** Logo de la société (data-URL) : fiche société, sinon paramètres de marque. */
function logoOf(tid) {
  const t = tenantOf(tid) || {};
  let src = t.logo || "";
  if (!src) { try { const b = require("./routes/settings").settings(tid).branding || {}; src = b.logo || ""; } catch (e) {} }
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(src || ""));
  return m ? { ext: m[1].toLowerCase() === "png" ? "png" : "jpeg", buf: Buffer.from(m[2], "base64") } : null;
}
/** Images d'en-tête (logo Cible) : remplacées par le logo de la société, ou retirées s'il n'y en a pas. */
function swapHeaderLogos(zip, tid) {
  const logo = logoOf(tid); let touched = false;
  for (const relF of Object.keys(zip.files).filter(f => /^word\/_rels\/header\d*\.xml\.rels$/.test(f))) {
    const hdrF = "word/" + relF.replace(/^word\/_rels\//, "").replace(/\.rels$/, "");
    let rels = zip.file(relF).asText(); let hdr = zip.file(hdrF) ? zip.file(hdrF).asText() : "";
    const imgs = [...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"[^>]*\/>/g)]
      .concat([...rels.matchAll(/<Relationship\b[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"[^>]*\/>/g)].map(m => [m[0], m[2], m[1]]));
    for (const [, rid, target] of imgs) {
      if (!hdr.includes(`r:embed="${rid}"`)) continue;
      if (logo) {
        const newTarget = target.replace(/\.[a-z]+$/i, "") + "_societe." + logo.ext;
        zip.file("word/" + newTarget.replace(/^\.?\//, ""), logo.buf);
        rels = rels.split(`Target="${target}"`).join(`Target="${newTarget}"`);
        let ct = zip.file("[Content_Types].xml").asText();
        if (!new RegExp(`Extension="${logo.ext}"`, "i").test(ct)) {
          ct = ct.replace(/(<Types[^>]*>)/, `$1<Default Extension="${logo.ext}" ContentType="image/${logo.ext}"/>`);
          zip.file("[Content_Types].xml", ct);
        }
      } else {
        hdr = hdr.replace(new RegExp(`<w:drawing>(?:(?!</w:drawing>)[\\s\\S])*r:embed="${rid}"[\\s\\S]*?</w:drawing>`, "g"), "");
      }
      touched = true;
    }
    if (touched) { zip.file(relF, rels); if (hdr) zip.file(hdrF, hdr); }
  }
  return touched;
}

/** Document Word (Buffer) -> Buffer avec les informations de la société du tenant. */
function rebrandDocx(buf, tid) {
  if (isFounding(tid)) return buf;
  const pairs = pairsFor(tid);
  const zip = new PizZip(buf);
  let touched = swapHeaderLogos(zip, tid);
  for (const f of Object.keys(zip.files)) {
    if (!/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f)) continue;
    const xml = zip.file(f).asText(); const out = replaceInXml(xml, pairs);
    if (out !== xml) { zip.file(f, out); touched = true; }
  }
  return touched ? zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) : buf;
}
/** Document HTML généré (texte) -> texte avec les informations de la société du tenant. */
function rebrandText(txt, tid) {
  if (isFounding(tid)) return txt;
  let s = String(txt); for (const [a, b] of pairsFor(tid)) s = s.split(a).join(xmlEsc(b));
  return s;
}

module.exports = { rebrandDocx, rebrandText, isFounding, companyOf, pairsFor, replaceInXml };
