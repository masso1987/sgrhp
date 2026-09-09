/* Générateur .docx minimal (sans docxtemplater) : construit un document Word
   à partir d'une liste de paragraphes { text, bold, italic, size, align }. */
const PizZip = require("pizzip");

const esc = (t) => String(t == null ? "" : t)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function para(p) {
  p = p || {};
  const sz = (p.size || 22);                    // demi-points (22 = 11pt)
  const jc = p.align ? `<w:jc w:val="${p.align}"/>` : "";
  const rpr = `<w:rPr>${p.bold ? "<w:b/>" : ""}${p.italic ? "<w:i/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
  const lines = String(p.text == null ? "" : p.text).split("\n");
  const runs = lines.map((ln, i) => `<w:r>${rpr}${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(ln)}</w:t></w:r>`).join("");
  return `<w:p><w:pPr>${jc}<w:spacing w:after="120"/></w:pPr>${runs}</w:p>`;
}

function buildDocx(paragraphs) {
  const body = (paragraphs || []).map(para).join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const zip = new PizZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("word/document.xml", documentXml);
  return zip.generate({ type: "nodebuffer" });
}

module.exports = { buildDocx };
