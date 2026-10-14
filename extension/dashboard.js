// The dashboard: start and watch runs, answer the bot's questions, see the history, edit the settings.
// Runs happen in the background worker; this page shows their state (chrome.storage.session "run:<site>").
const SITES = {
  hirist: { name: "Hirist", keywords: "One per line. Each one is its own Hirist search.", pages: "20 jobs each" },
  instahyre: { name: "Instahyre", keywords: "Skills, one per line, like machine learning. Each is searched once for every year of your experience range." },
  wellfound: {
    name: "Wellfound", keywords: "Wellfound role names, one per line, like machine learning engineer. Roles it doesn't have are skipped.",
    pages: "25-30 jobs each", locations: true,
  },
  cutshort: {
    name: "Cutshort", keywords: "Cutshort skill names, one per line, like machine learning. Each is looked up once in Cutshort's Skills filter; skills it doesn't have are skipped.",
    pages: "a few jobs each",
  },
};
const STATUS = {
  applied: "Applied",
  needs_manual: "Needs you",
  external: "Other site",
  skipped: "Skipped",
  failed: "Failed",
  already_applied: "Applied before",
  would_apply: "Would apply",
};
const CELL = { seen: "Handled before", filtered: "Skipped by your filters", pending: "Not reached", working: "Working on it now" };
const CHIPS = [["applied", "Applied"], ["needs_manual", "Needs you"], ["external", "Other site"], ["skipped", "Skipped"], ["failed", "Failed"], ["", "All"]];
const FORMAT = "job-apply-bots/1";
const HISTORY_LIMIT = 300;

const runs = {}; // site -> its latest run, as the background worker saved it
const ui = { stopping: {}, error: {}, logKey: "", stripKey: "", eventsKey: "" };
const filter = { status: "applied", text: "", site: "" };
let settings = null; // as last saved
let jobs = {};

// ---------------------------------------------------------------- small helpers

function remember(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
}

let site = SITES[remember("site")] ? remember("site") : Object.keys(SITES)[0]; // the site the overview shows

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply || reply.error) throw new Error(reply ? reply.error : "The extension didn't answer. Reload this page.");
  return reply;
}

const $ = id => document.getElementById(id);
const panel = () => $("page-overview");
const today = () => JB.store.now().slice(0, 10);
const clock = d => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function when(ts) {
  const d = new Date(String(ts).replace(" ", "T"));
  if (isNaN(d)) return ts || "";
  if (d.toDateString() === new Date().toDateString()) return `Today ${clock(d)}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(d)}`;
}

function glyph(status) {
  return el("span", { className: `glyph s-${status}`, ariaHidden: "true" });
}

/** The bot's note on a job, said the way a person would. */
function describe(status, note) {
  note = (note || "").trim();
  const unanswered = /^unanswered: (.*)$/.exec(note);
  if (unanswered) {
    const questions = unanswered[1].split("; ")
      .map(q => q.replace(/^\d+\.\s*/, "").replace(/\s+(Yes No|No Yes)$/, "").replace(/\s*\d+ characters? l(e(ft?)?)?$/, "").trim())
      .filter(Boolean);
    return `Couldn't answer: ${questions.join("; ")}`;
  }
  const external = /^apply opens an external site(?:: (\S+))?$/.exec(note) || /^redirected to (\S+)$/.exec(note);
  if (external) return external[1] ? `Applies on the company's site: ${external[1].replace(/^https?:\/\//, "")}` : "Applies on the company's site";
  const senior = /^needs (\S+)\+ yrs$/.exec(note);
  if (senior) return `Asks for ${senior[1]}+ years`;
  const word = /^title has '(.+)'$/.exec(note);
  if (word) return `Title has "${word[1]}"`;
  const reasons = {
    "title not in include_title": "Title isn't one you look for",
    "not an engineering role": "Not an engineering role",
    "couldn't read job title": "Couldn't read the job title",
    declined: "You chose to skip it",
    "no apply button found": "No apply button on the page",
    "couldn't confirm the application went through": "Couldn't confirm the application went through",
    "finished by hand": "You finished it",
  };
  if (reasons[note]) return reasons[note];
  if (/^company '/.test(note)) return note.replace(/^company '(.+)' excluded$/, "Company \"$1\" is on your skip list");
  if (/^description mentions '/.test(note)) return note.replace(/^description mentions '(.+)'$/, "Description mentions \"$1\"");
  if (!note) return status === "would_apply" ? "Would apply (dry run)" : STATUS[status] || "";
  return note.charAt(0).toUpperCase() + note.slice(1);
}

// ---------------------------------------------------------------- one tooltip for the strip and the chart

const tip = $("tip");
function showTip(target, title, text) {
  tip.replaceChildren(el("b", { textContent: title }), text || "");
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const top = r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };
function tipOn(target, title, text) {
  target.addEventListener("pointerenter", () => showTip(target, title, text));
  target.addEventListener("focus", () => showTip(target, title, text));
  target.addEventListener("pointerleave", hideTip);
  target.addEventListener("blur", hideTip);
}

// ---------------------------------------------------------------- pages

function showPage(name) {
  const [page, which] = name.split("/");
  name = ["overview", "history", "settings"].includes(page) ? page : "overview";
  if (name === "overview" && SITES[which]) selectSite(which);
  for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== `page-${name}`;
  for (const link of document.querySelectorAll(".nav a")) {
    if (link.dataset.page === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  hideTip();
}

function goto(section) {
  location.hash = "#settings";
  showPage("settings");
  requestAnimationFrame(() => $(`set-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

// ---------------------------------------------------------------- running

function options() {
  const q = name => panel().querySelector(`.opts [name="${name}"]`);
  return { confirm: q("confirm").checked, assist: q("assist").checked, max: parseInt(q("max").value, 10) || null };
}

async function start(action) {
  ui.error[site] = "";
  ui.stopping[site] = false;
  panel().querySelector("details.opts").open = false;
  try {
    await send({ type: "start", site: site, action, opts: options() });
  } catch (e) {
    ui.error[site] = e.message;
  }
  renderRun();
}

async function stop() {
  ui.stopping[site] = true;
  renderRun();
  try {
    await send({ type: "stop", site: site });
  } catch (e) {
    ui.error[site] = e.message;
    renderRun();
  }
}

async function answer(id, value) {
  panel().querySelector(".prompt").hidden = true;
  try {
    await send({ type: "answer", site: site, id, value });
  } catch (e) {
    ui.error[site] = e.message;
    renderRun();
  }
}

function loadOptions() {
  const opts = remember(`opts.${site}`) || {};
  for (const input of panel().querySelectorAll(".opts input")) {
    if (input.type === "checkbox") input.checked = !!opts[input.name];
    else input.value = opts[input.name] || "";
  }
}

/** Show this site on the overview. */
function selectSite(name) {
  if (!SITES[name]) return;
  site = name;
  remember("site", name);
  $("site-name").textContent = SITES[name].name;
  ui.logKey = ui.stripKey = ui.eventsKey = "";
  loadOptions();
  if (settings) {
    renderRun();
    renderRail();
  }
}

function buildRunPanel() {
  for (const input of panel().querySelectorAll(".opts input")) {
    input.addEventListener("change", () => remember(`opts.${site}`, options()));
  }
  panel().addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "stop") stop();
    else if (act) start(act);
  });
  document.addEventListener("click", e => { // close the options menu when clicking elsewhere
    const opts = panel().querySelector("details.opts");
    if (opts.open && !opts.contains(e.target)) opts.open = false;
  });
}

function finished(run) {
  const at = clock(new Date(run.ended));
  if (run.stopped) return [`Stopped at ${at}.`, false];
  if (run.error === "interrupted") return [`Interrupted at ${at}: Chrome restarted the extension. Click Apply to carry on.`, true];
  if (run.error) return [`Ended with an error at ${at}: ${run.error}`, true];
  const done = [...run.log].reverse().find(l => /^(Done:|Daily limit|Logged in|Still not logged in|Not logged in .*stopping|Nothing to search|Browser window)/.test(l));
  const what = done ? ` ${done.replace(/^Done: /, "").replace(/^\w/, c => c.toUpperCase())}` : "";
  return [`Last run finished at ${at}.${what}`, false];
}

function renderRun() {
  const run = runs[site];
  const running = !!run?.running;
  if (!running) ui.stopping[site] = false;
  const p = panel();
  p.dataset.state = !running ? "idle" : run.prompt ? "waiting" : "running";

  const apply = p.querySelector('[data-act="apply"]');
  apply.textContent = !running ? "Apply" : run.action === "apply" ? "Applying…" : run.action === "dry-run" ? "Checking…" : "Logging in…";
  apply.classList.toggle("busy", running);
  for (const b of p.querySelectorAll('[data-act="apply"], [data-act="dry-run"], [data-act="login"]')) b.disabled = running;
  p.querySelector('[data-act="stop"]').hidden = !running;

  let [text, isError] = ["", false];
  if (ui.error[site]) [text, isError] = [ui.error[site], true];
  else if (ui.stopping[site] && running) text = "Stopping after this step, then closing its window…";
  else if (running && run.prompt) text = "Waiting for you.";
  else if (running && run.action === "dry-run") text = "Going through jobs without applying, in its own window.";
  else if (running && run.action === "login") text = "Waiting for you to log in, in its own window.";
  else if (running) text = "Applying in its own Chrome window. Leave that window open.";
  else if (run) [text, isError] = finished(run);
  else text = "Ready. A dry run first shows what it would apply to.";
  const status = p.querySelector(".status");
  status.textContent = text;
  status.classList.toggle("err", isError);

  renderPrompt();
  renderStrip();
  renderEvents();
  renderLog();
  renderSites();
  renderTitle();
}

function renderPrompt() {
  const run = runs[site];
  const box = panel().querySelector(".prompt");
  const p = run?.running ? run.prompt : null;
  const key = p ? String(p.id) : "";
  if (box.dataset.key === key && box.hidden === !p) return; // unchanged: don't rebuild under the cursor
  box.dataset.key = key;
  box.hidden = !p;
  if (!p) return;
  box.querySelector(".prompt-q").replaceChildren(el("small", { textContent: p.title }), p.text);
  box.querySelector(".prompt-answers").replaceChildren(
    ...p.choices.map(([label, value, kind]) => el("button", { className: `btn ${kind || ""}`, textContent: label, onclick: () => answer(p.id, value) })),
  );
}

function renderStrip() {
  const run = runs[site];
  const page = run?.page;
  const key = JSON.stringify([run?.id, run?.running, page?.cells?.map(c => c.state)]);
  $("now").textContent = run?.running ? run.now || "" : "";
  if (key === ui.stripKey) return;
  ui.stripKey = key;
  $("run-title").textContent = page && !run.running ? "Last page of results" : "Current page of results";
  const strip = $("strip");
  strip.replaceChildren();
  if (!page) {
    $("run-where").textContent = "";
    strip.append(el("li", { className: "empty", textContent: "When it runs, each job on the page it's working through shows up here as a square." }));
    return;
  }
  $("run-where").textContent = `“${page.label}”${page.n > 1 ? `, page ${page.n}` : ""}: ${page.listed} jobs, ${page.fresh} new and matching`;
  for (const cell of page.cells) {
    const s = cell.state === "working" && !run.running ? "pending" : cell.state;
    const name = STATUS[s] || CELL[s] || s;
    const a = el("a", { className: `cell s-${s}`, href: cell.url, target: "_blank", rel: "noopener" });
    a.setAttribute("aria-label", `${cell.label}: ${name}`);
    tipOn(a, name, cell.label);
    strip.append(el("li", {}, a));
  }
}

function renderEvents() {
  const events = runs[site]?.events || [];
  const key = `${runs[site]?.id}:${events.length}`;
  if (key === ui.eventsKey) return;
  ui.eventsKey = key;
  const list = $("events");
  list.replaceChildren();
  if (!events.length) {
    list.append(el("li", { className: "empty", textContent: "Nothing yet. What the bot does shows up here as it goes." }));
    return;
  }
  for (const e of events.slice(-60).reverse()) {
    const t = el("span", { className: "t", textContent: clock(new Date(e.ts)) });
    if (e.kind === "search") {
      const where = `Searched “${e.label}”${e.n > 1 ? `, page ${e.n}` : ""}: ${e.listed} jobs, ${e.fresh} new and matching.`;
      list.append(el("li", { className: "search" }, t, el("span", { className: "what", textContent: where })));
      continue;
    }
    const what = el("span", { className: "what" },
      el("b", { textContent: e.title || "Untitled job" }), e.company ? el("span", { textContent: ` at ${e.company}` }) : null,
      el("small", { textContent: describe(e.status, e.note) }));
    const open = /^https?:\/\//.test(e.url || "") ? el("a", { className: "open", href: e.url, target: "_blank", rel: "noopener", textContent: "Open" }) : el("span");
    list.append(el("li", {}, t, glyph(e.status), what, open));
  }
}

function lineClass(line) {
  if (/^\s+\+ /.test(line)) return "l-ok";
  if (/^\s+! /.test(line)) return "l-wait";
  if (/^\s+x /.test(line) || /^(Error|Interrupted)\b/.test(line)) return "l-bad";
  if (/^\s+[-=] /.test(line)) return "l-skip";
  if (/^\s+> /.test(line)) return "l-ext";
  if (/^\s+~ /.test(line)) return "l-would";
  if (/^https?:\/\//.test(line)) return "l-url";
  if (/^(Done|Daily limit|Logged in|Stopped|Not logged in|Still not logged in|Nothing to search|Browser window)/.test(line)) return "l-done";
  return "";
}

function renderLog() {
  const log = runs[site]?.log || [];
  const key = `${runs[site]?.id}:${log.length}:${log[log.length - 1] || ""}`;
  if (key === ui.logKey) return;
  ui.logKey = key;
  const pre = panel().querySelector(".log");
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.replaceChildren();
  if (!log.length) {
    pre.append(el("span", { className: "empty", textContent: "No run yet." }));
    return;
  }
  for (const line of log.slice(-2000)) pre.append(el("span", { className: lineClass(line), textContent: line.replace(/(\S) {3,}/g, "$1  ") }));
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function siteState(name) {
  const run = runs[name];
  return !run?.running ? "idle" : run.prompt ? "waiting" : "running";
}

function renderSites() {
  const label = { idle: "Idle", running: "Running", waiting: "Needs you" };
  $("site-list").replaceChildren(...Object.entries(SITES).map(([name, info]) => {
    const dot = el("span", { className: "dot" });
    dot.dataset.state = siteState(name);
    const link = el("a", { href: `#overview/${name}` }, dot, info.name, el("span", { className: "site-state", textContent: label[siteState(name)] }));
    if (name === site) link.setAttribute("aria-current", "true");
    return el("li", {}, link);
  }));
}

function renderTitle() {
  const states = Object.keys(SITES).map(siteState);
  document.title = states.includes("waiting") ? "Needs you – Sendoff" : states.includes("running") ? "Running – Sendoff" : "Sendoff";
}

// ---------------------------------------------------------------- the rail: today, last 14 days, needs you, totals

function counts() {
  const rows = Object.values(jobs).filter(r => r.site === site);
  const by = {};
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
  return { rows, by };
}

function renderRail() {
  const { rows, by } = counts();
  const limits = settings?.sites[site]?.limits;
  const n = rows.filter(r => r.status === "applied" && String(r.ts).startsWith(today())).length;
  const max = limits?.maxPerDay || 0;
  $("today-n").textContent = n;
  $("today-of").textContent = max ? `of ${max} today` : "applied today";
  const meter = $("meter");
  meter.firstElementChild.style.width = `${max ? Math.min(100, (n / max) * 100) : 0}%`;
  meter.setAttribute("aria-valuenow", n);
  meter.setAttribute("aria-valuemax", max);
  $("today-note").textContent = !max ? "" : n >= max ? "Daily limit reached. It starts again tomorrow."
    : `${max - n} more allowed today; each run stops after ${limits.maxPerRun}.`;
  panel().querySelector('.opts [name="max"]').placeholder = limits?.maxPerRun ?? "";

  renderTrend(rows);

  const needs = rows.filter(r => r.status === "needs_manual").sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const list = $("needs-list");
  list.replaceChildren();
  if (!needs.length) list.append(el("li", { className: "none", textContent: "Nothing. Jobs it couldn't finish show up here." }));
  for (const r of needs.slice(0, 5)) {
    const link = el("a", { href: r.url, target: "_blank", rel: "noopener", textContent: r.title || "Untitled job" });
    list.append(el("li", {}, link, el("small", { textContent: [r.company, describe(r.status, r.note)].filter(Boolean).join(". ") })));
  }
  if (needs.length > 5) {
    list.append(el("li", {}, el("a", { className: "all", href: "#history", textContent: `All ${needs.length} in History`, onclick: () => setFilter("needs_manual") })));
  }
  const badge = $("nav-needs");
  badge.hidden = !needs.length;
  badge.textContent = needs.length;
  badge.title = `${needs.length} need you`;

  $("totals").replaceChildren(...["applied", "needs_manual", "external", "skipped", "failed"].flatMap(s => [
    el("dt", {}, glyph(s), STATUS[s]), el("dd", { textContent: (by[s] || 0).toLocaleString() }),
  ]));
}

/** Applications per day for the last 14 days: thin columns, today in the accent, the rest a lighter step. */
function renderTrend(rows) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const p = x => String(x).padStart(2, "0");
    days.push({ date: d, key: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, n: 0 });
  }
  const index = Object.fromEntries(days.map((d, i) => [d.key, i]));
  for (const r of rows) {
    const i = index[String(r.ts).slice(0, 10)];
    if (r.status === "applied" && i != null) days[i].n++;
  }
  const most = Math.max(...days.map(d => d.n));
  const top = most <= 4 ? 4 : most <= 10 ? 10 : Math.ceil(most / 10) * 10; // even, so the middle tick is whole
  const W = 300;
  const L = 24;
  const T = 14;
  const B = 104;
  const band = (W - L) / days.length;
  const colW = Math.min(14, band * 0.62);
  const y = v => B - (v / top) * (B - T);
  const label = d => d.date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

  const chart = svg("svg", { viewBox: `0 0 ${W} 124`, role: "img", "aria-label": `Applications per day: ${days.map(d => `${label(d)} ${d.n}`).join(", ")}` });
  const grid = svg("g", { class: "grid" });
  for (const v of [0, top / 2, top]) {
    grid.append(svg("line", { x1: L, x2: W, y1: y(v), y2: y(v) }));
    const t = svg("text", { x: 0, y: y(v) + 4, class: "axis" });
    t.textContent = v;
    grid.append(t);
  }
  chart.append(grid);
  days.forEach((d, i) => {
    const x = L + i * band + (band - colW) / 2;
    const h = B - y(d.n);
    const isToday = i === days.length - 1;
    const hit = svg("rect", { x: L + i * band, y: T - 10, width: band, height: B - T + 10, class: "hit", tabindex: 0 });
    hit.setAttribute("aria-label", `${label(d)}: ${d.n} applied`);
    tipOn(hit, `${d.n} applied`, label(d));
    chart.append(hit);
    if (d.n > 0) {
      const r = Math.min(4, h, colW / 2); // rounded data end, square at the baseline
      const path = `M${x},${B} V${B - h + r} Q${x},${B - h} ${x + r},${B - h} H${x + colW - r} Q${x + colW},${B - h} ${x + colW},${B - h + r} V${B} Z`;
      chart.append(svg("path", { d: path, class: `col${isToday ? " today" : ""}` }));
    }
    if ((isToday || (d.n === most && most > 0)) && d.n > 0) {
      const v = svg("text", { x: x + colW / 2, y: B - h - 4, "text-anchor": "middle", class: "value" });
      v.textContent = d.n;
      chart.append(v);
    }
  });
  const first = svg("text", { x: L, y: 120, class: "axis" });
  first.textContent = days[0].date.toLocaleDateString([], { day: "numeric", month: "short" });
  const last = svg("text", { x: W, y: 120, "text-anchor": "end", class: "axis" });
  last.textContent = "Today";
  chart.append(first, last);
  $("trend-chart").replaceChildren(chart);

  $("trend-table").querySelector("tbody").replaceChildren(...days.slice().reverse().map(d => el("tr", {}, el("td", { textContent: label(d) }), el("td", { textContent: d.n }))));
}

function buildRail() {
  const toggle = $("trend-table-toggle");
  toggle.onclick = () => {
    const on = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", on);
    toggle.textContent = on ? "Chart" : "Table";
    $("trend-table").hidden = !on;
    $("trend-chart").hidden = on;
  };
}

// ---------------------------------------------------------------- history

function setFilter(status) {
  filter.status = status;
  for (const chip of document.querySelectorAll(".chip")) chip.setAttribute("aria-pressed", chip.dataset.status === status);
  renderHistory();
}

function buildHistory() {
  for (const [status, text] of CHIPS) {
    const chip = el("button", { className: "chip", onclick: () => setFilter(status) }, text, el("span", { className: "n" }));
    chip.dataset.status = status;
    chip.setAttribute("aria-pressed", status === filter.status);
    $("chips").append(chip);
  }
  $("history-search").addEventListener("input", e => { filter.text = e.target.value.trim().toLowerCase(); renderHistory(); });
  const pick = $("history-site");
  for (const [name, info] of Object.entries(SITES)) pick.add(new Option(info.name, name));
  pick.onchange = () => { filter.site = pick.value; renderHistory(); };
  $("recheck").onclick = recheckSkipped;
}

async function showShot(r) {
  const image = await JB.store.shot(r.site, r.jobId);
  if (!image) return;
  const dialog = $("shot-dialog");
  dialog.querySelector("img").src = image;
  dialog.showModal();
}

function renderHistory() {
  const all = Object.values(jobs).filter(r => !filter.site || r.site === filter.site).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  for (const chip of document.querySelectorAll(".chip")) {
    chip.querySelector(".n").textContent = chip.dataset.status ? all.filter(r => r.status === chip.dataset.status).length : all.length;
  }
  let rows = filter.status ? all.filter(r => r.status === filter.status) : all;
  if (filter.text) rows = rows.filter(r => `${r.title} ${r.company}`.toLowerCase().includes(filter.text));
  const body = $("history-rows");
  body.replaceChildren();
  if (!rows.length) {
    const text = filter.text ? "No jobs match that." : filter.status === "applied" ? "No applications yet. Click Apply on the overview to start." : "Nothing here.";
    body.append(el("tr", { className: "empty-row" }, el("td", { colSpan: 4, textContent: text })));
  }
  for (const r of rows.slice(0, HISTORY_LIMIT)) {
    const link = el("a", { target: "_blank", rel: "noopener", textContent: r.title || "Untitled job" });
    if (/^https?:\/\//.test(r.url || "")) link.href = r.url;
    const note = el("td", { className: "note" }, r.note ? describe(r.status, r.note) : "");
    if (r.shot) note.append(r.note ? " " : "", el("button", { textContent: "Screenshot", onclick: () => showShot(r) }));
    body.append(el("tr", {},
      el("td", { className: "when", textContent: when(r.ts) }),
      el("td", { className: "job" }, link, el("span", { textContent: Object.keys(SITES).length > 1 ? [r.company, SITES[r.site]?.name || r.site].filter(Boolean).join(", ") : r.company || "" })),
      el("td", { className: "result" }, el("span", { className: "result-tag" }, glyph(r.status), STATUS[r.status] || r.status)),
      note,
    ));
  }
  const more = $("history-more");
  more.hidden = rows.length <= HISTORY_LIMIT;
  more.textContent = `Showing the latest ${HISTORY_LIMIT} of ${rows.length}.`;
}

async function recheckSkipped() {
  const n = Object.values(jobs).filter(r => r.status === "skipped").length;
  if (!n) return;
  if (!confirm(`Forget the ${n} jobs the filters skipped, so the next run looks at them again?`)) return;
  for (const site of Object.keys(SITES)) await send({ type: "forget", site, status: "skipped" });
}

// ---------------------------------------------------------------- settings

const form = $("settings-form");
const LIST_FIELDS = new Set([
  "profile.filters.includeTitle", "profile.filters.requireRole", "profile.filters.excludeTitle",
  "profile.filters.excludeCompanies", "profile.filters.excludeText",
  ...Object.entries(SITES).flatMap(([name, info]) => [
    `sites.${name}.keywords`, `sites.${name}.searchUrls`, ...(info.locations ? [`sites.${name}.locations`] : []),
  ]),
]);

/** One site's search and limits fields. */
function sitePanel(name, info) {
  const base = `sites.${name}`;
  const field = (cls, label, hint, control) => el("label", { className: cls }, label, hint ? el("small", { textContent: hint }) : null, control);
  const area = (path, rows) => el("textarea", { name: path, rows, spellcheck: false });
  const num = (path, min) => el("input", { type: "number", name: path, min, step: 1 });
  const depth = JB.sites[name].paged
    ? field("field narrow", "Pages per search", info.pages, num(`${base}.limits.maxPages`, 1))
    : field("field narrow", "Scrolls per search", "Each loads more results", num(`${base}.limits.maxScrolls`, 0));
  const box = el("div", { className: "site-panel", id: `site-panel-${name}`, role: "tabpanel" },
    el("div", { className: "two" },
      field("field", "Search keywords", info.keywords, area(`${base}.keywords`, 12)),
      field("field", "Extra search pages", `Optional. Whole ${info.name} search addresses, one per line.`, area(`${base}.searchUrls`, 12))),
    info.locations ? field("field", "Places", "One per line: a country or city, like india, or remote.", area(`${base}.locations`, 3)) : null,
    el("h3", { textContent: "How many" }),
    el("div", { className: "row-fields" },
      field("field narrow", "Per run", null, num(`${base}.limits.maxPerRun`, 1)),
      field("field narrow", "Per day", null, num(`${base}.limits.maxPerDay`, 1)),
      depth),
    el("div", { className: "row-fields" },
      field("field narrow", "Pause, at least", "seconds", num(`${base}.limits.delaySeconds.0`, 0)),
      field("field narrow", "Pause, at most", "seconds", num(`${base}.limits.delaySeconds.1`, 0))),
    el("p", { className: "hint", textContent: "After each application the bot waits a random time in this range, like a person would." }));
  box.setAttribute("aria-labelledby", `site-tab-${name}`);
  return box;
}

function showSiteSettings(name) {
  for (const tab of $("site-tabs").children) tab.setAttribute("aria-selected", tab.dataset.site === name);
  for (const box of $("site-panels").children) box.hidden = box.id !== `site-panel-${name}`;
}

function buildSiteSettings() {
  for (const [name, info] of Object.entries(SITES)) {
    const tab = el("button", { type: "button", id: `site-tab-${name}`, textContent: info.name, onclick: () => showSiteSettings(name) });
    tab.setAttribute("role", "tab");
    tab.dataset.site = name;
    $("site-tabs").append(tab);
    $("site-panels").append(sitePanel(name, info));
  }
  showSiteSettings(site);
}

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = o[k] ?? (o[k] = {});
  o[last] = value;
}

function answerRow(pattern = "", answerText = "") {
  const input = (key, value, label) => {
    const box = el("input", { value, spellcheck: false });
    box.dataset.key = key;
    box.setAttribute("aria-label", label);
    return box;
  };
  const tr = el("tr");
  const move = dir => () => {
    const to = dir < 0 ? tr.previousElementSibling : tr.nextElementSibling?.nextElementSibling;
    if (dir < 0 && !to) return;
    tr.parentElement.insertBefore(tr, to || null);
    dirty();
  };
  tr.append(
    el("td", {}, input("pattern", pattern, "When the question matches")),
    el("td", {}, input("answer", answerText, "Answer")),
    el("td", {},
      el("button", { type: "button", className: "btn icon", textContent: "↑", title: "Move up: checked earlier", onclick: move(-1) }), " ",
      el("button", { type: "button", className: "btn icon", textContent: "↓", title: "Move down", onclick: move(1) }), " ",
      el("button", { type: "button", className: "btn icon", textContent: "✕", title: "Remove", onclick: () => { tr.remove(); dirty(); } }),
    ),
  );
  return tr;
}

function fillForm(s) {
  for (const input of form.querySelectorAll("[name]")) {
    const value = getPath(s, input.name);
    input.value = LIST_FIELDS.has(input.name) ? (value || []).join("\n") : value ?? "";
    input.removeAttribute("aria-invalid");
  }
  $("answer-rows").replaceChildren(...s.profile.answers.map(([p, a]) => answerRow(p, a)));
  setDirty(false);
  $("errors").textContent = "";
}

function readForm() {
  const s = structuredClone(settings);
  for (const input of form.querySelectorAll("[name]")) {
    let value;
    if (LIST_FIELDS.has(input.name)) value = input.value.split("\n").map(l => l.trim()).filter(Boolean);
    else if (input.type === "number") value = input.value.trim() === "" ? null : Number(input.value);
    else value = input.value;
    setPath(s, input.name, value);
  }
  s.profile.answers = [...document.querySelectorAll("#answer-rows tr")]
    .map(tr => [tr.querySelector('[data-key="pattern"]').value.trim(), tr.querySelector('[data-key="answer"]').value.trim()])
    .filter(([p, a]) => p || a);
  return s;
}

function check(s) {
  const errors = [];
  const bad = name => form.querySelector(`[name="${name}"]`)?.setAttribute("aria-invalid", "true");
  const whole = (name, min) => {
    const v = getPath(s, name);
    if (v == null || !Number.isInteger(v) || v < min) {
      bad(name);
      return false;
    }
    return true;
  };
  for (const input of document.querySelectorAll("#settings-form [aria-invalid]")) input.removeAttribute("aria-invalid");

  const exp = ["profile.minExperience", "profile.maxExperience"];
  for (const name of exp) {
    const v = getPath(s, name);
    if (v != null && (!Number.isInteger(v) || v < 0)) { bad(name); errors.push("Experience is whole years."); }
  }
  if (s.profile.minExperience != null && s.profile.maxExperience != null && s.profile.minExperience > s.profile.maxExperience) {
    exp.forEach(bad);
    errors.push("Your experience: From is more than To.");
  }
  const most = s.profile.filters.maxExperienceRequired;
  if (most != null && !(most >= 0)) { bad("profile.filters.maxExperienceRequired"); errors.push("Most experience a job may ask for can't be negative."); }

  for (const [name, info] of Object.entries(SITES)) {
    const base = `sites.${name}.limits`;
    const depth = JB.sites[name].paged ? whole(`${base}.maxPages`, 1) : whole(`${base}.maxScrolls`, 0);
    if (![whole(`${base}.maxPerRun`, 1), whole(`${base}.maxPerDay`, 1), depth].every(Boolean)) {
      errors.push(`${info.name}: per run and per day are whole numbers, at least 1; so is how far to go through results.`);
    }
    const [lo, hi] = s.sites[name].limits.delaySeconds;
    if (![lo, hi].every(v => v != null && v >= 0) || lo > hi) {
      bad(`${base}.delaySeconds.0`);
      bad(`${base}.delaySeconds.1`);
      errors.push(`${info.name}: the pause is two numbers of seconds, the first not more than the second.`);
    }
    if (s.sites[name].searchUrls.some(u => !JB.sites[name].searchHost.test(u))) {
      bad(`sites.${name}.searchUrls`);
      errors.push(`${info.name}: extra search pages must be ${info.name} pages, starting ${JB.sites[name].loginUrl}`);
    }
  }
  const firstBad = $("site-panels").querySelector('[aria-invalid="true"]');
  if (firstBad) showSiteSettings(firstBad.closest(".site-panel").id.replace("site-panel-", ""));

  let broken = 0;
  for (const tr of document.querySelectorAll("#answer-rows tr")) {
    const input = tr.querySelector('[data-key="pattern"]');
    const used = input.value.trim() || tr.querySelector('[data-key="answer"]').value.trim();
    if (used && JB.answers.badPatterns([[input.value.trim(), ""]]).length) {
      input.setAttribute("aria-invalid", "true");
      broken++;
    }
  }
  if (broken) errors.push(`${broken} answer pattern${broken > 1 ? "s aren't" : " isn't"} a valid regular expression (marked in red).`);
  return errors;
}

function setDirty(on) {
  $("savebar").classList.toggle("dirty", on);
  if (on) $("saved").textContent = "Unsaved changes.";
}
const dirty = () => setDirty(true);

async function save(e) {
  e.preventDefault();
  const s = readForm();
  const errors = check(s);
  $("errors").textContent = errors.join("\n");
  if (errors.length) {
    $("saved").textContent = "";
    return;
  }
  await JB.store.saveSettings(s);
  setDirty(false);
  $("saved").textContent = "Saved. The next run uses these.";
}

function buildSettings() {
  buildSiteSettings();
  form.addEventListener("input", dirty);
  form.addEventListener("submit", save);
  $("discard").onclick = () => fillForm(settings);
  $("add-answer").onclick = () => {
    const row = answerRow();
    $("answer-rows").append(row);
    row.querySelector("input").focus();
    dirty();
  };
  $("import-file").onchange = importFile;
  $("export").onclick = exportBackup;
  window.addEventListener("beforeunload", e => {
    if ($("savebar").classList.contains("dirty")) e.preventDefault();
  });
}

// ---------------------------------------------------------------- screenshots

const ALL_SITES = { origins: ["<all_urls>"] };

async function renderShots() {
  const on = await chrome.permissions.contains(ALL_SITES);
  const button = $("shots");
  button.dataset.on = on ? "1" : "";
  button.textContent = on ? "Turn screenshots off" : "Allow screenshots";
  $("shots-status").textContent = on ? "On: each job that needs you gets a screenshot." : "Off: the history still lists the questions it couldn't answer.";
}

function buildShots() {
  const button = $("shots");
  button.onclick = async () => {
    // request() has to come straight from the click, before anything else is awaited
    if (button.dataset.on) await chrome.permissions.remove(ALL_SITES);
    else await chrome.permissions.request(ALL_SITES);
    renderShots();
  };
  chrome.permissions.onAdded.addListener(renderShots);
  chrome.permissions.onRemoved.addListener(renderShots);
  renderShots();
}

// ---------------------------------------------------------------- bring over, back up

async function importFile(e) {
  const status = $("import-status");
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  status.classList.remove("err");
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.format !== FORMAT || !data.settings || !Array.isArray(data.history)) throw new Error();
  } catch {
    status.classList.add("err");
    status.textContent = "That isn't a file from export_for_extension.py or a backup from here.";
    return;
  }
  if (!confirm(`Replace your settings with the ones in ${file.name}, and add its ${data.history.length} past jobs to the history?`)) return;
  try {
    const { added } = await send({ type: "import", settings: data.settings, history: data.history, cache: data.cache });
    status.textContent = `Done: settings replaced, ${added} past jobs added${added < data.history.length ? ` (${data.history.length - added} were already here)` : ""}.`;
  } catch (err) {
    status.classList.add("err");
    status.textContent = err.message;
  }
}

function exportBackup() {
  const history = Object.values(jobs).map(({ shot, ...r }) => r);
  const data = { format: FORMAT, exported: new Date().toISOString(), settings, history };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  el("a", { href: url, download: `sendoff-backup-${today()}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------- start

async function init() {
  buildRunPanel();
  buildRail();
  buildHistory();
  buildSettings();
  buildShots();
  for (const link of document.querySelectorAll("[data-goto]")) {
    link.addEventListener("click", e => { e.preventDefault(); goto(link.dataset.goto); });
  }
  window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));
  selectSite(site);
  showPage(location.hash.slice(1));

  settings = await JB.store.getSettings();
  jobs = await JB.store.jobs();
  for (const [k, run] of Object.entries(await chrome.storage.session.get(null))) {
    if (k.startsWith("run:") && SITES[k.slice(4)]) runs[k.slice(4)] = run;
  }
  fillForm(settings);
  $("first-run").hidden = !!settings.savedAt;
  renderRun();
  renderRail();
  renderHistory();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session") {
      for (const [k, { newValue }] of Object.entries(changes)) {
        if (!k.startsWith("run:") || !SITES[k.slice(4)]) continue;
        runs[k.slice(4)] = newValue || null;
        if (newValue?.running) ui.error[k.slice(4)] = "";
      }
      renderRun();
    } else if (area === "local") {
      if (changes.jobs) {
        jobs = changes.jobs.newValue || {};
        renderRail();
        renderHistory();
      }
      if (changes.settings) {
        settings = JB.store.normalize(changes.settings.newValue);
        if (!$("savebar").classList.contains("dirty")) fillForm(settings);
        $("first-run").hidden = !!settings.savedAt;
        renderRail();
      }
    }
  });
  setInterval(renderRail, 60000); // "today" moves on at midnight
}

init();
