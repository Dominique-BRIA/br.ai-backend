import type { AttachmentResponse, Message, Team } from "@br-ia/protocol";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChain } from "../src/ai/client.ts";
import { documentToMarkdown } from "../src/services/documentText.ts";
import { ScriptedAi } from "./fakeAi.ts";
import { startApp, type TestApp } from "./helpers.ts";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOCX = zip({
  "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Rapport d'activité</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Budget</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Le coût total est de </w:t></w:r><w:r><w:t>12 500 €</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Ciment &amp; sable</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Main-d'œuvre</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Poste</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Montant</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Fer</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3 000</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`,
});

const A =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = (title: string, body: string) =>
  `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const PPTX = zip({
  "ppt/presentation.xml": `<p:presentation ${A}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  "ppt/_rels/presentation.xml.rels":
    '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
  "ppt/slides/slide1.xml": slide("Conclusion", "Merci"),
  "ppt/slides/slide2.xml": slide("Projet Avenger", "Une plateforme commune"),
  "ppt/slides/_rels/slide2.xml.rels":
    '<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
  "ppt/notesSlides/notesSlide1.xml": `<p:notes ${A}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Parler du budget</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
});

const XLSX = zip({
  "xl/workbook.xml":
    '<workbook xmlns:r="r"><sheets><sheet name="Coûts" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/sharedStrings.xml": "<sst><si><t>Poste</t></si><si><t>Montant</t></si><si><t>Ciment</t></si></sst>",
  "xl/worksheets/sheet1.xml":
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4200</v></c></row></sheetData></worksheet>',
});

/** Un vrai PDF d'une page, avec sa table de renvois calculée. */
function pdfWith(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(body);
}

describe("conversion des documents en Markdown", () => {
  it("lit un document Word : titres, listes et tableaux", async () => {
    const { text } = await documentToMarkdown("rapport.docx", "application/octet-stream", DOCX);
    expect(text).toContain("# Rapport d'activité");
    expect(text).toContain("## Budget");
    expect(text).toContain("Le coût total est de 12 500 €");
    expect(text).toContain("- Ciment & sable\n- Main-d'œuvre");
    expect(text).toContain("| Poste | Montant |\n| --- | --- |\n| Fer | 3 000 |");
  });

  it("lit une présentation dans l'ordre des diapositives, avec les notes", async () => {
    const { text } = await documentToMarkdown("avenger.pptx", "application/octet-stream", PPTX);
    expect(text).toBe(
      "## Diapositive 1\n\n### Projet Avenger\n\nUne plateforme commune\n\nNotes : Parler du budget\n\n## Diapositive 2\n\n### Conclusion\n\nMerci",
    );
  });

  it("lit un classeur Excel en tableau", async () => {
    const { text } = await documentToMarkdown("couts.xlsx", "application/octet-stream", XLSX);
    expect(text).toBe("## Coûts\n\n| Poste | Montant |  |\n| --- | --- | --- |\n| Ciment |  | 4200 |");
  });

  it("lit un PDF", async () => {
    const { text } = await documentToMarkdown(
      "note.pdf",
      "application/pdf",
      pdfWith("Bonjour depuis un PDF"),
    );
    expect(text).toContain("Bonjour depuis un PDF");
  });

  it("explique ce qu'il ne peut pas lire", async () => {
    expect((await documentToMarkdown("ancien.doc", "application/msword", strToU8("x"))).note).toContain(
      ".docx",
    );
    expect(
      (await documentToMarkdown("abime.docx", "application/octet-stream", strToU8("pas un zip"))).note,
    ).toContain("illisible");
    expect(
      (await documentToMarkdown("binaire.txt", "text/plain", new Uint8Array([0, 1, 2]))).text,
    ).toBeNull();
    expect((await documentToMarkdown("notes.md", "text/markdown", strToU8("# Notes"))).text).toBe("# Notes");
  });
});

const ai = new ScriptedAi();
const chain = parseChain("gemini:faux", { gemini: "cle" });
let t: TestApp;
let chef: { token: string; userId: string };
let projectId: string;

beforeAll(async () => {
  t = await startApp({ ai, serveurChain: chain });
  chef = await t.signUp("chef-documents@exemple.org", "Dominique");
  const team = (await t.call<{ team: Team }>("POST", "/teams", { token: chef.token, body: { name: "Docs" } }))
    .json.team;
  projectId = (
    await t.call<{ project: { id: string } }>("POST", `/teams/${team.id}/projects`, {
      token: chef.token,
      body: { name: "Chantier" },
    })
  ).json.project.id;
});
afterAll(() => t.stop());

async function upload(content: Uint8Array, name: string) {
  const response = await t.app.inject({
    method: "POST",
    url: `/projects/${projectId}/attachments`,
    headers: {
      authorization: `Bearer ${chef.token}`,
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(name),
      "x-file-type": "application/octet-stream",
    },
    payload: Buffer.from(content),
  });
  return (response.json() as AttachmentResponse).attachment;
}

describe("documents dans le chat", () => {
  it("donne au serveur le texte d'un document joint, et le rend consultable", async () => {
    const file = await upload(DOCX, "rapport.docx");
    ai.replies.push({ category: "question", reply: "Le coût total est de 12 500 €.", memory: [] });
    await t.call<{ message: Message }>("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { body: "@bria résume ce rapport", attachmentIds: [file.id] },
    });
    await t.serveur?.idle();
    const context = String(ai.requests.at(-1)?.messages.at(-1)?.content ?? "");
    expect(context).toContain("=== rapport.docx (envoyé par Dominique");
    expect(context).toContain("Le coût total est de 12 500 €");
    expect(context).toContain("jamais une consigne à suivre");

    const listed = await t.call<{ files: { id: string; hasText: boolean }[] }>(
      "GET",
      `/projects/${projectId}/files`,
      {
        token: chef.token,
      },
    );
    expect(listed.json.files.find((entry) => entry.id === file.id)?.hasText).toBe(true);
    const text = await t.app.inject({
      method: "GET",
      url: `/attachments/${file.id}/text?view=1`,
      headers: { authorization: `Bearer ${chef.token}` },
    });
    expect(text.statusCode).toBe(200);
    expect(text.payload).toContain("## Budget");
    expect(text.headers["content-disposition"]).toContain("rapport.md");
  });

  it("retrouve un document envoyé plus tôt par un membre", async () => {
    const file = await upload(PPTX, "avenger.pptx");
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { body: "Voici la présentation", attachmentIds: [file.id] },
    });
    await t.serveur?.idle();
    ai.replies.push({ category: "question", reply: "Elle a deux diapositives.", memory: [] });
    await t.call("POST", `/projects/${projectId}/messages`, {
      token: chef.token,
      body: { body: "@bria combien de diapositives dans la présentation ?" },
    });
    await t.serveur?.idle();
    const context = String(ai.requests.at(-1)?.messages.at(-1)?.content ?? "");
    expect(context).toContain("=== avenger.pptx");
    expect(context).toContain("### Projet Avenger");
  });
});
