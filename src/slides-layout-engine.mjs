export const SLIDE_INTENTS = Object.freeze(["cover", "hero", "chart", "comparison", "process", "timeline", "architecture", "case", "dashboard", "summary", "image"]);
export const SLIDE_ARCHETYPES = Object.freeze(["cover-hero", "hero-left", "hero-right", "split-50", "split-40-60", "three-columns", "four-metrics", "comparison", "timeline", "process", "architecture", "dashboard", "case-study", "summary"]);

const intentSet = new Set(SLIDE_INTENTS);
const archetypeSet = new Set(SLIDE_ARCHETYPES);
const W = 1024, H = 576, SAFE = 64, GAP = 24, INNER_W = W - SAFE * 2, INNER_H = H - SAFE * 2;
const box = (x, y, width, height) => ({ x, y, width, height });
const common = {
  title:box(SAFE, SAFE, INNER_W, 64), subtitle:box(SAFE, 136, INNER_W, 52),
  content:box(SAFE, 160, INNER_W, 352), visual:box(512, 144, 448, 368), footer:box(SAFE, 528, INNER_W, 24)
};

export const SLIDE_LAYOUTS = Object.freeze({
  "cover-hero":{ ...common, title:box(SAFE, 112, 500, 132), subtitle:box(SAFE, 260, 460, 80), visual:box(594, SAFE, 366, 448), content:box(SAFE, 356, 500, 112) },
  "hero-left":{ ...common, title:box(500, 88, 460, 88), content:box(500, 192, 460, 288), visual:box(SAFE, 88, 400, 392) },
  "hero-right":{ ...common, title:box(SAFE, 88, 460, 88), content:box(SAFE, 192, 460, 288), visual:box(560, 88, 400, 392) },
  "split-50":{ ...common, left:box(SAFE, 160, 436, 352), right:box(524, 160, 436, 352), content:box(SAFE, 160, 436, 352), visual:box(524, 160, 436, 352) },
  "split-40-60":{ ...common, left:box(SAFE, 160, 346, 352), right:box(434, 160, 526, 352), content:box(SAFE, 160, 346, 352), visual:box(434, 160, 526, 352) },
  "three-columns":{ ...common, col1:box(SAFE, 176, 282, 320), col2:box(371, 176, 282, 320), col3:box(678, 176, 282, 320) },
  "four-metrics":{ ...common, metric1:box(SAFE, 184, 206, 248), metric2:box(294, 184, 206, 248), metric3:box(524, 184, 206, 248), metric4:box(754, 184, 206, 248) },
  comparison:{ ...common, left:box(SAFE, 168, 424, 328), right:box(536, 168, 424, 328) },
  timeline:{ ...common, content:box(SAFE, 184, INNER_W, 280), visual:box(SAFE, 184, INNER_W, 280) },
  process:{ ...common, content:box(SAFE, 176, INNER_W, 312), visual:box(SAFE, 176, INNER_W, 312) },
  architecture:{ ...common, content:box(SAFE, 152, INNER_W, 360), visual:box(SAFE, 152, INNER_W, 360) },
  dashboard:{ ...common, content:box(SAFE, 152, INNER_W, 360), visual:box(SAFE, 152, INNER_W, 360) },
  "case-study":{ ...common, title:box(SAFE, 72, 424, 72), content:box(SAFE, 168, 424, 328), visual:box(536, 72, 424, 424) },
  summary:{ ...common, title:box(SAFE, 96, INNER_W, 80), content:box(140, 200, 744, 248), visual:box(140, 200, 744, 248) }
});

function textOf(page = {}) { return `${page.type || ""} ${page.title || ""} ${page.message || ""} ${page.visual || ""}`.toLowerCase(); }
export function inferSlideIntent(page = {}, index = 0, count = 1) {
  const explicit = String(page.intent || page.type || "").toLowerCase();
  if (intentSet.has(explicit)) return explicit;
  const text = textOf(page);
  if (index === 0 || /\bcover\b|封面/.test(text)) return "cover";
  if (index === count - 1 || /\bsummary\b|总结|结论/.test(text)) return "summary";
  if (/dashboard|仪表盘|大屏/.test(text)) return "dashboard";
  if (/architecture|架构|系统图/.test(text)) return "architecture";
  if (/timeline|roadmap|时间线|里程碑/.test(text)) return "timeline";
  if (/process|流程|步骤|路径/.test(text)) return "process";
  if (/comparison|对比|比较|vs\.?/.test(text)) return "comparison";
  if (/chart|data|趋势|占比|数据|指标/.test(text)) return "chart";
  if (/case|案例/.test(text)) return "case";
  if (/image|photo|图片|照片|主视觉/.test(text)) return "image";
  return "hero";
}

export function skillRouteForIntent(intent) {
  if (intent === "chart") return "echarts";
  if (["process", "timeline", "architecture"].includes(intent)) return "svg-diagram";
  if (["cover", "hero"].includes(intent)) return "art-direction-imagegen";
  if (intent === "dashboard") return "data-viz";
  if (intent === "image") return "image-crop-focal-point";
  return "layout";
}

export function archetypeForIntent(intent, preferred = "") {
  if (archetypeSet.has(preferred)) return preferred;
  return ({ cover:"cover-hero", hero:"hero-right", chart:"split-40-60", comparison:"comparison", process:"process", timeline:"timeline", architecture:"architecture", case:"case-study", dashboard:"dashboard", summary:"summary", image:"hero-left" })[intent] || "split-50";
}

function inferredSlot(element, index, archetype) {
  const explicit = String(element?.slot || "");
  if (SLIDE_LAYOUTS[archetype]?.[explicit]) return explicit;
  if (element?.type === "text") return index === 0 ? "title" : index === 1 ? "subtitle" : "content";
  if (["image", "svg", "chart"].includes(element?.type)) return "visual";
  return "content";
}

export function applyDeterministicLayout(frame, { index = 0, count = 1, preserveCoordinates = false } = {}) {
  const intent = inferSlideIntent(frame, index, count);
  const archetype = archetypeForIntent(intent, String(frame.archetype || frame.layoutSpec?.archetype || ""));
  const slots = SLIDE_LAYOUTS[archetype];
  const hasExplicitSlots = (frame.elements || []).some((element) => String(element?.slot || "").trim());
  const elements = (frame.elements || []).map((element, elementIndex) => {
    const slot = inferredSlot(element, elementIndex, archetype);
    const target = slots[slot] || slots.content;
    if (preserveCoordinates || !hasExplicitSlots || element.parentId || element.layoutLocked === true) return { ...element, slot };
    return { ...element, slot, ...target };
  });
  return { ...frame, intent, archetype, skillRoute:skillRouteForIntent(intent), layoutSpec:{ canvas:"16:9", width:W, height:H, safeArea:SAFE, columns:12, gap:GAP, archetype }, elements };
}

export function validatePreLayout(frame) {
  if (!intentSet.has(frame.intent)) throw new Error(`Unknown slide intent: ${frame.intent}`);
  if (!archetypeSet.has(frame.archetype)) throw new Error(`Unknown slide archetype: ${frame.archetype}`);
  if (frame.skillRoute !== skillRouteForIntent(frame.intent)) throw new Error(`Intent ${frame.intent} must route through ${skillRouteForIntent(frame.intent)}.`);
  if (frame.intent === "chart" && !frame.elements.some((element) => element.type === "chart" && element.chart)) throw new Error("Chart intent requires an editable ECharts chart model.");
  if (["process", "timeline", "architecture"].includes(frame.intent) && !frame.elements.some((element) => element.type === "svg")) throw new Error(`${frame.intent} intent requires an SVG diagram layer.`);
}

export function validatePostLayout(frame) {
  for (const element of frame.elements || []) {
    if (element.parentId || element.layoutLocked === true || element.type === "shape") continue;
    const { x, y, width, height } = element;
    if ([x, y, width, height].some((value) => !Number.isFinite(Number(value)))) throw new Error(`Element ${element.id} has invalid layout geometry.`);
    if (x < SAFE || y < SAFE || x + width > W - SAFE || y + height > H - 24) throw new Error(`Element ${element.id} violates the deterministic content-safe area.`);
  }
}
