"use strict";

const choice = document.querySelector("#journey-choice");
const fullMap = document.querySelector("#full-map");
const zoomOut = document.querySelector("#zoom-out");
const zoomReset = document.querySelector("#zoom-reset");
const zoomIn = document.querySelector("#zoom-in");
const viewport = document.querySelector("#lab-viewport");
const layoutLink = document.querySelector("#lab-layout-link");
const legend = document.querySelector("#map-legend");
const legendToggle = document.querySelector("#legend-toggle");
const managementLegend = document.querySelector("#management-legend");
const selectedLegend = document.querySelector("#selected-legend");
const inspectorTitle = document.querySelector("#lab-inspector-title");
const map = document.querySelector("#lab-map");
const originalView = map.getAttribute("viewBox");
const routeLayer = document.querySelector("#selected-links");
const packetLayer = document.querySelector("#packet-layer");
const deviceLayer = document.querySelector("#map-devices");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const hopInterval = Number(document.body.dataset.hopInterval) || 3000;
const svgNamespace = "http://www.w3.org/2000/svg";
const panels = [...document.querySelectorAll(".journey")];
const devices = new Map([...map.querySelectorAll("[data-node]")].map(node => [node.dataset.node, node]));
const links = new Map([...map.querySelectorAll("[data-link]")].map(link => [link.dataset.link, link]));
const previous = document.querySelector("#play-previous");
const play = document.querySelector("#play-toggle");
const next = document.querySelector("#play-next");
const stageButtons = document.querySelector("#stage-buttons");
const progress = document.querySelector("#step-status");
const baseMapWidth = 992;
const maxZoom = 200;
const zoomStep = 1.35;

let journey;
let stages = [];
let routeLegs = [];
let deviceSteps = new Map();
let buttons = [];
let index = 0;
let timer;
let autoplayPending = document.body.hasAttribute("data-autoplay");
let zoom = null;
let pan;
let ignorePointerClick = false;

function updateLayoutLink() {
  if (!layoutLink) return;
  const destination = new URL(layoutLink.href);
  destination.search = new URLSearchParams({journey: choice.value});
  if (index) destination.searchParams.set("step", index + 1);
  if (!fullMap.checked) destination.searchParams.set("map", "path");
  if (zoom !== null) destination.searchParams.set("zoom", zoom.toFixed(2));
  layoutLink.href = destination.href;
}

function stop() {
  window.clearInterval(timer);
  timer = undefined;
  play.textContent = "Play";
  packetLayer.replaceChildren();
}

function centerCurrent() {
  const device = devices.get(stages[index].dataset.stage);
  const point = new DOMPoint(Number(device.dataset.x), Number(device.dataset.y));
  const visible = point.matrixTransform(map.getScreenCTM());
  const frame = viewport.getBoundingClientRect();
  viewport.scrollTo({
    left: viewport.scrollLeft + visible.x - frame.left - viewport.clientWidth / 2,
    top: viewport.scrollTop + visible.y - frame.top - viewport.clientHeight / 2,
    behavior: "instant",
  });
}

function revealStep() {
  const rail = progress.closest(".lab-inspector");
  if (rail.scrollHeight > rail.clientHeight && !rail.contains(document.activeElement)) rail.scrollTop = 0;
}

function zoomBounds() {
  const [, , width, height] = map.getAttribute("viewBox").split(" ").map(Number);
  const base = Math.min(width, baseMapWidth);
  const availableWidth = Math.max(1, viewport.clientWidth - 16);
  const availableHeight = Math.max(1, viewport.clientHeight - 16);
  const fit = 100 * Math.min(availableWidth / base, availableHeight / (base * height / width));
  return {base, fit, limit: Math.max(maxZoom, fit * zoomStep)};
}

function applyZoom(percent = zoom) {
  const {base, fit, limit} = zoomBounds();
  const value = Math.min(limit, Math.max(fit, percent ?? fit));
  zoom = value <= fit + 0.01 ? null : value;
  map.style.setProperty("--map-width", `${base * value / 100}px`);
  const display = zoom === null ? "Fit" : `${Math.round(value)}%`;
  zoomReset.textContent = display;
  zoomReset.setAttribute("aria-label", zoom === null ? "Fit diagram in view" : `Zoom ${display}. Fit diagram in view`);
  zoomOut.setAttribute("aria-disabled", String(zoom === null));
  zoomIn.setAttribute("aria-disabled", String(value >= limit));
  updateLayoutLink();
}

function centerDiagram() {
  viewport.scrollTo({
    left: (viewport.scrollWidth - viewport.clientWidth) / 2,
    top: (viewport.scrollHeight - viewport.clientHeight) / 2,
    behavior: "instant",
  });
}

function changeZoom(percent) {
  stop();
  applyZoom(percent);
  centerDiagram();
}

function effectiveZoom() {
  return zoom ?? zoomBounds().fit;
}

function zoomOnWheel(event) {
  if (!event.ctrlKey || !event.deltaY) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  changeZoom(effectiveZoom() * Math.exp(-event.deltaY * unit * 0.003));
}

function updateView(center) {
  const focused = !fullMap.checked;
  const view = focused ? journey.dataset.bounds : originalView;
  const [, , width, height] = view.split(" ");
  map.toggleAttribute("data-focused", focused);
  map.setAttribute("viewBox", view);
  map.setAttribute("width", width);
  map.setAttribute("height", height);
  applyZoom();
  if (center && zoom !== null) centerCurrent();
  else centerDiagram();
}

function showStep(number, center = true) {
  index = number;
  const current = stages[index];
  for (const [i, stage] of stages.entries()) {
    stage.hidden = i !== index;
    if (i === index) buttons[i].setAttribute("aria-current", "step");
    else buttons[i].removeAttribute("aria-current");
  }
  for (const [id, device] of devices) {
    const active = id === current.dataset.stage;
    device.toggleAttribute("data-current", active);
    if (active) device.setAttribute("aria-current", "step");
    else device.removeAttribute("aria-current");
    const visits = deviceSteps.get(id);
    if (visits) {
      const visit = visits.find(step => step >= index) ?? visits.at(-1);
      device.dataset.jump = visit;
      device.setAttribute("aria-label", `Map step ${visit + 1} · ${stages[visit].querySelector(".stage-device").textContent}`);
      device.querySelector(".map-step text").textContent = visit + 1;
    }
  }
  const reached = new Set(routeLegs.slice(0, index).map(leg => leg.element));
  for (const {element} of routeLegs) {
    element.dataset.reached = String(reached.has(element));
  }
  previous.setAttribute("aria-disabled", String(index === 0));
  next.setAttribute("aria-disabled", String(index === stages.length - 1));
  journey.querySelector(".journey-outcome")?.toggleAttribute("hidden", index !== stages.length - 1);
  progress.textContent = `Step ${index + 1} of ${stages.length} · ${current.querySelector("h3").textContent}`;
  revealStep();
  updateLayoutLink();
  if (center) centerCurrent();
}

function showPacket() {
  packetLayer.replaceChildren();
  const leg = routeLegs[index];
  if (timer === undefined || reducedMotion.matches || !leg) return;
  const points = leg.element.querySelector(".map-wire").getAttribute("points").split(" ");
  if (leg.direction === "start") points.reverse();
  const packet = document.createElementNS(svgNamespace, "circle");
  packet.setAttribute("r", "7");
  const motion = document.createElementNS(svgNamespace, "animateMotion");
  motion.setAttribute("path", "M" + points.join(" L"));
  motion.setAttribute("begin", "indefinite");
  motion.setAttribute("dur", `${hopInterval - 200}ms`);
  motion.setAttribute("fill", "freeze");
  packet.append(motion);
  packetLayer.append(packet);
  motion.beginElement();
}

function jumpToStep(number) {
  stop();
  showStep(number);
}

function startPan(event) {
  if (!event.isPrimary || event.button !== 0) return;
  ignorePointerClick = false;
  // Touch uses the native scroll area, including momentum and pinch zoom.
  if (event.pointerType === "touch") return;
  const frame = viewport.getBoundingClientRect();
  if (event.clientX >= frame.left + viewport.clientWidth ||
      event.clientY >= frame.top + viewport.clientHeight) return;
  if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) return;
  pan = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: viewport.scrollLeft,
    top: viewport.scrollTop,
    moved: false,
  };
}

function movePan(event) {
  if (!pan || event.pointerId !== pan.pointer) return;
  if ((event.buttons & 1) === 0) {
    endPan(event);
    return;
  }
  const dx = event.clientX - pan.x;
  const dy = event.clientY - pan.y;
  if (!pan.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    pan.moved = true;
    ignorePointerClick = true;
    stop();
    viewport.setPointerCapture(event.pointerId);
    viewport.setAttribute("data-dragging", "");
  }
  viewport.scrollTo({left: pan.left - dx, top: pan.top - dy, behavior: "instant"});
  event.preventDefault();
}

function endPan(event) {
  if (pan?.pointer !== event.pointerId) return;
  pan = undefined;
  viewport.removeAttribute("data-dragging");
}

function copyLink(id, direction) {
  const copy = links.get(id).cloneNode(true);
  copy.classList.add("route-link");
  if (direction) copy.dataset.direction = direction;
  routeLayer.append(copy);
  return copy;
}

function selectJourney(center = true) {
  stop();
  journey = panels.find(panel => panel.dataset.journey === choice.value);
  for (const panel of panels) {
    panel.hidden = panel !== journey;
    panel.open = panel === journey;
    panel.toggleAttribute("data-enhanced", panel === journey);
  }
  stages = [...journey.querySelectorAll("[data-stage]")];
  deviceSteps = new Map();
  for (const [i, stage] of stages.entries()) {
    const id = stage.dataset.stage;
    const visits = deviceSteps.get(id) ?? [];
    visits.push(i);
    deviceSteps.set(id, visits);
  }
  for (const [id, device] of devices) {
    const included = deviceSteps.has(id);
    device.toggleAttribute("data-on-route", included);
    if (included) {
      device.removeAttribute("aria-hidden");
      device.setAttribute("tabindex", "0");
      device.setAttribute("role", "button");
    } else {
      delete device.dataset.jump;
      device.setAttribute("aria-hidden", "true");
      device.removeAttribute("tabindex");
      device.removeAttribute("role");
      device.removeAttribute("aria-label");
    }
  }
  deviceLayer.append(...Array.from(deviceSteps.keys(), id => devices.get(id)));

  routeLayer.replaceChildren();
  if (journey.dataset.overlay) copyLink(journey.dataset.overlay);
  const drawnLinks = new Map();
  routeLegs = stages.slice(1).map(stage => {
    const id = stage.dataset.leg;
    const direction = links.get(id).dataset.to === stage.dataset.stage ? "end" : "start";
    let element = drawnLinks.get(id);
    if (!element) {
      element = copyLink(id, direction);
      drawnLinks.set(id, element);
    } else if (element.dataset.direction !== direction) {
      element.dataset.direction = "both";
    }
    return {element, direction};
  });
  managementLegend.hidden = !routeLegs.some(({element}) => element.dataset.kind === "management");
  selectedLegend.hidden = routeLegs.every(({element}) => element.dataset.kind === "management");
  inspectorTitle.textContent = selectedLegend.hidden ? "Management walkthrough" : "Packet walkthrough";

  buttons = stages.map((stage, i) => {
    const button = document.createElement("button");
    const title = stage.querySelector("h3").textContent;
    const number = document.createElement("span");
    const description = document.createElement("span");
    button.type = "button";
    number.textContent = i + 1;
    description.textContent = title;
    button.setAttribute("aria-label", `Step ${i + 1} · ${title}`);
    button.append(number, description);
    button.addEventListener("click", () => jumpToStep(i));
    return button;
  });
  stageButtons.replaceChildren(...buttons);
  showStep(0, false);
  updateView(center);
}

previous.addEventListener("click", () => {
  if (index === 0) return;
  jumpToStep(index - 1);
});
next.addEventListener("click", () => {
  if (index === stages.length - 1) return;
  jumpToStep(index + 1);
});
function startPlayback() {
  if (index === stages.length - 1) showStep(0);
  else centerCurrent();
  play.textContent = "Pause";
  timer = window.setInterval(() => {
    showStep(index + 1);
    if (index === stages.length - 1) stop();
    else showPacket();
  }, hopInterval);
  showPacket();
}

function maybeAutoplay() {
  if (!autoplayPending || document.hidden) return;
  autoplayPending = false;
  if (!reducedMotion.matches && index < stages.length - 1) startPlayback();
}

play.addEventListener("click", () => {
  if (timer === undefined) startPlayback();
  else stop();
});
viewport.addEventListener("pointerdown", startPan);
window.addEventListener("pointermove", movePan);
window.addEventListener("pointerup", endPan);
window.addEventListener("pointercancel", endPan);
viewport.addEventListener("lostpointercapture", endPan);
viewport.addEventListener("wheel", zoomOnWheel, {passive: false});
viewport.addEventListener("click", event => {
  if (!ignorePointerClick || event.detail === 0) return;
  ignorePointerClick = false;
  event.preventDefault();
  event.stopPropagation();
}, true);
viewport.addEventListener("keydown", event => {
  if (event.target !== viewport) return;
  const directions = {ArrowLeft: [-72, 0], ArrowRight: [72, 0], ArrowUp: [0, -72], ArrowDown: [0, 72]};
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  stop();
  viewport.scrollBy({left: direction[0], top: direction[1], behavior: "instant"});
});
map.addEventListener("click", event => {
  const device = event.target.closest("[data-jump]");
  if (device) jumpToStep(Number(device.dataset.jump));
});
map.addEventListener("keydown", event => {
  const device = event.target.closest("[data-jump]");
  if (!device || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  jumpToStep(Number(device.dataset.jump));
});
reducedMotion.addEventListener("change", showPacket);
choice.addEventListener("change", () => selectJourney());
fullMap.addEventListener("change", () => updateView(true));
zoomOut.addEventListener("click", () => changeZoom(effectiveZoom() / zoomStep));
zoomReset.addEventListener("click", () => changeZoom(null));
zoomIn.addEventListener("click", () => changeZoom(effectiveZoom() * zoomStep));
legendToggle.addEventListener("click", () => {
  const open = legend.toggleAttribute("data-legend-open");
  legendToggle.setAttribute("aria-expanded", String(open));
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
  else maybeAutoplay();
});

const settings = new URLSearchParams(window.location.search);
if (panels.some(panel => panel.dataset.journey === settings.get("journey"))) {
  choice.value = settings.get("journey");
}
fullMap.checked = settings.get("map") !== "path";
const requestedZoom = Number(settings.get("zoom"));
zoom = Number.isFinite(requestedZoom) && requestedZoom > 0 ? requestedZoom : null;
viewport.setAttribute("data-pan", "");
legend.setAttribute("data-interactive", "");
for (const id of ["lab-picker", "lab-visibility", "lab-controls", "step-status", "lab-zoom", "stage-buttons"]) {
  document.getElementById(id).hidden = false;
}
selectJourney(false);
const requestedStep = Number(settings.get("step"));
if (Number.isInteger(requestedStep) && requestedStep >= 1 && requestedStep <= stages.length) {
  showStep(requestedStep - 1, zoom !== null);
}
new ResizeObserver(() => {
  const previousZoom = zoom;
  applyZoom();
  if (zoom === null || previousZoom !== zoom) centerDiagram();
}).observe(viewport);
maybeAutoplay();
