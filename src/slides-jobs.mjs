import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assetsDirFor, jobsDirFor } from "./paths.mjs";
import { startCodexImageJob, startCodexSlidesJob, stopCodexProcess } from "./codex-runner.mjs";
import { addObject, deleteObjects, readState, updateObjects } from "./store.mjs";
import { createOperationLease } from "./operation-leases.mjs";
import { buildSlideSkillPrompt, slideSkillActions } from "./slides-skill-router.mjs";
import { renderSlideChart } from "./slide-charts.mjs";
import { inspectPptxReference } from "./pptx-reference.mjs";
import { applyDeterministicLayout, inferSlideIntent, validatePostLayout, validatePreLayout } from "./slides-layout-engine.mjs";

const jobs = new Map();
const maxSlides = 20;
const maxHtmlBytes = 500_000;
function slidesJobTimeout(job, revision = false) {
  const minutes = job.action === "plan-slides"
    ? 12
    : revision
      ? Math.min(30, Math.max(10, 4 + job.pageCount * 2))
      : Math.min(45, Math.max(15, 8 + job.pageCount * 3));
  return { minutes, ms:minutes * 60_000 };
}

function visualAssetBudget(pageCount) {
  if (pageCount <= 5) return { min:2, max:3 };
  if (pageCount <= 10) return { min:3, max:5 };
  return { min:5, max:8 };
}

function normalizeCanvasId(value) {
  const canvasId = typeof value === "string" ? value.trim() : "";
  return canvasId || null;
}

function matches(job, options = {}) {
  if (options.projectDir && path.resolve(options.projectDir) !== path.resolve(job.projectDir)) return false;
  return normalizeCanvasId(options.canvasId) === normalizeCanvasId(job.canvasId);
}

function publicJob(job) {
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    stage: job.stage,
    deckId: job.deckId,
    pageCount: job.pageCount,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationMs: job.durationMs,
    imported: job.imported,
    previewSlides: job.previewSlides,
    pages: job.pages,
    targetSlideId: job.targetSlideId,
    outline: job.outline,
    error: job.error
  };
}

export async function createSlidesJob(projectDir, input, options = {}) {
  const action = input.action === "plan-slides" ? "plan-slides" : "generate-slides";
  const deckId = String(input.deckId || "").trim();
  const prompt = String(input.prompt || "").trim().slice(0, 6000);
  const pageCount = Math.max(1, Math.min(maxSlides, Math.round(Number(input.pageCount) || 5)));
  const requestedOutline = normalizeOutline(input.outline, pageCount);
  const visualDirection = normalizeVisualDirection(input.visualDirection);
  const targetSlideId = typeof input.targetSlideId === "string" ? input.targetSlideId.trim().slice(0, 200) : null;
  if (!deckId || !prompt) {
    const error = new Error("AI slide generation requires a deck and a presentation description.");
    error.statusCode = 400;
    throw error;
  }
  const canvasId = normalizeCanvasId(options.canvasId);
  const state = await readState(projectDir, { canvasId });
  const deck = state.objects.find((object) => object.id === deckId && object.type === "slides");
  if (!deck) {
    const error = new Error(`Slide deck not found: ${deckId}`);
    error.statusCode = 404;
    throw error;
  }

  const id = `slides_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const jobDir = path.join(jobsDirFor(projectDir, canvasId), id);
  const outputDir = path.join(jobDir, "outputs");
  const logPath = path.join(jobDir, "codex.log");
  await fs.mkdir(outputDir, { recursive: true });
  const referenceBundle = await writeReferences(jobDir, input.references);
  const referencePaths = referenceBundle.imagePaths;
  const job = {
    id, action, projectDir, canvasId, deckId, prompt, pageCount: requestedOutline?.length || pageCount,
    targetSlideId, visualDirection,
    requestedOutline, outputDir, logPath, referencePaths, presentationReference:referenceBundle.presentationContext,
    status: "queued", stage: "planning", createdAt: new Date().toISOString(), startedAt: null,
    completedAt: null, durationMs: null, imported: [], previewSlides:[], outline: null, error: null, currentChild: null, cancelRequested: false, pauseRequested: false, resumeStage:null, resumeWaiter:null, generatedAssets: [],
    pages: Array.from({ length: requestedOutline?.length || pageCount }, (_, index) => ({
      index, status:"waiting", intent:inferSlideIntent(requestedOutline?.[index] || {}, index, requestedOutline?.length || pageCount)
    }))
  };
  jobs.set(id, job);
  const lease = await createOperationLease("slides-job", { action, projectDir, canvasId });
  runSlidesJob(job)
    .catch((error) => failJob(job, error))
    .finally(async () => { job.currentChild = null; await lease.release(); });
  return publicJob(job);
}

export function getSlidesJob(id, options = {}) {
  const job = jobs.get(id);
  if (!job || !matches(job, options)) {
    const error = new Error(`Slides job not found: ${id}`);
    error.statusCode = 404;
    throw error;
  }
  return publicJob(job);
}

export async function cancelSlidesJob(projectDir, id, options = {}) {
  const job = jobs.get(id);
  if (!job || !matches(job, { ...options, projectDir })) {
    const error = new Error(`Slides job not found: ${id}`);
    error.statusCode = 404;
    throw error;
  }
  if (!["queued", "running", "paused", "pausing"].includes(job.status)) {
    const error = new Error("Slides job is no longer running.");
    error.statusCode = 409;
    throw error;
  }
  job.cancelRequested = true;
  job.status = "cancelled";
  job.stage = "cancelled";
  job.completedAt = new Date().toISOString();
  job.durationMs = Date.now() - Date.parse(job.startedAt || job.createdAt);
  job.resumeWaiter?.(); job.resumeWaiter = null;
  await stopCodexProcess(job.currentChild);
  return publicJob(job);
}

export function pauseSlidesJob(projectDir, id, options = {}) {
  const job = jobs.get(id);
  if (!job || !matches(job, { ...options, projectDir })) {
    const error = new Error(`Slides job not found: ${id}`); error.statusCode = 404; throw error;
  }
  if (job.status !== "running") {
    const error = new Error("Only a running slides job can be paused."); error.statusCode = 409; throw error;
  }
  job.pauseRequested = true;
  job.resumeStage = job.stage;
  job.status = "pausing";
  return publicJob(job);
}

export function resumeSlidesJob(projectDir, id, options = {}) {
  const job = jobs.get(id);
  if (!job || !matches(job, { ...options, projectDir })) {
    const error = new Error(`Slides job not found: ${id}`); error.statusCode = 404; throw error;
  }
  if (!["paused", "pausing"].includes(job.status)) {
    const error = new Error("Slides job is not paused."); error.statusCode = 409; throw error;
  }
  job.pauseRequested = false;
  job.status = "running";
  job.stage = job.resumeStage || "generating";
  job.resumeWaiter?.(); job.resumeWaiter = null;
  return publicJob(job);
}

async function waitWhilePaused(job, nextStage) {
  if (!job.pauseRequested || job.cancelRequested) return;
  job.resumeStage = nextStage || job.resumeStage || job.stage;
  job.status = "paused";
  job.stage = "paused";
  await new Promise((resolve) => { job.resumeWaiter = resolve; });
  if (job.cancelRequested) return;
  job.status = "running";
  job.stage = job.resumeStage;
}

async function runSlidesJob(job) {
  job.status = "running";
  job.stage = "planning";
  job.startedAt = new Date().toISOString();
  const action = job.action === "plan-slides" ? slideSkillActions.PLAN_DECK : slideSkillActions.COMPOSE_DECK;
  const prompt = await buildSlideSkillPrompt({
    action,
    payload:job.action === "plan-slides" ? outlinePrompt(job) : slidesPrompt(job),
    outline:job.requestedOutline || []
  });
  const runner = await startCodexSlidesJob({
    projectDir: job.projectDir,
    outputDir: job.outputDir,
    logPath: job.logPath,
    imagePaths: job.referencePaths,
    prompt
  });
  job.currentChild = runner.child;
  job.stage = "generating";
  let resolveOutputReady;
  let stableOutputTicks = 0;
  const outputReady = new Promise((resolve) => { resolveOutputReady = resolve; });
  const progressTimer = setInterval(async () => {
    try {
      const files = await fs.readdir(job.outputDir);
      const ready = new Set(files.filter((name) => /^slide-\d{2}\.(?:json|html)$/i.test(name)).map((name) => Number(name.slice(6, 8)) - 1));
      job.pages = job.pages.map((page) => ({ ...page, status:ready.has(page.index) ? "ready" : page.status === "ready" ? "ready" : "generating" }));
      if (job.action === "generate-slides" && ready.size === job.pageCount && files.includes("manifest.json") && files.includes("visual-assets.json")) {
        stableOutputTicks += 1;
        if (stableOutputTicks >= 3) resolveOutputReady("files");
      } else stableOutputTicks = 0;
      for (const index of ready) {
        if (job.previewSlides[index]) continue;
        const filename = files.find((name) => new RegExp(`^slide-${String(index + 1).padStart(2, "0")}\\.json$`, "i").test(name));
        if (!filename) continue;
        try {
          let frame = JSON.parse(await fs.readFile(path.join(job.outputDir, filename), "utf8"));
          if (!Array.isArray(frame.elements) || !frame.elements.length) continue;
          frame = applyDeterministicLayout(frame, { index, count:job.pageCount, preserveCoordinates:Boolean(job.presentationReference) });
          job.pages[index] = { ...job.pages[index], intent:frame.intent, archetype:frame.archetype, skillRoute:frame.skillRoute };
          const previewElements = frame.elements.map((element) => element?.type === "chart"
            ? { ...element, ...renderSlideChart(element.chart, { width:element.width, height:element.height }) }
            : element);
          job.previewSlides[index] = {
            type:"slide-frame",
            title:String(frame.title || job.requestedOutline?.[index]?.title || `幻灯片 ${index + 1}`).trim().slice(0, 100),
            intent:frame.intent, archetype:frame.archetype, skillRoute:frame.skillRoute, layoutSpec:frame.layoutSpec,
            templateId:String(frame.templateId || "freeform").trim().slice(0, 120),
            background:String(frame.background || "#ffffff").trim().slice(0, 300),
            elements:previewElements
          };
        } catch {}
      }
    } catch {}
  }, 700);
  progressTimer.unref?.();
  let timeout;
  const generationTimeout = slidesJobTimeout(job);
  try {
    const completedBy = await Promise.race([
      runner.done.then(() => "runner"),
      outputReady,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`AI slide generation timed out after ${generationTimeout.minutes} minutes.`)), generationTimeout.ms);
        timeout.unref?.();
      })
    ]);
    if (completedBy === "files") await stopCodexProcess(runner.child);
  } catch (error) {
    await stopCodexProcess(runner.child);
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(progressTimer);
  }
  if (job.cancelRequested) return;
  await waitWhilePaused(job, job.action === "plan-slides" ? "validating" : "validating");
  if (job.cancelRequested) return;
  if (job.action === "plan-slides") {
    job.stage = "validating";
    job.outline = await readGeneratedOutline(job);
    job.status = "done";
    job.stage = "done";
    job.completedAt = new Date().toISOString();
    job.durationMs = Date.now() - Date.parse(job.startedAt);
    return;
  }
  job.stage = "validating";
  const slides = await readGeneratedSlidesWithQualityRetry(job);
  job.previewSlides = slides;
  await waitWhilePaused(job, "illustrating");
  if (job.cancelRequested) return;
  job.stage = "illustrating";
  const illustratedSlides = await generateRequestedVisualAssets(job, slides);
  job.previewSlides = illustratedSlides;
  await waitWhilePaused(job, "final-review");
  if (job.cancelRequested) return;
  job.stage = "final-review";
  job.pages = job.pages.map((page) => ({ ...page, status:"ready", reviewStatus:"reviewing" }));
  const reviewedSlides = await finalVisualReviewWithTargetedRepair(job, illustratedSlides);
  job.previewSlides = reviewedSlides;
  await waitWhilePaused(job, "importing");
  if (job.cancelRequested) return;
  job.stage = "importing";
  job.imported = await importSlides(job, reviewedSlides);
  job.pages = job.pages.map((page, index) => ({ ...page, status:"done", id:job.imported[index]?.id || null }));
  job.status = "done";
  job.stage = "done";
  job.completedAt = new Date().toISOString();
  job.durationMs = Date.now() - Date.parse(job.startedAt);
}

async function finalVisualReviewWithTargetedRepair(job, slides) {
  await writeResolvedSlides(job, slides);
  const failures = collectFinalVisualFailures(slides);
  if (!failures.length) return slides;
  job.stage = "final-repair";
  const failingIndexes = new Set(failures.map((failure) => failure.index));
  job.pages = job.pages.map((page) => ({ ...page, status:"ready", reviewStatus:failingIndexes.has(page.index) ? "repairing" : "reviewed" }));
  const protectedFiles = new Map();
  for (const filename of ["manifest.json", "visual-assets.json"]) {
    const filePath = path.join(job.outputDir, filename);
    const content = await fs.readFile(filePath).catch(() => null);
    if (content) protectedFiles.set(filePath, content);
  }
  for (let index = 0; index < slides.length; index += 1) {
    if (failingIndexes.has(index)) continue;
    const filePath = path.join(job.outputDir, `slide-${String(index + 1).padStart(2, "0")}.json`);
    protectedFiles.set(filePath, await fs.readFile(filePath));
  }
  const prompt = await buildSlideSkillPrompt({
    action:slideSkillActions.REVIEW_DECK,
    payload:finalVisualRepairPrompt(job, failures),
    outline:job.requestedOutline || []
  });
  const runner = await startCodexSlidesJob({
    projectDir:job.projectDir,
    outputDir:job.outputDir,
    logPath:path.join(path.dirname(job.logPath), "final-visual-repair.log"),
    imagePaths:[...job.referencePaths, ...job.generatedAssets.map((asset) => asset.path).filter(Boolean)].slice(0, 8),
    prompt
  });
  job.currentChild = runner.child;
  let timeout;
  const revisionTimeout = slidesJobTimeout(job, true);
  try {
    await Promise.race([
      runner.done,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`AI final visual repair timed out after ${revisionTimeout.minutes} minutes.`)), revisionTimeout.ms);
        timeout.unref?.();
      })
    ]);
  } catch (error) {
    await stopCodexProcess(runner.child);
    throw error;
  } finally {
    clearTimeout(timeout);
    for (const [filePath, content] of protectedFiles) await fs.writeFile(filePath, content);
  }
  const revised = await readGeneratedSlides(job);
  const remaining = collectFinalVisualFailures(revised);
  if (remaining.length) throw new Error(`Final visual review failed after targeted repair: ${remaining.map((item) => `slide ${item.index + 1}: ${item.message}`).join("; ")}`);
  validateResolvedVisualDeck(revised);
  job.pages = job.pages.map((page) => ({ ...page, status:"ready", reviewStatus:"reviewed" }));
  return revised;
}

async function writeResolvedSlides(job, slides) {
  for (const [index, slide] of slides.entries()) {
    if (slide.type !== "slide-frame") continue;
    await fs.writeFile(path.join(job.outputDir, `slide-${String(index + 1).padStart(2, "0")}.json`), `${JSON.stringify({ title:slide.title, intent:slide.intent, archetype:slide.archetype, skillRoute:slide.skillRoute, layoutSpec:slide.layoutSpec, templateId:slide.templateId, background:slide.background, elements:slide.elements }, null, 2)}\n`);
  }
}

function collectFinalVisualFailures(slides) {
  const failures = [];
  for (const [index, slide] of slides.entries()) {
    if (slide.type !== "slide-frame") { failures.push({ index, message:"page is not a structured Frame" }); continue; }
    try {
      const frame = structuredClone({ ...slide, elements:slide.elements || [] });
      validateGeneratedFrame(frame, index);
      if (frame.elements.some((item) => String(item?.src || "").startsWith("asset://"))) throw new Error("contains an unresolved generated visual token");
      for (const element of frame.elements.filter((item) => item.type === "image" && /^\/assets\//.test(String(item.src || "")))) {
        const style = element.style || {};
        if (!["cover", "contain", "scale-down"].includes(String(style.objectFit || ""))) throw new Error(`image ${element.id} has an invalid final crop mode`);
        if (!String(style.objectPosition || "").trim()) throw new Error(`image ${element.id} is missing final subject positioning`);
      }
    } catch (error) {
      failures.push({ index, message:String(error?.message || error).replace(/^Slide \d+\s*/i, "").slice(0, 500) });
    }
  }
  return failures;
}

function finalVisualRepairPrompt(job, failures) {
  const files = failures.map((failure) => `slide-${String(failure.index + 1).padStart(2, "0")}.json`).join(", ");
  return [
    "Perform the final post-asset visual repair for a structured presentation.",
    `Edit only these failing page files: ${files}. Do not modify any other slide file, manifest.json, or visual-assets.json.`,
    ...failures.map((failure) => `Slide ${failure.index + 1} failure: ${failure.message}`),
    "The bitmap assets are already generated and resolved in element.src. Preserve those assets and all confirmed facts.",
    "Repair layout, crop, objectPosition, masks, text fit, overlap, hierarchy, focal balance, and safe margins using the existing movable layers.",
    "Do not create new asset:// tokens, request new images, change page order, or replace unrelated pages.",
    "Use SVG elements instead of Unicode glyph decoration and keep ECharts chart models editable.",
    `Write corrected failing files only inside: ${job.outputDir}`,
    "Do not modify repository code and do not ask questions."
  ].join("\n");
}

async function readGeneratedSlidesWithQualityRetry(job) {
  try {
    const slides = await readGeneratedSlides(job);
    validateDeckVisualVariety(slides);
    await validateVisualManifestPlan(job, slides);
    return slides;
  } catch (error) {
    if (job.cancelRequested) throw error;
    job.stage = "revising";
    const repairLog = path.join(path.dirname(job.logPath), "quality-revision.log");
    const prompt = await buildSlideSkillPrompt({
      action:slideSkillActions.REVIEW_DECK,
      payload:qualityRevisionPrompt(job, error),
      outline:job.requestedOutline || []
    });
    const runner = await startCodexSlidesJob({
      projectDir:job.projectDir,
      outputDir:job.outputDir,
      logPath:repairLog,
      imagePaths:job.referencePaths,
      prompt
    });
    job.currentChild = runner.child;
    let timeout;
    const revisionTimeout = slidesJobTimeout(job, true);
    try {
      await Promise.race([
        runner.done,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`AI slide quality revision timed out after ${revisionTimeout.minutes} minutes.`)), revisionTimeout.ms);
          timeout.unref?.();
        })
      ]);
    } catch (revisionError) {
      await stopCodexProcess(runner.child);
      throw revisionError;
    } finally {
      clearTimeout(timeout);
    }
    job.stage = "validating";
    const revised = await readGeneratedSlides(job);
    validateDeckVisualVariety(revised);
    await validateVisualManifestPlan(job, revised);
    return revised;
  }
}

async function validateVisualManifestPlan(job, slides) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(job.outputDir, "visual-assets.json"), "utf8")); }
  catch { throw new Error("AI slides require a valid visual-assets.json plan."); }
  const budget = visualAssetBudget(job.pageCount);
  const requests = Array.isArray(manifest?.assets) ? manifest.assets.slice(0, budget.max) : [];
  if (requests.length < budget.min) throw new Error(`The visual plan requires ${budget.min}-${budget.max} bitmap concepts.`);
  if (!normalizeArtDirection(manifest.artDirection)) throw new Error("The visual plan requires a complete deck-wide artDirection specification.");
  const requested = new Set(requests.map((request) => String(request?.token || "").trim()).filter((token) => /^asset:\/\/visual-[a-z0-9._-]+$/i.test(token)));
  if (requested.size < budget.min) throw new Error("The visual plan contains invalid or duplicate bitmap tokens.");
  const used = new Set(slides.flatMap((slide) => slide.elements.map((element) => String(element?.src || "")).filter((src) => src.startsWith("asset://"))));
  if ([...used].some((token) => !requested.has(token))) throw new Error("Every bitmap layer token must have a matching visual-assets request.");
}

function qualityRevisionPrompt(job, error) {
  const budget = visualAssetBudget(job.pageCount);
  return [
    "Perform one targeted professional quality revision of the existing structured slide files in the output directory.",
    `Quality failure to fix: ${error?.message || String(error)}`,
    `Keep exactly ${job.pageCount} slides and preserve the user-confirmed narrative and factual content.`,
    "Inspect every existing slide JSON and revise only the pages responsible for the failure.",
    "Preserve independent movable layers. Use SVG data URLs for icons, arrows, stars, orbit lines, connectors, and abstract decoration; never use Unicode glyphs as graphics.",
    `Ensure visual-assets.json contains ${budget.min}-${budget.max} distinct, content-relevant bitmap requests plus a complete deck-wide artDirection object.`,
    "Ensure cover and case-study pages have a substantial masked bitmap focal point, adjacent pages have distinct silhouettes, and no generic card grid repeats on consecutive slides.",
    job.presentationReference
      ? "This deck uses PPTX reference mode. Preserve or restore templateId pptx-ref-N on every page and rebuild failing pages from their mapped source composition. The supplied PPTX pages override generic design defaults; do not introduce a new palette, technology aesthetic, dashboard language, glassmorphism, or unrelated decoration."
      : "Use the attached references as binding art direction when present, without copying their text or logos.",
    "Rebuild any failing page on a 12-column grid with a 48-72px content-safe margin. Make every text box tall enough for its wrapped copy with at least 12% spare vertical space.",
    "Remove accidental panel-on-panel overlays and clipped bottom content. If layers intentionally belong together, put them in one parent group instead of stacking unrelated top-level elements.",
    "For photographic crops use cover or contain, preserve the subject with objectPosition, and never stretch with fill.",
    "Run a final pass for hierarchy, contrast, text fit, focal point, visual relevance, image crop, and cross-slide consistency.",
    `Write corrected files only inside: ${job.outputDir}`,
    "Do not modify repository code and do not ask questions."
  ].join("\n");
}

async function generateRequestedVisualAssets(job, slides) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(job.outputDir, "visual-assets.json"), "utf8"));
  } catch {
    throw new Error("AI slides require a visual-assets.json manifest and at least one generated bitmap visual.");
  }
  const budget = visualAssetBudget(job.pageCount);
  const requests = Array.isArray(manifest?.assets) ? manifest.assets.slice(0, budget.max) : [];
  if (requests.length < budget.min) throw new Error(`AI slides require ${budget.min}-${budget.max} generated bitmap visuals for a ${job.pageCount}-page deck.`);
  const artDirection = normalizeArtDirection(manifest?.artDirection);
  if (!artDirection) throw new Error("visual-assets.json requires a complete deck-wide artDirection specification.");
  const requestedTokens = new Set(requests.map((request) => String(request?.token || "").trim()).filter(Boolean));
  const usedTokens = new Set(slides.flatMap((slide) => slide.type === "slide-frame"
    ? slide.elements.map((element) => String(element?.src || "").trim()).filter((src) => src.startsWith("asset://"))
    : []));
  if (![...requestedTokens].some((token) => usedTokens.has(token))) {
    throw new Error("Generated bitmap requests must be placed as movable image layers in the slide deck.");
  }
  const replacements = new Map();
  for (const [index, request] of requests.entries()) {
    if (job.cancelRequested) return slides;
    await waitWhilePaused(job, "illustrating");
    if (job.cancelRequested) return slides;
    const token = String(request?.token || "").trim();
    const prompt = String(request?.prompt || "").trim().slice(0, 3000);
    if (!/^asset:\/\/visual-[a-z0-9._-]+$/i.test(token) || !prompt) continue;
    const assetDir = path.join(job.outputDir, `visual-${String(index + 1).padStart(2, "0")}`);
    const assetLog = path.join(path.dirname(job.logPath), `visual-${String(index + 1).padStart(2, "0")}.log`);
    const aspectRatio = String(request?.aspectRatio || "landscape").trim().slice(0, 40);
    const purpose = String(request?.purpose || "editorial presentation visual").trim().slice(0, 240);
    const runner = await startCodexImageJob({
      projectDir:job.projectDir,
      action:"generate",
      imagePath:job.referencePaths,
      outputDir:assetDir,
      logPath:assetLog,
      prompt:[
        `Create a premium ${purpose} for a professional 16:9 presentation.`,
        `Target crop/aspect ratio: ${aspectRatio}.`,
        prompt,
        "No visible text, letters, numbers, logos, interface labels, watermarks, frames, or slide backgrounds.",
        job.presentationReference
          ? "The attached images are representative pages from the supplied PowerPoint. Extract only their illustration/rendering language, palette, lighting, material treatment, and subject framing. Do not reproduce the slide screenshot, its typography, or its layout inside the bitmap, and do not substitute an unrelated neon-cyan or generic technology style."
          : job.referencePaths.length ? "Use the attached references as binding img2 visual direction: match their art direction, lighting, palette relationships, material quality, and image treatment without copying text, logos, or identity." : "Create an original visual direction consistent with the deck.",
        "Compose a clean standalone visual asset with intentional negative space and colors compatible with the deck direction.",
        `Binding deck art direction: ${JSON.stringify(artDirection)}.`,
        job.visualDirection?.deckStyle ? `Deck visual direction: ${job.visualDirection.deckStyle}` : "",
        "Return one polished bitmap, not a collage or presentation screenshot."
      ].filter(Boolean).join("\n")
    });
    job.currentChild = runner.child;
    await runner.done;
    const generated = await newestGeneratedImage(assetDir);
    if (!generated) continue;
    const buffer = await fs.readFile(generated);
    const mime = imageMime(generated);
    if (!mime || buffer.length > 8 * 1024 * 1024) continue;
    const assetName = `slide-${job.id}-${String(index + 1).padStart(2, "0")}${path.extname(generated).toLowerCase() || ".png"}`;
    const assetPath = path.join(assetsDirFor(job.projectDir, job.canvasId), assetName);
    await fs.mkdir(path.dirname(assetPath), { recursive:true });
    await fs.copyFile(generated, assetPath);
    replacements.set(token, `/assets/${encodeURIComponent(assetName)}`);
    job.generatedAssets.push({ token, purpose, path:assetPath });
  }
  if (!replacements.size) throw new Error("Image generation finished without a usable bitmap visual.");
  const unresolved = [...usedTokens].filter((token) => !replacements.has(token));
  if (unresolved.length) throw new Error(`Image generation did not resolve visual assets: ${unresolved.join(", ")}`);
  const resolvedSlides = slides.map((slide) => slide.type !== "slide-frame" ? slide : {
    ...slide,
    elements:slide.elements.map((element) => replacements.has(element.src) ? { ...element, src:replacements.get(element.src) } : element)
  });
  validateResolvedVisualDeck(resolvedSlides);
  return resolvedSlides;
}

function normalizeArtDirection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {
    palette:String(value.palette || "").trim().slice(0, 500),
    typography:String(value.typography || "").trim().slice(0, 500),
    imageStyle:String(value.imageStyle || "").trim().slice(0, 800),
    decorativeLanguage:String(value.decorativeLanguage || "").trim().slice(0, 800),
    consistencyKey:String(value.consistencyKey || "").trim().slice(0, 800)
  };
  return Object.values(normalized).every(Boolean) ? normalized : null;
}

function validateResolvedVisualDeck(slides) {
  const bitmapElements = slides.flatMap((slide) => slide.type === "slide-frame"
    ? slide.elements.filter((element) => element.type === "image" && /^\/assets\//.test(String(element.src || "")))
    : []);
  if (!bitmapElements.length) throw new Error("The deck must contain at least one movable generated bitmap layer.");
  if (!bitmapElements.some((element) => {
    const style = element.style || {};
    return Boolean(String(style.clipPath || "").trim()) || Number.parseFloat(style.borderRadius) >= 16;
  })) throw new Error("At least one generated bitmap must use an intentional mask or substantial corner treatment.");
}

async function newestGeneratedImage(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes:true }); } catch { return null; }
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:png|jpe?g|webp)$/i.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) images.push({ filePath, mtimeMs:stat.mtimeMs });
  }
  return images.sort((a,b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || null;
}

function imageMime(filePath) {
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.webp$/i.test(filePath)) return "image/webp";
  if (/\.jpe?g$/i.test(filePath)) return "image/jpeg";
  return "";
}

function failJob(job, error) {
  if (job.cancelRequested || job.status === "cancelled") return;
  job.status = "failed";
  job.stage = "failed";
  job.error = error?.message || String(error);
  job.pages = job.pages.map((page) => page.status === "done" ? page : { ...page, status:page.status === "ready" ? "ready" : "failed", error:job.error });
  job.completedAt = new Date().toISOString();
  job.durationMs = Date.now() - Date.parse(job.startedAt || job.createdAt);
}

function slidesPrompt(job) {
  const assetBudget = visualAssetBudget(job.pageCount);
  return [
    "Create a polished, presentation-ready structured slide deck from the user's brief.",
    `Generate exactly ${job.pageCount} independent 1024x576 slide Frame JSON documents.`,
    "First establish a coherent narrative arc, then give every page a distinct layout suited to its message.",
    job.requestedOutline
      ? `Follow this user-confirmed page outline exactly:\n${JSON.stringify(job.requestedOutline)}`
      : "Create a coherent page outline before rendering.",
    job.visualDirection
      ? `Treat this user-confirmed visual direction as a binding deck-wide constraint:\n${JSON.stringify(job.visualDirection)}`
      : "Derive a coherent visual direction from the user's brief.",
    "Act as a senior editorial presentation designer, not a template filler. Every slide needs a visible focal point and a deliberate reading path.",
    job.presentationReference
      ? "PPTX REFERENCE MODE OVERRIDES THE DEFAULT DESIGN SYSTEM. Reconstruct the source deck's visual grammar from the attached source pages before composing: background polarity and page rhythm, exact palette relationships, typography scale and weight, margins, focal-image placement, masks, recurring lines and ornaments, and density. Do not invent a different art direction even if another style looks more fashionable."
      : "Apply professional presentation principles used by Microsoft Designer and Adobe Express: create a cohesive visual system, use content-relevant high-quality imagery, convert lists/processes/timelines into diagrams, favor more visuals and less text, and let every visual support rather than distract from the message.",
    "Use one core idea per slide, a 12-column grid, three-level typography, 48-72px outer margins, and a restrained deck-wide palette with one primary accent and at most one secondary accent.",
    "Treat the 48-72px margin as a hard content-safe area. Background shapes may bleed, but titles, body text, charts, labels, and controls must stay inside it.",
    "Size every text box from its actual copy. Never rely on overflow clipping: estimate wrapped lines from font size and box width, then leave at least 12% vertical breathing room.",
    "Do not place independent opaque or translucent panels over existing cards, text, timelines, or charts. Overlap is allowed only for an intentional parent container with its own children or a clearly decorative non-obscuring layer.",
    "For cover, section, case-study, and key-insight pages, reserve roughly 35-55% of the canvas for one dominant visual. For evidence, process, comparison, and data pages, use an editorial diagram, timeline, masked image, or information composition instead of plain text cards.",
    "Vary compositions across the deck: full-bleed hero, asymmetric split, editorial grid, comparison, process, evidence, and summary. Do not repeat one card arrangement on every page.",
    "Use strong editorial hierarchy, concise real copy, intentional typography, grids, diagrams, charts, timelines, cards, and vector artwork where appropriate.",
    "Before drawing, assign every page one intent from: cover, hero, chart, comparison, process, timeline, architecture, case, dashboard, summary, image. Save it in slide.intent.",
    "Assign slide.archetype from: cover-hero, hero-left, hero-right, split-50, split-40-60, three-columns, four-metrics, comparison, timeline, process, architecture, dashboard, case-study, summary. The backend owns final geometry.",
    "Assign each meaningful top-level element a slot supported by its archetype (title, subtitle, content, visual, footer, left, right, col1-col3, or metric1-metric4). The backend deterministically replaces x/y/width/height from that slot on a 16:9 canvas with a 64px safe area, 12-column grid, and 24px gap. Set layoutLocked:true only for background/decorative bleed geometry.",
    "Skill routing is binding: chart => editable ECharts chart; process/timeline/architecture => SVG diagram; cover/hero => UI/UX art direction plus ImageGen description; dashboard => data-viz; image => image crop with focal-point/objectPosition.",
    "Choose a templateId for every page from: cover, section, insight, comparison, process, data, case-study, solution, roadmap, summary, freeform.",
    "Every meaningful item must be an independently movable element with a stable id and type: text, image, svg, chart, shape, or group. It is acceptable that not every internal path or glyph is separately editable.",
    "For quantitative charts, emit a chart element with chart.type (bar, line, scatter, or pie), categories, series, colors, unit, and accessibilitySummary. Leave chart src empty; the backend will render it with ECharts. Keep the page takeaway and source note as separate text layers.",
    "Use parentId to nest elements. Use layout.mode row, column, or grid for auto-layout containers, including gap, padding, align, justify, and columns. Use free positioning only for intentional overlays or decorative artwork.",
    "Keep content and presentation separate: copy belongs in element.text, imagery in element.src, visual styling in element.style, and layout only in element coordinates or element.layout.",
    "Do not repeat a stock template, a generic sphere, or the same hero composition across pages. Avoid filler text, emoji, Unicode dingbats used as graphics, and invented claims presented as facts.",
    "Use inline SVG data URLs for icons, arrows, connectors, stars, or abstract editorial decorations. Keep SVG vectors compact, self-contained, and free of scripts, foreignObject, external resources, or text glyphs.",
    `Request ${assetBudget.min}-${assetBudget.max} premium bitmap visuals for this ${job.pageCount}-page deck. Add each as an independently movable image element whose src is asset://visual-01.png (or another unique visual-NN.png token). Use dedicated visuals for the cover, case studies, project showcases, and key section moments; do not reuse the same image on adjacent pages.`,
    "Write visual-assets.json with this shape: {\"artDirection\":{\"palette\":\"...\",\"typography\":\"...\",\"imageStyle\":\"...\",\"decorativeLanguage\":\"...\",\"consistencyKey\":\"stable description of recurring character, lighting, lens, material and color treatment\"},\"assets\":[{\"token\":\"asset://visual-01.png\",\"file\":\"visual-01.png\",\"prompt\":\"...\",\"aspectRatio\":\"4:5\",\"purpose\":\"hero portrait\"}]}. Every asset prompt must repeat the relevant consistencyKey details so independently generated images still belong to one visual world.",
    "For image elements, use style.objectFit and style.objectPosition plus style.clipPath or a borderRadius of at least 16px to create intentional bitmap masks. At least one generated bitmap in every deck must be visibly masked. Never stretch an image.",
    "For every image crop, choose objectFit cover or contain deliberately and set an objectPosition that keeps the subject visible. Never use fill for photographic content.",
    "Do not output HTML, JavaScript, remote URLs, CDNs, external fonts, file URLs, or network requests.",
    "Keep all element bounds inside 1024x576 and use sufficient color contrast.",
    job.referencePaths.length
      ? "Attached images are visual references. Match their composition logic, color relationships, type hierarchy, image treatment, and density without copying text or logos. Use them selectively and prefer them over generating unnecessary new imagery."
      : "No reference images are attached; create a purposeful visual system and request generated bitmaps only when they materially improve communication.",
    job.presentationReference ? `A PowerPoint reference was supplied. This is a binding visual-source contract, not loose inspiration. Every output page must name its mapped source page in templateId as pptx-ref-N and visibly preserve that source family's palette, typography appearance, spacing, image masking, decorative language, and light/dark rhythm. visual-assets.json must derive artDirection only from this reference; never introduce an unrelated neon-cyan, glassmorphism, generic corporate, dashboard, or technology theme unless it visibly exists in the supplied pages.\n${job.presentationReference}` : "",
    "Write files only inside the exact output directory below:",
    job.outputDir,
    `Write slide-01.json through slide-${String(job.pageCount).padStart(2, "0")}.json.`,
    "Each slide JSON must use this shape: {\"title\":\"...\",\"intent\":\"cover\",\"archetype\":\"cover-hero\",\"templateId\":\"cover\",\"background\":\"#ffffff\",\"elements\":[{\"id\":\"headline\",\"type\":\"text\",\"slot\":\"title\",\"parentId\":null,\"text\":\"...\",\"src\":\"\",\"locked\":false,\"aiLocked\":false,\"style\":{\"color\":\"#0f172a\",\"background\":\"\",\"fontFamily\":\"Inter, sans-serif\",\"fontSize\":\"52px\",\"fontWeight\":\"700\",\"lineHeight\":\"1.05\",\"textAlign\":\"left\",\"borderRadius\":\"0\",\"opacity\":\"1\",\"transform\":\"\",\"objectFit\":\"cover\",\"objectPosition\":\"50% 50%\",\"clipPath\":\"\",\"boxShadow\":\"\",\"border\":\"\"}}]}",
    "Also write manifest.json as valid JSON: {\"slides\":[{\"file\":\"slide-01.json\",\"title\":\"...\"}]}",
    "The manifest order is the presentation order and must contain exactly the requested number of entries.",
    "Run a final visual QA pass before finishing: reject text collisions, clipped text, low contrast, stretched images, excessive tiny copy, repeated compositions, and decorative elements that do not support the message.",
    "Do not modify repository source code. Do not ask follow-up questions. Do not merely describe the slides; create all files.",
    "",
    "User brief:",
    job.prompt
  ].join("\n");
}

function normalizeVisualDirection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {
    deckStyle: String(value.deckStyle || "").trim().slice(0, 600),
    goal: String(value.goal || "").trim().slice(0, 240),
    audience: String(value.audience || "").trim().slice(0, 240),
    scenario: String(value.scenario || "").trim().slice(0, 240),
    presets: Array.isArray(value.presets) ? value.presets.map((item) => String(item || "").trim().slice(0, 80)).filter(Boolean).slice(0, 12) : []
  };
  return Object.values(normalized).some((item) => Array.isArray(item) ? item.length : item) ? normalized : null;
}

function outlinePrompt(job) {
  return [
    "Act as a senior presentation strategist. Plan the slide deck before any visual generation.",
    `Create exactly ${job.pageCount} pages from the user's structured brief.`,
    "First infer four decision groups from the brief: core goal, target audience, presentation scenario, and deck length.",
    "For goal, audience, and scenario, provide one recommended selection plus 2-3 concise alternatives. For length, select the requested page count and provide 2-3 reasonable numeric alternatives.",
    "Each page must have a clear role in one coherent narrative. Avoid repeated generic sections.",
    "Choose and save a page intent from: cover, hero, chart, comparison, process, timeline, architecture, case, dashboard, summary, image.",
    "For every page provide a concise title, one-sentence key message, page type, and a concrete visual direction.",
    "Do not create HTML or images in this step.",
    `Write valid JSON to this exact path: ${path.join(job.outputDir, "outline.json")}`,
    "Use exactly this shape: {\"title\":\"deck title\",\"style\":\"visual system summary\",\"requirements\":{\"goal\":{\"selected\":\"...\",\"options\":[\"...\"]},\"audience\":{\"selected\":\"...\",\"options\":[\"...\"]},\"scenario\":{\"selected\":\"...\",\"options\":[\"...\"]},\"length\":{\"selected\":\"5\",\"options\":[\"5\",\"8\",\"12\"]}},\"slides\":[{\"title\":\"...\",\"message\":\"...\",\"type\":\"...\",\"intent\":\"...\",\"visual\":\"...\"}]}",
    "Do not modify repository source code. Do not ask follow-up questions.",
    "",
    "Structured brief:",
    job.presentationReference ? `PowerPoint reference analysis:\n${job.presentationReference}` : "",
    job.prompt
  ].join("\n");
}

async function readGeneratedOutline(job) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(job.outputDir, "outline.json"), "utf8"));
  } catch {
    throw new Error("AI finished without a valid presentation outline.");
  }
  const slides = normalizeOutline(parsed.slides, job.pageCount);
  if (!slides || slides.length !== job.pageCount) {
    throw new Error(`AI returned ${slides?.length || 0} outline pages; ${job.pageCount} were requested.`);
  }
  return {
    title: String(parsed.title || "AI 幻灯片").trim().slice(0, 120),
    style: String(parsed.style || "").trim().slice(0, 600),
    requirements: normalizeOutlineRequirements(parsed.requirements, job.pageCount),
    slides
  };
}

function normalizeOutlineRequirements(value, pageCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalizeGroup = (group, fallback = "") => {
    const selected = String(group?.selected || fallback).trim().slice(0, 180);
    const options = Array.isArray(group?.options)
      ? group.options.map((item) => String(item || "").trim().slice(0, 180)).filter(Boolean).slice(0, 6)
      : [];
    if (selected && !options.includes(selected)) options.unshift(selected);
    return { selected, options:[...new Set(options)].slice(0, 6) };
  };
  return {
    goal: normalizeGroup(value.goal),
    audience: normalizeGroup(value.audience),
    scenario: normalizeGroup(value.scenario),
    length: normalizeGroup(value.length, String(pageCount))
  };
}

function normalizeOutline(value, expectedCount) {
  if (!Array.isArray(value)) return null;
  const slides = value.slice(0, maxSlides).map((item, index, source) => ({
    title: String(item?.title || `幻灯片 ${index + 1}`).trim().slice(0, 120),
    message: String(item?.message || "").trim().slice(0, 600),
    type: String(item?.type || "insight").trim().slice(0, 40),
    intent: inferSlideIntent(item, index, source.length),
    visual: String(item?.visual || "").trim().slice(0, 600)
  }));
  if (!slides.length || (expectedCount && slides.length !== expectedCount)) return null;
  return slides;
}

async function writeReferences(jobDir, references) {
  const list = Array.isArray(references) ? references.slice(0, 4) : [];
  const paths = [];
  const presentationContexts = [];
  for (let index = 0; index < list.length; index += 1) {
    const reference = typeof list[index] === "string" ? { kind:"image", dataUrl:list[index], name:`reference-${index + 1}` } : list[index] || {};
    const source = String(reference.dataUrl || "");
    const pptxMatch = /^data:application\/(?:vnd\.openxmlformats-officedocument\.presentationml\.presentation|octet-stream);base64,([A-Za-z0-9+/=]+)$/.exec(source);
    if (reference.kind === "pptx" && pptxMatch) {
      const inspected = await inspectPptxReference(Buffer.from(pptxMatch[1], "base64"), jobDir, reference.name);
      presentationContexts.push(inspected.context);
      for (const mediaPath of inspected.mediaPaths) if (paths.length < 4) paths.push(mediaPath);
      continue;
    }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(source);
    if (!match) continue;
    const extension = match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : "jpg";
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 3 * 1024 * 1024) continue;
    const target = path.join(jobDir, `reference-${index + 1}.${extension}`);
    await fs.writeFile(target, buffer);
    paths.push(target);
  }
  return { imagePaths:paths.slice(0, 4), presentationContext:presentationContexts.join("\n\n").slice(0, 60_000) };
}

async function readGeneratedSlides(job) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(job.outputDir, "manifest.json"), "utf8"));
  } catch {
    throw new Error("AI finished without a valid slide manifest.");
  }
  if (!Array.isArray(manifest.slides) || manifest.slides.length !== job.pageCount) {
    throw new Error(`AI returned ${manifest.slides?.length || 0} slides; ${job.pageCount} were requested.`);
  }
  const slides = [];
  for (const [index, entry] of manifest.slides.entries()) {
    const filename = path.basename(String(entry?.file || ""));
    if (!/^slide-\d{2}\.(?:json|html)$/i.test(filename)) throw new Error(`Slide ${index + 1} has an invalid filename.`);
    const filePath = path.join(job.outputDir, filename);
    const stat = await fs.stat(filePath);
    if (stat.size < 100 || stat.size > maxHtmlBytes) throw new Error(`Slide ${index + 1} has an invalid file size.`);
    const source = await fs.readFile(filePath, "utf8");
    if (/\.json$/i.test(filename)) {
      let frame;
      try { frame = JSON.parse(source); } catch { throw new Error(`Slide ${index + 1} is not valid Frame JSON.`); }
      if (!Array.isArray(frame.elements) || !frame.elements.length) throw new Error(`Slide ${index + 1} has no structured elements.`);
      frame = applyDeterministicLayout(frame, { index, count:job.pageCount, preserveCoordinates:Boolean(job.presentationReference) });
      validatePreLayout(frame);
      frame.elements = frame.elements.map((element) => element?.type === "chart"
        ? { ...element, ...renderSlideChart(element.chart, { width:element.width, height:element.height }) }
        : element);
      validateGeneratedFrame(frame, index);
      if (!job.presentationReference && frame.elements.some((element) => String(element?.slot || "").trim())) validatePostLayout(frame);
      slides.push({
        type: "slide-frame",
        title: String(frame.title || entry.title || `幻灯片 ${index + 1}`).trim().slice(0, 100),
        intent:frame.intent, archetype:frame.archetype, skillRoute:frame.skillRoute, layoutSpec:frame.layoutSpec,
        templateId: String(frame.templateId || "freeform").trim().slice(0, 120),
        background: String(frame.background || "#ffffff").trim().slice(0, 300),
        elements: frame.elements
      });
    } else {
      if (!/<html[\s>]/i.test(source) || !/<body[\s>]/i.test(source)) throw new Error(`Slide ${index + 1} is not a complete HTML document.`);
      if (hasExternalResource(source)) throw new Error(`Slide ${index + 1} contains an external resource.`);
      slides.push({ type: "html", title: String(entry.title || `幻灯片 ${index + 1}`).trim().slice(0, 100), html: source });
    }
  }
  if (job.presentationReference) {
    const unmapped = slides
      .map((slide, index) => /^pptx-ref-\d+$/i.test(String(slide.templateId || "")) ? null : index + 1)
      .filter(Boolean);
    if (unmapped.length) throw new Error(`PPTX reference mapping is missing on slides ${unmapped.join(", ")}; set templateId to pptx-ref-N and rebuild those pages from the mapped source composition.`);
  }
  return slides;
}

function validateDeckVisualVariety(slides) {
  const frames = slides.filter((slide) => slide.type === "slide-frame");
  if (frames.length !== slides.length) throw new Error("All newly generated slides must use structured Frame JSON.");
  const signatures = frames.map((slide) => {
    const elements = slide.elements || [];
    const dominant = elements
      .filter((element) => ["image", "svg", "chart", "shape", "group"].includes(element.type))
      .sort((a,b) => (Number(b.width) || 0) * (Number(b.height) || 0) - (Number(a.width) || 0) * (Number(a.height) || 0))[0];
    const centerX = dominant ? (Number(dominant.x) || 0) + (Number(dominant.width) || 0) / 2 : 512;
    const zone = centerX < 410 ? "left" : centerX > 614 ? "right" : "center";
    const imageCount = elements.filter((element) => element.type === "image").length;
    const groupCount = elements.filter((element) => element.type === "group").length;
    return `${slide.templateId}:${zone}:i${Math.min(imageCount,3)}:g${Math.min(groupCount,3)}`;
  });
  for (let index = 1; index < signatures.length; index += 1) {
    if (signatures[index] === signatures[index - 1]) {
      throw new Error(`Slides ${index} and ${index + 1} repeat the same visual silhouette; revise one composition.`);
    }
  }
  const counts = new Map();
  for (const signature of signatures) counts.set(signature, (counts.get(signature) || 0) + 1);
  if ([...counts.values()].some((count) => count > Math.max(2, Math.ceil(frames.length / 3)))) {
    throw new Error("The deck repeats one visual composition too often; increase cross-slide layout variety.");
  }
  const usedBitmapTokens = frames.flatMap((slide) => slide.elements
    .filter((element) => element.type === "image" && String(element.src || "").startsWith("asset://"))
    .map((element) => String(element.src)));
  const uniqueTokens = new Set(usedBitmapTokens);
  const budget = visualAssetBudget(frames.length);
  if (uniqueTokens.size < budget.min) throw new Error(`The deck needs at least ${budget.min} distinct bitmap visual concepts.`);
}

function validateGeneratedFrame(frame, index) {
  const elements = frame.elements;
  const ids = new Set();
  let dominantVisualArea = 0;
  let visibleText = 0;
  let bitmapArea = 0;
  let maskedBitmapArea = 0;
  let svgCount = 0;
  const removableGlyphIds = new Set();
  const topLevel = [];
  for (const element of elements) {
    const id = String(element?.id || "").trim();
    if (!id || ids.has(id)) throw new Error(`Slide ${index + 1} contains duplicate or missing element ids.`);
    ids.add(id);
    const x = Number(element.x) || 0;
    const y = Number(element.y) || 0;
    const width = Number(element.width) || 0;
    const height = Number(element.height) || 0;
    if (width < 1 || height < 1 || x < 0 || y < 0 || x + width > 1024 || y + height > 576) {
      throw new Error(`Slide ${index + 1} contains an element outside the 1024×576 frame.`);
    }
    if (element.type === "text") {
      const text = String(element.text || "").trim();
      visibleText += text.length;
      const fontSize = Math.max(6, Number.parseFloat(element.style?.fontSize) || 24);
      const lineHeight = Math.max(0.8, Number.parseFloat(element.style?.lineHeight) || 1.2);
      const wrappedLines = text.split(/\n/).reduce((total, line) => {
        const visualUnits = [...line].reduce((sum, character) => sum + (/[^\x00-\xff]/.test(character) ? 1 : 0.56), 0);
        return total + Math.max(1, Math.ceil((visualUnits * fontSize) / Math.max(1, width)));
      }, 0);
      const requiredHeight = wrappedLines * fontSize * lineHeight * 1.12;
      if (text && requiredHeight > height + 2) throw new Error(`Slide ${index + 1} has clipped text in element ${id}; increase its text box height or shorten the copy.`);
      const symbolOnlyDecoration = text.length > 0
        && text.replace(/\s/gu, "").length <= 8
        && /^[★☆✦✧✶✳✴❖◆◇▶►➜→←↑↓\s]+$/u.test(text);
      if (symbolOnlyDecoration) {
        removableGlyphIds.add(id);
        continue;
      }
    }
    if (["image", "svg", "chart"].includes(element.type)) dominantVisualArea = Math.max(dominantVisualArea, width * height);
    if (element.type === "image") {
      bitmapArea = Math.max(bitmapArea, width * height);
      const style = element.style || {};
      if (!["cover", "contain", "scale-down"].includes(String(style.objectFit || ""))) throw new Error(`Slide ${index + 1} image ${id} needs a deliberate cover or contain crop.`);
      if (String(style.clipPath || "").trim() || Number.parseFloat(style.borderRadius) >= 16) maskedBitmapArea = Math.max(maskedBitmapArea, width * height);
    }
    if (element.type === "svg") svgCount += 1;
    if (element.type === "chart") svgCount += 1;
    if (element.type === "svg" && !/^data:image\/svg\+xml(?:;charset=[^;,]+)?(?:;base64)?,/i.test(String(element.src || ""))) {
      throw new Error(`Slide ${index + 1} contains an invalid SVG asset.`);
    }
    if (!element.parentId) topLevel.push({ element, id, x, y, width, height });
  }
  const intersectionArea = (left, right) => Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)) * Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  for (let rightIndex = 1; rightIndex < topLevel.length; rightIndex += 1) {
    const upper = topLevel[rightIndex]; const upperStyle = upper.element.style || {}; const upperArea = upper.width * upper.height;
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
      const lower = topLevel[leftIndex]; const lowerArea = lower.width * lower.height; const overlap = intersectionArea(lower, upper); if (!overlap) continue;
      if (upper.element.type === "text" && lower.element.type === "text" && overlap / Math.min(upperArea, lowerArea) > 0.12) throw new Error(`Slide ${index + 1} has overlapping text elements ${lower.id} and ${upper.id}.`);
      const isPanel = ["shape", "group", "table"].includes(upper.element.type) && String(upperStyle.background || "").trim() && (Number.parseFloat(upperStyle.opacity) || 1) >= 0.2;
      const lowerIsContent = ["text", "group", "table", "image", "svg", "chart"].includes(lower.element.type);
      if (isPanel && lowerIsContent && upperArea > 12_000 && overlap / Math.min(upperArea, lowerArea) > 0.55) throw new Error(`Slide ${index + 1} has an unrelated panel ${upper.id} obscuring ${lower.id}; regroup or reflow the composition.`);
    }
  }
  if (removableGlyphIds.size) {
    frame.elements = elements.filter((element) => !removableGlyphIds.has(String(element?.id || "").trim()));
  }
  if (visibleText > 1100) throw new Error(`Slide ${index + 1} is too text-heavy for a presentation page.`);
  if (["cover", "section", "case-study", "solution"].includes(String(frame.templateId || "")) && dominantVisualArea < 110_000) {
    throw new Error(`Slide ${index + 1} needs a stronger dominant visual.`);
  }
  if (["cover", "case-study"].includes(String(frame.templateId || "")) && bitmapArea < 90_000) {
    throw new Error(`Slide ${index + 1} needs a substantial bitmap focal point, not only basic vector shapes.`);
  }
  if (bitmapArea && !maskedBitmapArea) throw new Error(`Slide ${index + 1} must apply an intentional mask or corner treatment to bitmap imagery.`);
  if (!bitmapArea && !svgCount && elements.length > 5) throw new Error(`Slide ${index + 1} needs SVG editorial graphics instead of a text-and-box-only composition.`);
}

function hasExternalResource(html) {
  return /\b(?:src|href)\s*=\s*["']\s*(?:https?:|file:|ftp:)/i.test(html)
    || /\burl\(\s*["']?\s*(?:https?:|file:|ftp:)/i.test(html)
    || /\b(?:fetch|importScripts)\s*\(\s*["']\s*(?:https?:|file:|ftp:)/i.test(html);
}

async function importSlides(job, slides) {
  const storeOptions = { canvasId: job.canvasId };
  const state = await readState(job.projectDir, storeOptions);
  const deck = state.objects.find((object) => object.id === job.deckId && object.type === "slides");
  if (!deck) throw new Error("The slide deck was removed before generation finished.");
  const existingIds = Array.isArray(deck.slideIds) ? deck.slideIds.filter((id) => state.objects.some((object) => object.id === id)) : [];
  const replacementIndex = job.targetSlideId ? existingIds.indexOf(job.targetSlideId) : -1;
  if (job.targetSlideId && replacementIndex < 0) throw new Error("The slide selected for regeneration no longer exists in this deck.");
  const created = [];
  try {
    for (const [index, slide] of slides.entries()) {
      created.push(await addObject(job.projectDir, {
        type: slide.type || "slide-frame", name: slide.title, x: deck.x + 12 + (existingIds.length + index) * 1056,
        y: deck.y + 12, width: 1024, height: 576,
        ...(slide.type === "html" ? { html: slide.html } : { intent:slide.intent, archetype:slide.archetype, skillRoute:slide.skillRoute, layoutSpec:slide.layoutSpec, templateId: slide.templateId, background: slide.background, elements: slide.elements })
      }, storeOptions));
    }
    const combinedIds = replacementIndex >= 0
      ? existingIds.flatMap((id, index) => index === replacementIndex ? created.map((object) => object.id) : [id])
      : [...existingIds, ...created.map((object) => object.id)];
    await updateObjects(job.projectDir, [
      { id: deck.id, patch: { slideIds: combinedIds } },
      ...combinedIds.map((id, slideOrder) => ({ id, patch: { slideDeckId: deck.id, slideOrder } }))
    ], { ...storeOptions, selection: null });
    if (replacementIndex >= 0) await deleteObjects(job.projectDir, [job.targetSlideId], storeOptions);
    return created.map((object, index) => ({ id: object.id, title: slides[index].title }));
  } catch (error) {
    if (created.length) await deleteObjects(job.projectDir, created.map((object) => object.id), storeOptions).catch(() => {});
    throw error;
  }
}
