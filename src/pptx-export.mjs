import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assetsDirFor } from "./paths.mjs";
import { readState } from "./store.mjs";

const pptxContentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function exportSlidesPptx(projectDir, deckId, options = {}) {
  const state = await readState(projectDir, options);
  const deck = state.objects.find((item) => item.id === deckId && item.type === "slides");
  if (!deck) throw httpError("Slide deck not found.", 404);
  const slides = slidesForDeck(state.objects, deck);
  if (!slides.length) throw httpError("Add at least one slide before exporting PowerPoint.", 400);
  const { Presentation, PresentationFile } = await loadArtifactTool();
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

  for (const [index, source] of slides.entries()) {
    const slide = presentation.slides.add();
    slide.background.fill = "#f8fafc";
    if ((source.type || "image") === "image") await addImageSlide(slide, source, index);
    else if (source.type === "slide-frame") await addFrameSlide(slide, source, assetsDirFor(projectDir, options.canvasId));
    else addHtmlSlide(slide, source, index);
    slide.speakerNotes.textFrame.setText(`[Sources]\n- Canvas-Codex local slide object: ${source.id}`);
    await presentation.export({ slide, format: "png", scale: 1 });
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-codex-pptx-"));
  const outputPath = path.join(tempDir, "deck.pptx");
  try {
    const pptx = await PresentationFile.exportPptx(presentation);
    await pptx.save(outputPath);
    return {
      buffer: await fs.readFile(outputPath),
      contentType: pptxContentType,
      filename: `${safeFilename(deck.name || "AI-slides")}.pptx`
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function slidesForDeck(objects, deck) {
  const legacy = new Map((deck.slideIds || []).map((id, index) => [id, index]));
  return objects.filter((item) => ["image", "html", "slide-frame"].includes(item.type || "image") && (item.slideDeckId === deck.id || legacy.has(item.id)))
    .sort((left, right) => (Number.isFinite(left.slideOrder) ? left.slideOrder : legacy.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (Number.isFinite(right.slideOrder) ? right.slideOrder : legacy.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

async function addImageSlide(slide, source, index) {
  const imagePath = source.assetPath || source.sourcePath;
  if (!imagePath) {
    addMissingSlide(slide, source.name || `Slide ${index + 1}`);
    return;
  }
  const bytes = await fs.readFile(imagePath).catch(() => null);
  if (!bytes) {
    addMissingSlide(slide, source.name || `Slide ${index + 1}`);
    return;
  }
  slide.images.add({
    blob: bytes,
    contentType: imageContentType(imagePath),
    alt: source.name || `Slide ${index + 1}`,
    fit: "contain",
    position: { left: 0, top: 0, width: 1280, height: 720 }
  });
}

async function addFrameSlide(slide, source, projectAssetsDir) {
  slide.background.fill = frameColor(source.background, "#ffffff");
  const elements = Array.isArray(source.elements) ? source.elements : [];
  const models = new Map(elements.map((element) => [element.id, element]));
  const absolutePosition = (element) => {
    let left = Number(element.x) || 0;
    let top = Number(element.y) || 0;
    const seen = new Set([element.id]);
    let parent = models.get(element.parentId);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      left += Number(parent.x) || 0;
      top += Number(parent.y) || 0;
      parent = models.get(parent.parentId);
    }
    return { left:left * 1.25, top:top * 1.25, width:Math.max(1, Number(element.width) || 1) * 1.25, height:Math.max(1, Number(element.height) || 1) * 1.25 };
  };
  for (const element of elements) {
    const position = absolutePosition(element);
    const style = element.style || {};
    if (style.background && element.type !== "text") {
      const shape = slide.shapes.add({ geometry:"rect", position, fill:frameColor(style.background, "#ffffff"), line:{ fill:"none", width:0 } });
      shape.name = element.id;
    }
    if (element.type === "text") {
      const box = slide.shapes.add({ geometry:"textbox", position, fill:style.background ? frameColor(style.background, "#ffffff") : "none", line:{ fill:"none", width:0 } });
      box.name = element.id;
      box.text = String(element.text || "");
      box.text.style = {
        fontSize: Math.max(8, cssNumber(style.fontSize, 24) * 1.25),
        bold: Number(style.fontWeight) >= 600 || /bold/i.test(String(style.fontWeight || "")),
        color: frameColor(style.color, "#172033"),
        alignment: ["left", "center", "right"].includes(style.textAlign) ? style.textAlign : "left"
      };
    }
    if (["image", "svg", "chart"].includes(element.type)) {
      const src = String(element.src || "");
      const match = /^data:(image\/(?:png|jpeg|svg\+xml));base64,(.+)$/i.exec(src);
      let blob = match ? Buffer.from(match[2], "base64") : null;
      let contentType = match?.[1]?.toLowerCase() || "";
      if (!blob && src.startsWith("/assets/")) {
        const assetName = decodeURIComponent(src.split("?")[0].split("/").at(-1) || "");
        const assetPath = path.join(projectAssetsDir, assetName);
        blob = await fs.readFile(assetPath).catch(() => null);
        contentType = imageContentType(assetPath);
      }
      if (blob) slide.images.add({ blob, contentType, alt:element.text || element.id, fit:"contain", position });
    }
  }
}

function cssNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function frameColor(value, fallback) {
  const match = /#[0-9a-f]{6}\b/i.exec(String(value || ""));
  return match ? match[0] : fallback;
}

function addHtmlSlide(slide, source, index) {
  const content = htmlContent(source.html || "");
  const accent = slide.shapes.add({ geometry: "rect", position: { left: 0, top: 0, width: 22, height: 720 }, fill: "#0ea5e9", line: { fill: "none", width: 0 } });
  accent.name = "accent";
  const eyebrow = slide.shapes.add({ geometry: "textbox", position: { left: 72, top: 62, width: 400, height: 28 }, fill: "none", line: { fill: "none", width: 0 } });
  eyebrow.text = `AI SLIDES  ·  ${String(index + 1).padStart(2, "0")}`;
  eyebrow.text.style = { fontSize: 16, bold: true, color: "#0284c7" };
  const title = slide.shapes.add({ geometry: "textbox", position: { left: 72, top: 118, width: 1136, height: 112 }, fill: "none", line: { fill: "none", width: 0 } });
  title.text = content.title || source.name || `Slide ${index + 1}`;
  title.text.style = { fontSize: 42, bold: true, color: "#0f172a" };
  const body = slide.shapes.add({ geometry: "textbox", position: { left: 72, top: 270, width: 920, height: 330 }, fill: "none", line: { fill: "none", width: 0 } });
  body.text = content.body || "Interactive HTML content is available in the Canvas-Codex presentation view.";
  body.text.style = { fontSize: 24, color: "#475569" };
  const footer = slide.shapes.add({ geometry: "textbox", position: { left: 72, top: 654, width: 1136, height: 24 }, fill: "none", line: { fill: "none", width: 0 } });
  footer.text = source.name || "Canvas-Codex HTML slide";
  footer.text.style = { fontSize: 14, color: "#94a3b8" };
}

function addMissingSlide(slide, titleText) {
  const title = slide.shapes.add({ geometry: "textbox", position: { left: 72, top: 260, width: 1136, height: 120 }, fill: "none", line: { fill: "none", width: 0 } });
  title.text = titleText;
  title.text.style = { fontSize: 42, bold: true, color: "#0f172a", alignment: "center" };
}

function htmlContent(html) {
  const title = firstTagText(html, ["h1", "h2", "title"]);
  const paragraphs = [...String(html).matchAll(/<(p|li|h3)[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => decodeEntities(stripTags(match[2]))).filter(Boolean).slice(0, 8);
  return { title, body: paragraphs.join("\n\n").slice(0, 1200) };
}

function firstTagText(html, tags) {
  for (const tag of tags) {
    const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(String(html));
    const text = match ? decodeEntities(stripTags(match[1])) : "";
    if (text) return text.slice(0, 180);
  }
  return "";
}

function stripTags(value) { return String(value).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function decodeEntities(value) { return String(value).replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'"); }
function imageContentType(filePath) { const ext = path.extname(filePath).toLowerCase(); return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg"; }
function safeFilename(value) { return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().slice(0, 80) || "AI-slides"; }
function httpError(message, statusCode) { const error = new Error(message); error.statusCode = statusCode; return error; }

async function loadArtifactTool() {
  const entry = await artifactToolEntry();
  if (!entry) throw httpError("PowerPoint export requires the Codex presentation runtime.", 503);
  return import(pathToFileURL(entry).href);
}

async function artifactToolEntry() {
  const roots = [
    process.env.CODEX_ARTIFACT_TOOL_PATH,
    ...(process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean).map((root) => path.join(root, "@oai", "artifact-tool")),
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "@oai", "artifact-tool")
  ].filter(Boolean);
  for (const root of roots) {
    const entry = root.endsWith(".mjs") ? root : path.join(root, "dist", "artifact_tool.mjs");
    try { await fs.access(entry); return entry; } catch {}
  }
  return null;
}
