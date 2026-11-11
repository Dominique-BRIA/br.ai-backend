import { strFromU8, type UnzipFileInfo, unzipSync } from "fflate";

/**
 * Le texte d'un document joint, en Markdown, pour que les IA puissent le lire : PDF, Word,
 * PowerPoint, Excel, OpenDocument et fichiers texte. La mise en page est perdue ; les titres, les
 * listes, les tableaux et l'ordre des diapositives sont gardés.
 */
export interface Extraction {
  /** `null` quand aucun texte n'a pu être tiré du fichier. */
  text: string | null;
  /** Pourquoi le texte manque ou est incomplet, en une phrase pour l'IA et le membre. */
  note: string | null;
}

/** Au-delà, le texte est coupé : aucune IA gratuite ne lirait davantage. */
export const MAX_TEXT_CHARS = 300_000;
/** Un fichier décompressé plus gros est ignoré : protection contre les archives piégées. */
const MAX_ENTRY_BYTES = 60 * 1024 * 1024;
const MAX_SHEET_ROWS = 400;
const MAX_SHEET_COLUMNS = 30;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "log",
  "ini",
  "toml",
  "sql",
  "html",
  "htm",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "c",
  "h",
  "cpp",
  "cs",
  "go",
  "rs",
  "php",
  "rb",
  "sh",
  "css",
  "dart",
  "kt",
  "swift",
  "vue",
  "svelte",
  "tex",
  "rtf",
]);
const OLD_OFFICE = new Set(["doc", "ppt", "xls"]);
const ODF = new Set(["odt", "odp", "ods"]);

export async function documentToMarkdown(
  name: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<Extraction> {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  try {
    if (extension === "pdf" || contentType === "application/pdf") return finish(await pdf(bytes), "pdf");
    if (extension === "docx") return finish(docx(bytes), "docx");
    if (extension === "pptx") return finish(pptx(bytes), "pptx");
    if (extension === "xlsx") return finish(xlsx(bytes), "xlsx");
    if (ODF.has(extension)) return finish(odf(bytes), extension);
    if (OLD_OFFICE.has(extension)) {
      return {
        text: null,
        note: `Ancien format .${extension} non lu : enregistre-le en .${extension}x pour que l'IA puisse le lire.`,
      };
    }
    if (contentType.startsWith("image/")) {
      return { text: null, note: "Image : son texte n'est pas encore extrait." };
    }
    if (
      TEXT_EXTENSIONS.has(extension) ||
      contentType.startsWith("text/") ||
      contentType === "application/json"
    ) {
      return finish(plainText(bytes, extension), extension);
    }
    return { text: null, note: null };
  } catch {
    return { text: null, note: "Fichier illisible : il est peut-être abîmé ou protégé par un mot de passe." };
  }
}

function finish(markdown: string, kind: string): Extraction {
  const text = markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < 3) {
    return {
      text: null,
      note:
        kind === "pdf"
          ? "PDF sans texte lisible : c'est sans doute une image scannée."
          : "Document vide, ou sans texte lisible.",
    };
  }
  if (text.length <= MAX_TEXT_CHARS) return { text, note: null };
  return {
    text: text.slice(0, MAX_TEXT_CHARS),
    note: `Document très long : seuls les ${MAX_TEXT_CHARS.toLocaleString("fr")} premiers caractères sont lus.`,
  };
}

/** Le texte d'un fichier texte ; un fichier binaire déguisé est refusé. */
function plainText(bytes: Uint8Array, extension: string): string {
  if (bytes.subarray(0, 8000).includes(0)) return "";
  const text = new TextDecoder("utf-8").decode(bytes);
  if (extension === "html" || extension === "htm") {
    return decodeEntities(
      text
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<\/(p|div|h[1-6]|li|tr|br)>|<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    );
  }
  return text;
}

async function pdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js garde le tableau qu'on lui donne : il reçoit une copie.
  const document = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(document, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages
    .map((page, index) => (pages.length > 1 ? `## Page ${index + 1}\n\n${page.trim()}` : page.trim()))
    .join("\n\n");
}

// --- Formats Office et OpenDocument : des fichiers XML dans un .zip

function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, string> {
  const files = unzipSync(bytes, {
    filter: (file: UnzipFileInfo) => wanted(file.name) && file.originalSize <= MAX_ENTRY_BYTES,
  });
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strFromU8(content)]));
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const value = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
  });
}

/** Le texte d'un paragraphe Word ou PowerPoint (balises w:t ou a:t), tabulations et sauts compris. */
function runsText(xml: string, prefix: "w" | "a"): string {
  const pattern = new RegExp(
    `<${prefix}:t(?:\\s[^>]*)?>([^<]*)</${prefix}:t>|<${prefix}:tab\\s*/>|<${prefix}:br\\s*/>`,
    "g",
  );
  let text = "";
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) text += match[1];
    else text += match[0].includes(":tab") ? "\t" : "\n";
  }
  return decodeEntities(text).trim();
}

function table(rows: string[][]): string {
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) return "";
  const cell = (value: string | undefined) => (value ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cell(row[index])).join(" | ")} |`;
  const [head = [], ...rest] = rows;
  return [line(head), `|${" --- |".repeat(width)}`, ...rest.map(line)].join("\n");
}

function docx(bytes: Uint8Array): string {
  const files = unzip(bytes, (name) => name === "word/document.xml");
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("document.xml absent");
  const body = xml.slice(Math.max(0, xml.indexOf("<w:body")));
  const blocks: string[] = [];
  for (const match of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const block = match[0];
    if (block.startsWith("<w:tbl>")) {
      const rows = [...block.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((row) =>
        [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cell) =>
          [...cell[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => runsText(p[0], "w")).join(" "),
        ),
      );
      blocks.push(table(rows));
      continue;
    }
    const text = runsText(block, "w");
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] ?? "";
    const level = /^(?:Heading|Titre|heading)\s?(\d)$/.exec(style)?.[1];
    if (/^(Title|Titre)$/i.test(style)) blocks.push(`# ${text}`);
    else if (level) blocks.push(`${"#".repeat(Math.min(Number(level) + 1, 6))} ${text}`);
    else if (block.includes("<w:numPr>")) blocks.push(`- ${text}`);
    else blocks.push(text);
  }
  // Les éléments de liste se suivent sans ligne vide.
  return blocks.join("\n\n").replace(/^(- .*)\n\n(?=- )/gm, "$1\n");
}

/** Les cibles d'un fichier de relations (.rels), par identifiant. */
function relations(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of (xml ?? "").matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /\sId="([^"]+)"/.exec(match[0])?.[1];
    const target = /\sTarget="([^"]+)"/.exec(match[0])?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

/** « ../notesSlides/notesSlide1.xml » vu depuis « ppt/slides/ » devient « ppt/notesSlides/notesSlide1.xml ». */
function resolvePath(folder: string, target: string): string {
  const parts = target.startsWith("/") ? [] : folder.split("/").filter(Boolean);
  for (const part of target.replace(/^\//, "").split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function pptx(bytes: Uint8Array): string {
  const files = unzip(bytes, (name) => /^ppt\/(presentation\.xml|_rels\/|slides\/|notesSlides\/)/.test(name));
  const links = relations(files["ppt/_rels/presentation.xml.rels"]);
  const ordered = [...(files["ppt/presentation.xml"] ?? "").matchAll(/<p:sldId\s[^>]*r:id="([^"]+)"/g)]
    .map((match) => links.get(match[1] ?? ""))
    .filter((target): target is string => Boolean(target))
    .map((target) => resolvePath("ppt", target));
  const slides =
    ordered.length > 0
      ? ordered
      : Object.keys(files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  return slides
    .map((path, index) => {
      const xml = files[path] ?? "";
      const lines: string[] = [];
      for (const shape of xml.matchAll(
        /<p:sp>[\s\S]*?<\/p:sp>|<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g,
      )) {
        const title = /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(shape[0]);
        if (shape[0].startsWith("<p:graphicFrame")) {
          const rows = [...shape[0].matchAll(/<a:tr[ >][\s\S]*?<\/a:tr>/g)].map((row) =>
            [...row[0].matchAll(/<a:tc[ >][\s\S]*?<\/a:tc>/g)].map((cell) => runsText(cell[0], "a")),
          );
          if (rows.length > 0) lines.push(table(rows));
          continue;
        }
        const paragraphs = [...shape[0].matchAll(/<a:p>[\s\S]*?<\/a:p>/g)]
          .map((p) => runsText(p[0], "a"))
          .filter(Boolean);
        if (paragraphs.length === 0) continue;
        lines.push(title ? `### ${paragraphs.join(" ")}` : paragraphs.join("\n"));
      }
      const folder = path.slice(0, path.lastIndexOf("/"));
      const rels = relations(files[`${folder}/_rels/${path.slice(folder.length + 1)}.rels`]);
      const notesTarget = [...rels.values()].find((target) => target.includes("notesSlide"));
      const notes = notesTarget
        ? [...(files[resolvePath(folder, notesTarget)] ?? "").matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
            .filter((shape) => /<p:ph[^>]*type="body"/.test(shape[0]))
            .flatMap((shape) =>
              [...shape[0].matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((p) => runsText(p[0], "a")),
            )
            .filter(Boolean)
        : [];
      return [
        `## Diapositive ${index + 1}`,
        ...lines,
        ...(notes.length > 0 ? [`Notes : ${notes.join(" ")}`] : []),
      ].join("\n\n");
    })
    .join("\n\n");
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of /^[A-Z]+/.exec(reference)?.[0] ?? "A") index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function xlsx(bytes: Uint8Array): string {
  const files = unzip(bytes, (name) =>
    /^xl\/(workbook\.xml|_rels\/|sharedStrings\.xml|worksheets\/)/.test(name),
  );
  const shared = [...(files["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) =>
    decodeEntities([...(item[1] ?? "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const links = relations(files["xl/_rels/workbook.xml.rels"]);
  const sheets = [...(files["xl/workbook.xml"] ?? "").matchAll(/<sheet\s[^>]*>/g)].map((match) => ({
    name: decodeEntities(/\sname="([^"]*)"/.exec(match[0])?.[1] ?? "Feuille"),
    path: resolvePath("xl", links.get(/r:id="([^"]+)"/.exec(match[0])?.[1] ?? "") ?? ""),
  }));
  return sheets
    .map(({ name, path }) => {
      const xml = files[path] ?? "";
      const rows: string[][] = [];
      let more = 0;
      for (const row of xml.matchAll(/<row[ >][\s\S]*?<\/row>/g)) {
        if (rows.length >= MAX_SHEET_ROWS) {
          more++;
          continue;
        }
        const values: string[] = [];
        for (const cell of row[0].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attributes = cell[1] ?? "";
          const column = columnIndex(/r="([A-Z]+)/.exec(attributes)?.[1] ?? "");
          if (column >= MAX_SHEET_COLUMNS) continue;
          const type = /\st="([^"]+)"/.exec(` ${attributes}`)?.[1];
          const inner = cell[2] ?? "";
          const raw = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "";
          const value =
            type === "s"
              ? (shared[Number(raw)] ?? "")
              : type === "inlineStr"
                ? decodeEntities(
                    [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(""),
                  )
                : type === "b"
                  ? raw === "1"
                    ? "VRAI"
                    : "FAUX"
                  : decodeEntities(raw);
          values[column] = value;
        }
        if (values.some((value) => value?.trim())) rows.push(Array.from(values, (value) => value ?? ""));
      }
      if (rows.length === 0) return `## ${name}\n\n(feuille vide)`;
      const extra = more > 0 ? `\n\n(${more} ligne(s) suivante(s) non reprise(s))` : "";
      return `## ${name}\n\n${table(rows)}${extra}`;
    })
    .join("\n\n");
}

function odf(bytes: Uint8Array): string {
  const xml = unzip(bytes, (name) => name === "content.xml")["content.xml"];
  if (!xml) throw new Error("content.xml absent");
  const blocks: string[] = [];
  let slide = 0;
  for (const match of xml.matchAll(
    /<draw:page[ >]|<table:table-row[ >][\s\S]*?<\/table:table-row>|<text:h[ >][\s\S]*?<\/text:h>|<text:p[ >][\s\S]*?<\/text:p>/g,
  )) {
    const block = match[0];
    if (block.startsWith("<draw:page")) {
      blocks.push(`## Diapositive ${++slide}`);
      continue;
    }
    const text = (fragment: string) =>
      decodeEntities(
        fragment
          .replace(/<text:tab\s*\/>/g, "\t")
          .replace(/<text:line-break\s*\/>/g, "\n")
          .replace(/<text:s(?:\s[^>]*)?\/>/g, " ")
          .replace(/<[^>]+>/g, ""),
      ).trim();
    if (block.startsWith("<table:table-row")) {
      const cells = [...block.matchAll(/<table:table-cell[ >][\s\S]*?<\/table:table-cell>/g)].map((cell) =>
        text(cell[0]),
      );
      if (cells.some(Boolean)) blocks.push(`| ${cells.join(" | ")} |`);
      continue;
    }
    const value = text(block);
    if (!value) continue;
    const level = /text:outline-level="(\d)"/.exec(block)?.[1];
    blocks.push(
      block.startsWith("<text:h") ? `${"#".repeat(Math.min(Number(level ?? 1) + 1, 6))} ${value}` : value,
    );
  }
  return blocks.join("\n\n").replace(/(\|.*\|)\n\n(?=\|)/g, "$1\n");
}
