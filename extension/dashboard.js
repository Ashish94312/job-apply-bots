// The dashboard: start and watch runs, answer the bot's questions, follow your applications, see the history, edit the
// settings.
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
  linkedin: {
    name: "LinkedIn", keywords: "What you'd type in LinkedIn's job search, one per line, like machine learning engineer.",
    pages: "25 jobs each", locations: true, linkedin: true,
  },
  naukri: {
    name: "Naukri", keywords: "What you'd type in Naukri's job search, one per line, like machine learning engineer.",
    pages: "20 jobs each", locations: true, places: "Cities, one per line, like bengaluru. Empty: anywhere.", naukri: true,
  },
  company: { name: "Company sites", list: true }, // Greenhouse, Lever and Ashby forms (sites/company.js)
};
const LINKEDIN_LEVELS = [["internship", "Internship"], ["entry level", "Entry level"], ["associate", "Associate"],
  ["mid-senior level", "Mid-senior level"], ["director", "Director"], ["executive", "Executive"]];
const LINKEDIN_WORK = [["on-site", "On-site"], ["remote", "Remote"], ["hybrid", "Hybrid"]];
const POSTED_WITHIN = [["", "Any time"], ["day", "Past day"], ["week", "Past week"], ["month", "Past month"]];
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
const CONTACT = { messaged: "Asked", invited: "Invite sent", not_accepted: "Didn't accept", failed: "Failed" };
const CHIPS = [["applied", "Applied"], ["needs_manual", "Needs you"], ["external", "Other site"], ["skipped", "Skipped"], ["failed", "Failed"], ["", "All"]];
const FORMAT = "job-apply-bots/1";
const HISTORY_LIMIT = 300;

const runs = {}; // site -> its latest run, as the background worker saved it
const ui = { stopping: {}, error: {}, logKey: "", stripKey: "", eventsKey: "", panelKey: "", day: "" };
const filter = { status: "applied", text: "", site: "" };
let settings = null; // as last saved
let jobs = {};
let people = {}; // everyone asked for a referral (LinkedIn), by profile
let track = {}; // what you've noted about each application (lib/tracker.js), by key
let kept = {}; // answers you gave when the bot asked, by question key (lib/store.js learn)
let waiting = {}; // questions jobs were left for you over, not answered yet

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
  name = ["overview", "applications", "history", "settings"].includes(page) ? page : "overview";
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
    await send({ type: "start", site, action, opts: options() });
  } catch (e) {
    ui.error[site] = e.message;
    if (/^Unknown site/.test(e.message)) $("outdated").hidden = false; // an old background part from before this site
  }
  renderRun();
}

/** After the files change (an unpacked extension being updated), Chrome keeps running the old background part
 * until the extension is reloaded; offer that, rather than let runs fail with "Unknown site". */
async function checkWorker() {
  let sites = [];
  try {
    sites = (await send({ type: "hello" })).sites || [];
  } catch {
    sites = []; // one from before it could answer this
  }
  $("outdated").hidden = Object.keys(SITES).every(s => sites.includes(s));
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
  panel().querySelector('[data-act="login"]').hidden = !!SITES[name].list; // company forms need no login
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
  const busy = { apply: "Applying…", "dry-run": "Checking…", login: "Logging in…", refer: "Asking…", "refer-dry-run": "Previewing…" };
  apply.textContent = !running ? "Apply" : busy[run.action] || "Working…";
  apply.classList.toggle("busy", running);
  for (const b of p.querySelectorAll('[data-act="apply"], [data-act="dry-run"], [data-act="login"], [data-act^="refer"]')) b.disabled = running;
  p.querySelector('[data-act="stop"]').hidden = !running;

  let [text, isError] = ["", false];
  if (ui.error[site]) [text, isError] = [ui.error[site], true];
  else if (ui.stopping[site] && running) text = "Stopping after this step, then closing its window…";
  else if (running && run.prompt) text = "Waiting for you.";
  else if (running && run.action === "dry-run") text = "Going through jobs without applying, in its own window.";
  else if (running && run.action === "login") text = "Waiting for you to log in, in its own window.";
  else if (running && run.action === "refer") text = "Asking for referrals in its own Chrome window. Leave that window open.";
  else if (running && run.action === "refer-dry-run") text = "Finding who it would ask, without sending anything, in its own window.";
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
  renderReferBox();
}

/** LinkedIn's referral box on the overview: what it would do, and how it's gone so far. */
function renderReferBox() {
  const box = $("refer-box");
  box.hidden = !JB.sites[site].refers;
  if (box.hidden || !settings) return;
  const rc = settings.sites[site].referral || {};
  const all = Object.values(people);
  const asked = all.filter(c => c.status === "messaged").length;
  const waiting = all.filter(c => c.status === "invited").length;
  const plan = `It asks up to ${rc.perCompany ?? 2} people per company you applied to in the last ${rc.withinDays ?? 14} days`
    + (rc.sendMode === "direct" ? ", sending without asking you." : ", showing you each message first.");
  const sofar = all.length ? ` So far: ${asked} asked, ${waiting} invite${waiting === 1 ? "" : "s"} waiting to be accepted.` : "";
  const ready = !(rc.message || "").trim() ? " Write your referral message in Settings first."
    : /<[^<>\n]+>/.test(rc.message) ? " Your message still has a <…> part to write in Settings; Preview works meanwhile." : "";
  $("refer-summary").textContent = plan + sofar + ready;
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
  const fields = (p.fields || []).map(field => [field, answerBox(field, field.answer || "")]); // an answer it read, to keep or change
  box.querySelector(".prompt-fields").replaceChildren(...fields.map(([field, control]) =>
    el("div", { className: "prompt-field" }, el("span", { textContent: shownQuestion(field.q, field.options) }), control)));
  const err = box.querySelector(".prompt-err");
  err.textContent = "";
  const reply = value => {
    if (value !== "save") return answer(p.id, value);
    const answers = fields.map(([field, control]) => ({ ...field, answer: control.read() }));
    if (answers.some(a => !a.answer)) {
      err.textContent = "Answer each one, or pick another way below.";
      return;
    }
    answer(p.id, { answers });
  };
  box.querySelector(".prompt-answers").replaceChildren(
    ...p.choices.map(([label, value, kind]) => el("button", { className: `btn ${kind || ""}`, textContent: label, onclick: () => reply(value) })),
  );
}

function renderStrip() {
  const run = runs[site];
  const page = run?.page;
  const key = JSON.stringify([run?.id, run?.running, page?.cells?.map(c => c.state)]);
  $("now").textContent = run?.running ? run.now || "" : "";
  if (key === ui.stripKey) return;
  ui.stripKey = key;
  $("run-title").textContent = SITES[site].list ? "Jobs to apply to" : page && !run.running ? "Last page of results" : "Current page of results";
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
    if (e.kind === "contact") {
      const what = {
        messaged: `Asked for a referral${e.title ? ` for ${e.title}` : ""}`, invited: `Invited to connect, ${e.note || ""}`.replace(/, $/, ""),
        would_message: "Would message them (preview)", would_invite: "Would invite them to connect (preview)", failed: `Couldn't reach them: ${e.note || "?"}`,
      }[e.status] || e.status;
      const link = /^https?:\/\//.test(e.url || "") ? el("a", { className: "open", href: e.url, target: "_blank", rel: "noopener", textContent: "Profile" }) : el("span");
      list.append(el("li", {}, t, glyph(e.status),
        el("span", { className: "what" }, el("b", { textContent: e.name }), e.company ? el("span", { textContent: ` at ${e.company}` }) : null, el("small", { textContent: what })),
        link));
      continue;
    }
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
  const asks = Object.keys(waiting).length;
  if (asks) {
    list.append(el("li", {}, el("a", {
      className: "all", href: "#settings", textContent: `Answer the ${asks} question${asks > 1 ? "s" : ""} it got stuck on`,
      onclick: e => { e.preventDefault(); goto("your-answers"); },
    })));
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
    if (r.status === "needs_manual" && Object.values(waiting).some(w => w.jobs.includes(`${r.site}:${r.jobId}`))) {
      note.append(" ", el("button", { textContent: "Answer its questions", onclick: () => goto("your-answers") }));
    }
    if (["needs_manual", "external"].includes(r.status)) {
      note.append(note.textContent ? " " : "", el("button", { textContent: "I applied myself", title: "Count it as applied, and follow it in Applications", onclick: () => selfApplied(r) }));
    }
    const tracked = track[`${r.site}:${r.jobId}`];
    if (r.status === "applied" && tracked && !tracked.hidden) {
      note.append(note.textContent ? " " : "", el("button", { textContent: "In Applications", onclick: () => openApp(tracked.key) }));
    }
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
  renderReferrals();
}

function renderReferrals() {
  const all = Object.values(people).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  $("referrals").hidden = !all.length || (filter.site && filter.site !== "linkedin");
  const link = (href, text) => {
    const a = el("a", { target: "_blank", rel: "noopener", textContent: text });
    if (/^https?:\/\//.test(href || "")) a.href = href;
    return a;
  };
  $("referral-rows").replaceChildren(...all.slice(0, HISTORY_LIMIT).map(c => el("tr", {},
    el("td", { className: "when", textContent: when(c.updated) }),
    el("td", { className: "job" }, link(c.profile, c.name || "?"), el("span", { textContent: c.headline || "" })),
    el("td", { className: "job" }, link(c.jobUrl, c.title || "Job"), el("span", { textContent: c.company || "" })),
    el("td", { className: "result" }, el("span", { className: "result-tag" }, glyph(c.status), CONTACT[c.status] || c.status)),
    el("td", { className: "note", textContent: c.status === "invited" ? "Gets your message once they accept" : c.note || "" }),
  )));
}

async function recheckSkipped() {
  const n = Object.values(jobs).filter(r => r.status === "skipped").length;
  if (!n) return;
  if (!confirm(`Forget the ${n} jobs the filters skipped, so the next run looks at them again?`)) return;
  for (const site of Object.keys(SITES)) await send({ type: "forget", site, status: "skipped" });
}

// ---------------------------------------------------------------- applications: what happened after applying

const T = JB.tracker;
const APP_CHIPS = [["active", "Active"], ["waiting", "Waiting"], ["quiet", "Gone quiet"], ["closed", "Closed"], ["", "All"]];
const GROUP_RANK = { active: 0, waiting: 1, quiet: 2, closed: 3 };
const appFilter = { group: remember("apps.group"), text: "", site: "" };
let openKey = ""; // the application open in the side panel
let pendingFocus = ""; // what to focus once the panel shows a change (a round just added)

const quietDays = () => settings?.tracker.quietDays ?? T.DEFAULTS.quietDays;
const allApps = () => T.list(jobs, track);
const appOf = key => allApps().find(a => a.key === key);
const siteName = a => (a.site === "manual" ? a.through || "Added by you" : SITES[a.site]?.name || a.site);
const dateWords = ts => T.toDate(ts)?.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) || "";
const ago = days => (days == null ? "" : days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`);
const roundName = r => r.name || T.word(T.KINDS, r.kind);
const roundNote = (r, n) => `Round ${n}${r.name ? ` (${r.name})` : ""}: ${T.roundWord(r).toLowerCase()}`;

/** "Today", "Tomorrow", or "Mon 26 Oct". */
function day(d) {
  const n = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** Jobs Sendoff asked someone about for a referral, as application keys. */
const askedKeys = () => new Set(Object.values(people).filter(c => ["messaged", "invited"].includes(c.status)).map(c => `linkedin:${c.jobId}`));

/** Change applications: [application, change, timeline note] each (see JB.tracker.change). */
async function changeApps(list) {
  const items = list.map(([a, change, note]) => {
    const { key, site, jobId, title, company, url, appliedAt, source, old, through } = a;
    return { key, base: { site, jobId, title, company, url, appliedAt, source, old, through }, change, note };
  });
  const { apps } = await send({ type: "track", items });
  track = { ...track };
  items.forEach((item, i) => {
    if (apps[i]) track[item.key] = apps[i];
    else delete track[item.key];
  });
  renderApps();
}
const changeApp = (a, change, note) => changeApps([[a, change, note]]);

const glyphOf = (cls, text) => el("span", { className: `glyph ${cls}`, textContent: text, ariaHidden: "true" });
const button = (text, onclick, cls = "btn small") => el("button", { type: "button", className: cls, textContent: text, onclick });

/** An application's stage as it shows: [glyph class, glyph text, what, under it]. */
function stageView(a) {
  const st = T.stage(a, quietDays());
  const days = T.daysSince(a.appliedAt);
  const given = a.rounds.filter(r => r.status !== "planned").length;
  const after = given ? `After ${given} round${given > 1 ? "s" : ""}` : a.heard ? "After they replied" : "After applying";
  if (st === "waiting") return ["a-waiting", "·", "Waiting", `Applied ${ago(days)}`];
  if (st === "quiet") return ["a-quiet", "–", "Gone quiet", `No reply in ${days} days`];
  if (st === "heard") return ["a-heard", "↩", "Heard back", "No rounds yet"];
  if (st === "rounds") {
    const r = T.current(a);
    const n = a.rounds.indexOf(r) + 1;
    const how = r.status === "planned" ? "no date yet" : T.roundWord(r).toLowerCase();
    if (r.kind === "assignment") return [r.status === "scheduled" ? "a-due" : "a-rounds", r.status === "scheduled" ? "!" : String(n), `Assignment, ${how}`, `Round ${n}${r.name ? `: ${r.name}` : ""}`];
    return ["a-rounds", String(n), `Round ${n}, ${how}`, roundName(r)];
  }
  if (st === "rejected") return ["a-rejected", "×", "Rejected", after];
  if (T.gotOffer(a)) return ["a-offer", "✓", T.word(T.OUTCOMES, st), after];
  return ["a-closed", "–", T.word(T.OUTCOMES, st), after];
}

/** What's next for an application, as it shows: [what, under it], or null. */
function nextView(a) {
  const nx = T.next(a, quietDays());
  if (!nx) return null;
  const r = nx.round;
  if (nx.type === "round") return nx.at ? [`${day(nx.at)}${r.at.length > 10 ? `, ${clock(nx.at)}` : ""}`, roundName(r)] : ["Set the time", roundName(r)];
  if (nx.type === "due") return [nx.at ? `Due ${day(nx.at)}` : "To do", roundName(r)];
  if (nx.type === "plan") return ["Set a date", roundName(r)];
  if (nx.type === "result") return ["Waiting for their result", nx.days > 0 ? `${roundName(r)}, given ${ago(nx.days)}` : roundName(r)];
  if (nx.type === "more") return ["Add the next round", "or how it ended"];
  if (nx.type === "end") return ["Say how it ended", `${roundName(r)}: ${T.roundWord(r).toLowerCase()}`];
  if (nx.type === "setup") return ["Add its rounds", "From a template, or one by one"];
  return ["Answer the offer", ""];
}

/** They replied: note it as an email today, and open it to say who and how. */
async function replied(a) {
  await changeApp(a, { heard: { at: today(), via: "email", who: "" } }, "They replied");
  openApp(a.key);
}

/** The one-click buttons for a round: booked, it was given (or handed in); given, how it went. */
function roundActions(a, r) {
  const n = a.rounds.indexOf(r) + 1;
  const set = status => () => changeApp(a, { round: { id: r.id, status, changed: today() } }, roundNote({ ...r, status }, n));
  if (r.status === "scheduled") return [button(r.kind === "assignment" ? "Submitted" : "Given", set("given"))];
  if (r.status === "given") return [button("Cleared", set("cleared")), button("Not cleared", set("not_cleared"))];
  return [];
}

/** The one-click buttons for what's next on an application. */
function quickActions(a) {
  const st = T.stage(a, quietDays());
  const nx = T.next(a, quietDays());
  const end = outcome => () => changeApp(a, { set: { outcome } }, `How it ended: ${T.word(T.OUTCOMES, outcome).toLowerCase()}`);
  if (st === "waiting") return [button("They replied", () => replied(a))];
  if (st === "quiet") return [button("They replied", () => replied(a)), button("Ghosted", end("ghosted"))];
  if (!nx) return [];
  if (["round", "due", "result"].includes(nx.type)) return roundActions(a, nx.round);
  if (nx.type === "reply") return [button("Accepted", end("accepted")), button("Declined", end("declined"))];
  return [button(nx.type === "setup" ? "Add rounds" : "Open", () => openApp(a.key))];
}

/** What's coming up, soonest first: every booked round and due date (from a week back), offers to answer, rounds
 * with no result for 3 days or more. */
function upNext(apps) {
  const items = [];
  const from = Date.now() - 7 * 86400000;
  for (const a of apps) {
    const st = T.stage(a, quietDays());
    if (st === "offer") items.push({ a, nx: { type: "reply", at: null }, rank: 1, t: 0 });
    if (st !== "rounds") continue;
    for (const r of a.rounds) {
      const at = T.toDate(r.kind === "assignment" ? r.due : r.at);
      const days = T.daysSince(r.changed || r.at);
      if (r.status === "scheduled" && at && at.getTime() >= from) items.push({ a, nx: { type: r.kind === "assignment" ? "due" : "round", at, round: r }, rank: 0, t: at.getTime() });
      else if (r.status === "given" && days >= 3) items.push({ a, nx: { type: "result", at: null, round: r, days }, rank: 2, t: -days });
    }
  }
  return items.sort((x, y) => x.rank - y.rank || x.t - y.t);
}

function downloadIcs(a, r) {
  const url = URL.createObjectURL(new Blob([T.ics(a, r)], { type: "text/calendar" }));
  const name = `${a.company || "round"} ${roundName(r)}`.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  el("a", { href: url, download: `${name}.ics` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function upNextItem({ a, nx }) {
  const r = nx.round;
  const n = r ? a.rounds.indexOf(r) + 1 : 0;
  const [when, sub, cls, g, what] =
    nx.type === "round" ? [day(nx.at), r.at.length > 10 ? clock(nx.at) : "", "a-rounds", String(n), `Round ${n} · ${roundName(r)}`]
      : nx.type === "due" ? [day(nx.at), "due", "a-due", "!", `Assignment · ${roundName(r)}`]
        : nx.type === "reply" ? ["Offer", "to answer", "a-offer", "✓", "Say yes or no to the offer"]
          : ["No word", `for ${nx.days} days`, "a-rounds", String(n), `Round ${n} given, no result yet`];
  const calendar = nx.type === "round" && r.at.length > 10 ? button("Add to calendar", () => downloadIcs(a, r)) : null;
  return el("li", {},
    el("span", { className: "d" }, el("b", { textContent: when }), el("span", { textContent: sub })),
    glyphOf(cls, g),
    el("span", { className: "what" }, el("b", { textContent: what }), " ",
      el("span", { textContent: [a.company, a.title].filter(Boolean).join(", ") }), r?.note ? el("small", { textContent: r.note }) : null),
    el("span", { className: "acts" }, ...(r ? roundActions(a, r) : quickActions(a)), calendar, button("Open", () => openApp(a.key))));
}

function renderUpNext(items, apps) {
  const list = $("upnext");
  list.replaceChildren(...items.map(upNextItem));
  const quiet = apps.filter(a => T.stage(a, quietDays()) === "quiet").sort((x, y) => String(x.appliedAt).localeCompare(String(y.appliedAt)));
  if (quiet.length) {
    const oldest = quiet[0];
    list.append(el("li", {},
      el("span", { className: "d" }, el("b", { textContent: `${quietDays()}+ days` }), el("span", { textContent: "no reply" })),
      glyphOf("a-quiet", "–"),
      el("span", { className: "what" }, el("b", { textContent: `${quiet.length} application${quiet.length > 1 ? "s have" : " has"} gone quiet` }), " ",
        el("span", { textContent: `The oldest: ${oldest.company || oldest.title}, ${T.daysSince(oldest.appliedAt)} days` }),
        el("small", { textContent: "Close them as ghosted to keep the list short. One comes back if you say they replied." })),
      el("span", { className: "acts" },
        button("See them", () => { setAppGroup("quiet"); $("apps-list-title").scrollIntoView({ behavior: "smooth" }); }),
        button("Mark all ghosted", () => {
          if (confirm(`Close the ${quiet.length} applications with no reply in ${quietDays()}+ days as ghosted?`)) {
            changeApps(quiet.map(a => [a, { set: { outcome: "ghosted" } }, "How it ended: ghosted"]));
          }
        }))));
  }
  if (!list.children.length) list.append(el("li", { className: "empty", textContent: "Nothing coming up. Rounds and due dates you add show up here." }));
}

/** The overview's Applications card: the next three things, and the count in the sidebar. */
function renderComing(items) {
  const list = $("coming-list");
  list.replaceChildren();
  for (const { a, nx } of items.slice(0, 3)) {
    const r = nx.round;
    const what = nx.type === "round" ? `Round ${a.rounds.indexOf(r) + 1} · ${a.company || a.title}`
      : nx.type === "due" ? `Assignment due · ${a.company || a.title}` : nx.type === "reply" ? `Offer to answer · ${a.company || a.title}` : `No result yet · ${a.company || a.title}`;
    const when = nx.at ? `${day(nx.at)}${nx.type === "round" && r.at.length > 10 ? `, ${clock(nx.at)}` : ""}` : nx.type === "result" ? `Given ${ago(nx.days)}` : "";
    const link = el("a", { href: "#applications", textContent: what, onclick: e => { e.preventDefault(); openApp(a.key); } });
    list.append(el("li", {}, link, el("small", { textContent: when })));
  }
  if (!items.length) list.append(el("li", { className: "none", textContent: "Nothing coming up. Rounds you add show up here." }));
  const soon = items.filter(i => i.rank === 1 || (i.rank === 0 && i.t < Date.now() + 7 * 86400000)).length;
  const badge = $("nav-soon");
  badge.hidden = !soon;
  badge.textContent = soon;
  badge.title = `${soon} coming up this week`;
}

function renderFigures(apps) {
  const days = Number($("figures-period").value) || 0;
  const counted = apps.filter(a => (settings.tracker.countOld || !a.old) && (!days || T.daysSince(a.appliedAt) <= days));
  const f = T.figures(counted, askedKeys());
  const pct = (x, of) => {
    const p = of ? (x / of) * 100 : 0;
    return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`;
  };
  const tile = (label, n, sub, share, cls = "") => el("li", {},
    el("span", { className: "k", textContent: label }), el("b", { textContent: n.toLocaleString() }), el("small", { textContent: sub }),
    el("span", { className: "bar", ariaHidden: "true" }, el("span", { className: cls, style: `width: ${Math.min(100, share * 100)}%` })));
  $("figures").replaceChildren(
    tile("Applied", f.applied, `${f.bot} by Sendoff, ${f.applied - f.bot} by you`, f.applied ? 1 : 0),
    tile("Heard back", f.heard, `${pct(f.heard, f.applied)} of applied`, f.applied ? f.heard / f.applied : 0),
    tile("Had a round", f.rounds, `${pct(f.rounds, f.heard)} of those who replied`, f.heard ? f.rounds / f.heard : 0),
    tile("Offers", f.offers, `${pct(f.offers, f.rounds)} of those with a round`, f.rounds ? f.offers / f.rounds : 0, "offer"));
  const parts = [];
  const ended = [["rejected", "rejected"], ["withdrawn", "withdrawn"], ["ghosted", "ghosted"]].filter(([k]) => f.ended[k]);
  if (ended.length) parts.push(el("span", {}, "Closed: ", ...ended.flatMap(([k, w], i) => [i ? ", " : "", el("b", { textContent: f.ended[k] }), ` ${w}`])));
  if (f.referral.n) {
    parts.push(el("span", {}, "Replies with a referral asked: ", el("b", { textContent: pct(f.referral.heard, f.referral.n) }),
      ", without: ", el("b", { textContent: pct(f.referral.otherHeard, f.referral.otherN) })));
  }
  const sites = [...Object.keys(SITES), "manual"].filter(s => f.sites[s]);
  if (sites.length) {
    parts.push(el("span", {}, "Replies by site: ", ...sites.flatMap((s, i) => [i ? " · " : "", `${s === "manual" ? "Added by you" : SITES[s].name} `,
      el("b", { textContent: pct(f.sites[s].heard, f.sites[s].n) })])));
  }
  $("funnel-foot").replaceChildren(...parts);
  $("funnel-foot").hidden = !parts.length;
}

function setAppGroup(group) {
  appFilter.group = group;
  remember("apps.group", group);
  renderAppList();
}

function appRow(a, asked) {
  const [cls, g, what, sub] = stageView(a);
  const nv = nextView(a);
  const tags = [a.source === "manual" ? "Added by you" : a.source === "self" ? "You applied" : null, a.old ? "Before Sendoff" : null,
    asked.has(a.key) ? "Referral asked" : null].filter(Boolean);
  return el("tr", {},
    el("td", { className: "job" }, el("button", { type: "button", className: "job-link", textContent: a.title || "Untitled job", onclick: () => openApp(a.key) }),
      el("span", { textContent: [a.company, siteName(a)].filter(Boolean).join(" · ") }), ...tags.map(t => el("span", { className: "tag", textContent: t }))),
    el("td", { className: "stage" }, el("span", { className: "result-tag" }, glyphOf(cls, g), what), el("small", { textContent: sub })),
    el("td", { className: "next" }, ...(nv ? [el("b", { textContent: nv[0] }), el("small", { textContent: nv[1] })] : ["–"])),
    el("td", { className: "via" }, ...(a.heard ? [T.word(T.VIA, a.heard.via), el("small", { textContent: a.heard.who || "" })] : ["–"])),
    el("td", { className: "when", textContent: ago(T.daysSince(a.updated)) }),
    el("td", { className: "acts" }, ...quickActions(a)));
}

function renderAppList() {
  if (!settings) return;
  const apps = allApps();
  const items = upNext(apps);
  renderUpNext(items, apps);
  renderComing(items);
  renderFigures(apps);

  const inSite = apps.filter(a => !appFilter.site || a.site === appFilter.site);
  const groupOf = new Map(inSite.map(a => [a, T.group(T.stage(a, quietDays()))]));
  const count = g => (g ? inSite.filter(a => groupOf.get(a) === g).length : inSite.length);
  if (appFilter.group == null) appFilter.group = count("active") ? "active" : ""; // first visit: what's going on, else all
  for (const chip of document.querySelectorAll("#app-chips .chip")) {
    chip.setAttribute("aria-pressed", chip.dataset.group === appFilter.group);
    chip.querySelector(".n").textContent = count(chip.dataset.group).toLocaleString();
  }
  let rows = appFilter.group ? inSite.filter(a => groupOf.get(a) === appFilter.group) : inSite;
  if (appFilter.text) rows = rows.filter(a => `${a.title} ${a.company}`.toLowerCase().includes(appFilter.text));
  const at = a => T.next(a, quietDays())?.at?.getTime() ?? Infinity;
  rows.sort((x, y) => GROUP_RANK[groupOf.get(x)] - GROUP_RANK[groupOf.get(y)] || at(x) - at(y) || String(y.updated).localeCompare(String(x.updated)));

  const asked = askedKeys();
  const body = $("app-rows");
  body.replaceChildren(...rows.slice(0, HISTORY_LIMIT).map(a => appRow(a, asked)));
  if (!rows.length) {
    const text = !apps.length ? "No applications yet. Each job Sendoff applies to shows up here, and you can add ones you applied to yourself."
      : appFilter.text ? "No applications match that." : appFilter.group === "active" ? "Nothing going on yet. When a company replies, click They replied on it." : "Nothing here.";
    body.append(el("tr", { className: "empty-row" }, el("td", { colSpan: 6, textContent: text })));
  }
  const more = $("app-more");
  more.hidden = rows.length <= HISTORY_LIMIT;
  more.textContent = `Showing ${HISTORY_LIMIT} of ${rows.length.toLocaleString()}. Find one by its title or company.`;
}

function renderApps() {
  renderAppList();
  renderPanel();
}

// ---------------------------------------------------------------- one application, in the side panel

function openApp(key) {
  openKey = key;
  ui.panelKey = "";
  if (location.hash !== "#applications") location.hash = "#applications";
  const dialog = $("app-panel");
  if (!dialog.open) dialog.showModal();
  renderPanel();
  dialog.scrollTop = 0;
}

/** A box in the panel that saves when it's left with something new in it. */
function panelBox(props, save, f) {
  const box = el(props.rows ? "textarea" : "input", props);
  box.dataset.f = f;
  const was = box.value;
  // Dates on leaving, not on each change: a date box changes as each part is typed, and saving redraws the panel.
  box.addEventListener(/date/.test(props.type || "") ? "blur" : "change", () => {
    if (box.value.trim() !== was.trim()) save(box.value.trim());
  });
  return box;
}

/** Buttons for one choice of several, the chosen one pressed. Clicking it again clears it, when `clearable`. */
function seg(label, options, chosen, pick, f, clearable = false) {
  const group = el("div", { className: "seg" });
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const [value, text] of options) {
    const b = button(text, () => (value !== chosen ? pick(value) : clearable && pick(null)), "");
    b.setAttribute("aria-pressed", value === chosen);
    b.dataset.f = `${f}:${value}`;
    group.append(b);
  }
  return group;
}

function part(title, ...tools) {
  return el("section", {}, el("div", { className: "sec-head" }, el("h2", { textContent: title }), ...tools));
}

function panelHead(a) {
  const how = a.source === "manual" ? "added by you" : a.source === "self" ? "you applied" : a.old ? "applied before Sendoff" : "Sendoff applied";
  const askedHere = Object.values(people).filter(c => a.site === "linkedin" && c.jobId === a.jobId && ["messaged", "invited"].includes(c.status));
  return el("header", { className: "panel-head" },
    el("h1", { id: "app-panel-title", textContent: a.title || "Untitled job" }),
    a.company ? el("p", { className: "co", textContent: a.company }) : null,
    el("p", { className: "meta", textContent: `${siteName(a)} · ${how}${a.old ? "" : ` on ${dateWords(a.appliedAt)}`}` }),
    askedHere.length ? el("p", { className: "meta" }, el("span", { className: "tag", textContent: "Referral asked" }),
      ` ${askedHere.length} ${askedHere.length > 1 ? "people" : "person"} at ${a.company || "the company"}: ${askedHere.map(c => c.name).join(", ")}`) : null);
}

function steps(a) {
  const st = T.stage(a, quietDays());
  const offer = T.gotOffer(a);
  const given = a.rounds.filter(r => r.status !== "planned").length;
  const list = [
    ["Applied", "done", a.old ? "before Sendoff" : dateWords(a.appliedAt)],
    ["Heard back", T.heardBack(a) ? "done" : ["waiting", "quiet"].includes(st) ? "now" : "", a.heard?.at ? dateWords(a.heard.at) : ""],
    ["Rounds", offer && a.rounds.length ? "done" : ["heard", "rounds"].includes(st) ? "now" : "", a.rounds.length ? `${given} of ${a.rounds.length}` : ""],
    ["Offer", offer ? "done" : "", offer ? T.word(T.OUTCOMES, a.outcome) : ""],
  ];
  const ol = el("ol", { className: "steps" }, ...list.map(([label, state, sub]) => {
    const li = el("li", { className: state }, el("span", { className: "pip", textContent: state === "done" ? "✓" : "", ariaHidden: "true" }), label, el("small", { textContent: sub }));
    if (state === "now") li.setAttribute("aria-current", "step");
    return li;
  }));
  ol.setAttribute("aria-label", "Progress");
  return ol;
}

function heardPart(a) {
  const h = a.heard;
  if (!h) {
    return el("section", {}, el("div", { className: "sec-head" }, el("h2", { textContent: "Heard back" })),
      el("p", { className: "hint", textContent: T.heardBack(a) ? "They answered; when and how isn't noted." : "No reply yet." }),
      el("div", {}, button("They replied", () => changeApp(a, { heard: { at: today(), via: "email", who: "" } }, "They replied"), "btn")));
  }
  const box = part("Heard back", button("Not yet", () => changeApp(a, { heard: null }, "Reply taken back"), "link"));
  const at = panelBox({ type: "date", value: h.at || "" }, v => changeApp(a, { heard: { at: v } }), "heard:at");
  const who = panelBox({ value: h.who || "", placeholder: "Name, role" }, v => changeApp(a, { heard: { who: v } }), "heard:who");
  box.append(
    el("div", { className: "heard-fields" }, el("label", { className: "field" }, "When", at), el("label", { className: "field" }, "Who", who)),
    el("div", { className: "field" }, "How they reached you", seg("How they reached you", T.VIA, h.via, v => changeApp(a, { heard: { via: v } }), "heard:via")));
  return box;
}

function useTemplate(a, t) {
  return changeApp(a, { rounds: T.fromTemplate(t) }, `Added the ${t.name} rounds`);
}

function roundGlyph(r, n) {
  const cls = { planned: "a-waiting", given: "a-rounds", cleared: "a-offer", not_cleared: "a-rejected", missed: "a-closed" }[r.status]
    || (r.kind === "assignment" ? "a-due" : "a-rounds");
  return glyphOf(cls, String(n));
}

function roundCard(a, r, i) {
  const f = `r:${r.id}`;
  const n = i + 1;
  const save = (patch, note) => changeApp(a, { round: { id: r.id, ...patch } }, note);
  // a date on a round not booked yet books it
  const dated = patch => save({ ...patch, ...(r.status === "planned" && Object.values(patch)[0] ? { status: "scheduled", changed: today() } : {}) },
    r.status === "planned" && Object.values(patch)[0] ? roundNote({ ...r, status: "scheduled" }, n) : null);
  const name = panelBox({ className: "bare", value: r.name || "", placeholder: T.word(T.KINDS, r.kind) }, v => save({ name: v }), `${f}:name`);
  name.setAttribute("aria-label", `Round ${n}: name`);
  const kind = el("select", { className: "kind", onchange: e => save({ kind: e.target.value }) }, ...T.KINDS.map(([v, t]) => new Option(t, v, false, v === r.kind)));
  kind.dataset.f = `${f}:kind`;
  kind.setAttribute("aria-label", `Round ${n}: kind`);
  const tool = (text, label, onclick, off) => {
    const b = button(text, onclick, "btn icon");
    b.title = label;
    b.setAttribute("aria-label", `${label}: round ${n}`);
    b.disabled = off;
    b.dataset.f = `${f}:${label}`;
    return b;
  };
  const empty = r.status === "planned" && !r.at && !r.due && !r.note;
  const tools = el("span", { className: "round-tools" },
    tool("↑", "Move up", () => changeApp(a, { move: { id: r.id, by: -1 } }), i === 0),
    tool("↓", "Move down", () => changeApp(a, { move: { id: r.id, by: 1 } }), i === a.rounds.length - 1),
    tool("✕", "Remove", () => (empty || confirm(`Remove round ${n}${r.name ? ` (${r.name})` : ""}?`)) && changeApp(a, { drop: r.id }, `Removed round ${n}${r.name ? ` (${r.name})` : ""}`)));
  const assignment = r.kind === "assignment";
  const date = (key, type, label) => {
    const box = panelBox({ type, value: r[key] || "" }, v => dated({ [key]: v }), `${f}:${key}`);
    return el("label", {}, `${label} `, box);
  };
  const when = assignment ? [date("at", "date", "Got"), date("due", "date", "Due")] : [date("at", "datetime-local", "When")];
  const calendar = !assignment && (r.at || "").length > 10 ? button("Add to calendar", () => downloadIcs(a, r), "link") : null;
  // nothing pressed: not booked yet; clicking the pressed one again goes back to that
  const status = seg(`Round ${n}: how it went`, T.ROUND_STATUSES.filter(s => s !== "planned").map(s => [s, T.roundWord({ kind: r.kind, status: s })]), r.status,
    s => save({ status: s || "planned", changed: today() }, roundNote({ ...r, status: s || "planned" }, n)), `${f}:status`, true);
  const note = panelBox({ className: "bare note", value: r.note || "", placeholder: "Note: who, what to prepare, a link" }, v => save({ note: v }), `${f}:note`);
  note.setAttribute("aria-label", `Round ${n}: note`);
  const now = T.stage(a, quietDays()) === "rounds" && T.current(a) === r;
  return el("li", { className: `round${now ? " now" : ""}` }, roundGlyph(r, n),
    el("div", { className: "round-main" }, el("div", { className: "round-top" }, name, kind, tools), el("div", { className: "round-when" }, ...when, calendar), status, note));
}

function roundsPart(a) {
  const templates = (settings.tracker.templates || []).filter(t => t.rounds.length);
  const add = () => {
    const r = T.newRound();
    pendingFocus = `r:${r.id}:name`;
    changeApp(a, { round: r });
  };
  let pick = null;
  if (templates.length && a.rounds.length) {
    pick = el("select", { className: "small-select" }, new Option("Add from a template…", ""), ...templates.map((t, i) => new Option(t.name, i)));
    pick.setAttribute("aria-label", "Add rounds from a template");
    pick.onchange = () => pick.value !== "" && useTemplate(a, templates[pick.value]);
  }
  const box = part("Rounds", el("span", { className: "inline" }, pick, button("Add a round", add)));
  if (a.rounds.length) {
    box.append(el("ol", { className: "rounds" }, ...a.rounds.map((r, i) => roundCard(a, r, i))));
    return box;
  }
  box.append(el("p", { className: "hint", textContent: templates.length ? "Start from a template, then change what's different, or add rounds one by one."
    : "Add each round as you hear about it. A template (in Settings) adds a company's usual rounds in one click." }));
  if (templates.length) {
    box.append(el("div", { className: "tpls" }, ...templates.map(t => {
      const b = el("button", { type: "button", className: "tpl", onclick: () => useTemplate(a, t) },
        el("b", { textContent: t.name }), el("small", { textContent: t.rounds.map(([, name]) => name).join(" → ") }));
      b.dataset.f = `tpl:${t.name}`;
      return b;
    })));
  }
  return box;
}

function endPart(a) {
  const box = part("Result");
  box.append(
    seg("Result", T.OUTCOMES, a.outcome, v => changeApp(a, { set: { outcome: v } }, v ? `How it ended: ${T.word(T.OUTCOMES, v).toLowerCase()}` : "Reopened"), "end", true),
    el("p", { className: "hint", textContent: a.outcome ? "Click it again to take it back." : "Still going. Pick one when you know." }));
  return box;
}

function notesPart(a) {
  const notes = panelBox({ rows: 3, value: a.notes || "", placeholder: "Who you've met, what they asked, what to ask them" }, v => changeApp(a, { set: { notes: v } }), "notes");
  notes.id = "app-notes";
  return el("section", {}, el("label", { className: "sec-head", htmlFor: "app-notes" }, el("h2", { textContent: "Notes" })), notes);
}

function timelinePart(a) {
  const first = a.source === "manual" ? `Applied${a.through ? ` through ${a.through.toLowerCase()}` : ""}` : a.source === "self" ? `You applied on ${siteName(a)}`
    : a.old ? `Sendoff found it already applied on ${siteName(a)}` : `Sendoff applied on ${siteName(a)}`;
  const entries = [...(a.log || [])].reverse().map(e => [e.ts, e.text]).concat([[a.appliedAt, first]]);
  return el("section", {}, el("div", { className: "sec-head" }, el("h2", { textContent: "Timeline" })),
    el("ol", { className: "timeline" }, ...entries.map(([ts, text]) => el("li", {}, el("span", { className: "t", textContent: when(ts) }), el("span", { textContent: text })))));
}

function panelFoot(a) {
  const remove = button("Remove from Applications", () => {
    if (!confirm(`Remove ${a.title || "this job"}${a.company ? ` at ${a.company}` : ""} from Applications, with its rounds and notes?`)) return;
    $("app-panel").close();
    changeApp(a, a.source === "manual" ? { remove: true } : { set: { hidden: true } });
  }, "link danger");
  return el("footer", { className: "panel-foot" }, remove, a.source === "manual" ? null : el("small", { textContent: "The job stays in your History." }));
}

function renderPanel() {
  const dialog = $("app-panel");
  if (!dialog.open) return;
  const a = appOf(openKey);
  if (!a) {
    dialog.close();
    return;
  }
  const key = JSON.stringify([a, settings.tracker, quietDays(), today(), Object.keys(people).length]);
  if (key === ui.panelKey && !pendingFocus) return; // unchanged: don't redraw under the cursor
  ui.panelKey = key;
  const focus = pendingFocus || document.activeElement?.dataset?.f;
  pendingFocus = "";
  const open = $("app-panel-open");
  open.hidden = !/^https?:\/\//.test(a.url || "");
  if (!open.hidden) open.href = a.url;
  const scroll = dialog.scrollTop;
  $("app-panel-body").replaceChildren(panelHead(a), steps(a), heardPart(a), roundsPart(a), endPart(a), notesPart(a), timelinePart(a), panelFoot(a));
  dialog.scrollTop = scroll;
  if (focus) $("app-panel-body").querySelector(`[data-f="${CSS.escape(focus)}"]`)?.focus();
}

async function addManual() {
  if ($("add-dialog").returnValue !== "add") return;
  const f = $("add-form").elements;
  const id = T.newId();
  const on = f.on.value;
  const a = {
    key: `manual:${id}`, site: "manual", jobId: id, title: f.title.value.trim(), company: f.company.value.trim(), url: f.url.value.trim(),
    appliedAt: on === today() ? JB.store.now() : `${on} 12:00:00`, source: "manual", through: f.through.value,
  };
  await changeApp(a, {}, null);
  openApp(a.key);
}

/** You applied yourself to a job the bot left for you. */
function selfApplied(r) {
  return send({ type: "selfApplied", site: r.site, jobId: r.jobId });
}

function buildApps() {
  for (const [group, text] of APP_CHIPS) {
    const chip = el("button", { type: "button", className: "chip", onclick: () => setAppGroup(group) }, text, el("span", { className: "n" }));
    chip.dataset.group = group;
    $("app-chips").append(chip);
  }
  const pick = $("app-site");
  for (const [name, info] of Object.entries(SITES)) pick.add(new Option(info.name, name));
  pick.add(new Option("Added by you", "manual"));
  pick.onchange = () => { appFilter.site = pick.value; renderAppList(); };
  $("app-search").addEventListener("input", e => { appFilter.text = e.target.value.trim().toLowerCase(); renderAppList(); });
  const period = $("figures-period");
  period.value = remember("apps.period") || "";
  period.onchange = () => { remember("apps.period", period.value); renderAppList(); };

  $("add-app").onclick = () => {
    const dialog = $("add-dialog");
    $("add-form").reset();
    $("add-form").elements.on.value = today();
    dialog.returnValue = "";
    dialog.showModal();
  };
  $("add-dialog").addEventListener("close", addManual);

  const dialog = $("app-panel");
  $("app-panel-close").onclick = () => dialog.close();
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); }); // the backdrop
  dialog.addEventListener("close", () => { openKey = ""; });
}

// ---------------------------------------------------------------- your answers: what you told it when it asked

/** A question as it shows: without its options repeated at the end ("Can you relocate? Yes No"). */
function shownQuestion(q, options = []) {
  const tail = options.join(" ");
  return tail && q.endsWith(tail) && q.length > tail.length ? q.slice(0, -tail.length).trim() : q;
}

let boxes = 0; // to tell groups of options apart

/** A box to answer a question in: its options when it has some (a few as buttons, more as a list), else one to type
 * in. Its read() gives the answer; several options come back comma separated, the way the bot reads them. */
function answerBox(field, value = "") {
  const options = field.options || [];
  const label = shownQuestion(field.q, options);
  const several = field.kind === "several";
  if (options.length && (several || (field.kind === "choice" && options.length <= 4))) {
    const chosen = new Set(several ? String(value).split(/[,;|]/).map(o => o.trim()) : [value]);
    const name = `answer-${++boxes}`;
    const group = el("div", { className: "answer-opts" }, ...options.map(o => el("label", {},
      el("input", { type: several ? "checkbox" : "radio", name, value: o, checked: chosen.has(o) }), o)));
    group.setAttribute("role", several ? "group" : "radiogroup");
    group.setAttribute("aria-label", label);
    group.read = () => [...group.querySelectorAll("input:checked")].map(i => i.value).join(", ");
    return group;
  }
  if (options.length && field.kind === "choice") {
    const list = el("select", {}, new Option("Pick one", ""), ...options.map(o => new Option(o, o, false, o === value)));
    if (value && !options.includes(value)) list.add(new Option(value, value, false, true)); // kept before the options changed
    list.setAttribute("aria-label", label);
    list.read = () => list.value;
    return list;
  }
  const box = field.kind === "long" ? el("textarea", { rows: 3, value }) : el("input", { value, inputMode: field.kind === "number" ? "decimal" : "text" });
  box.setAttribute("aria-label", label);
  box.read = () => box.value.trim();
  return box;
}

function renderAnswers() {
  const section = $("set-your-answers");
  const typing = section.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)
    && !/^(radio|checkbox)$/.test(document.activeElement.type);
  if (typing) { // don't redraw under the cursor: once you leave the box
    section.addEventListener("focusout", () => setTimeout(renderAnswers), { once: true });
    return;
  }
  const status = $("answers-status");
  const siteOf = name => SITES[name]?.name || name;
  const open = Object.entries(waiting).sort(([, a], [, b]) => b.jobs.length - a.jobs.length || String(b.ts).localeCompare(String(a.ts)));
  $("waiting-part").hidden = !open.length;
  $("waiting-list").replaceChildren(...open.map(([k, w]) => {
    const control = answerBox(w);
    const save = async () => {
      const value = control.read();
      if (!value) {
        status.textContent = "Type or pick the answer first.";
        return;
      }
      const { retry } = await send({ type: "learn", items: [{ ...w, answer: value }] });
      status.textContent = retry ? `Saved. ${retry} job${retry > 1 ? "s" : ""} it left for you will be tried again on the next run.` : "Saved.";
    };
    return el("li", {},
      el("p", { className: "q", textContent: shownQuestion(w.q, w.options) }),
      el("small", { textContent: `${w.jobs.length} job${w.jobs.length > 1 ? "s" : ""} left for you over it${w.site ? `, on ${siteOf(w.site)}` : ""}` }),
      el("div", { className: "qa-row" }, control, button("Save", save, "btn"),
        button("Don't ask again", () => send({ type: "dropQuestions", keys: [k] }), "link")));
  }));
  const done = Object.entries(kept).sort(([, a], [, b]) => String(b.ts).localeCompare(String(a.ts)));
  $("kept-list").replaceChildren(...done.map(([k, a]) => {
    const control = answerBox(a, a.answer);
    control.addEventListener("change", async () => {
      const value = control.read();
      if (!value || value === a.answer) return;
      await send({ type: "learn", items: [{ ...a, answer: value }] });
      status.textContent = "Saved.";
    });
    return el("li", {},
      el("p", { className: "q", textContent: shownQuestion(a.q, a.options) }),
      el("small", { textContent: `${a.site ? `Asked on ${siteOf(a.site)}, ` : ""}${when(a.ts)}` }),
      el("div", { className: "qa-row" }, control, button("Forget", () => send({ type: "unlearn", keys: [k] }), "link")));
  }));
  if (!done.length) $("kept-list").append(el("li", { className: "none", textContent: "None yet. When the bot asks you something on the overview, or you answer a question above, it's kept here." }));
}

// ---------------------------------------------------------------- settings

const form = $("settings-form");
const LIST_FIELDS = new Set([
  "profile.filters.includeTitle", "profile.filters.requireRole", "profile.filters.excludeTitle",
  "profile.filters.excludeCompanies", "profile.filters.excludeText",
  ...Object.entries(SITES).flatMap(([name, info]) => [
    `sites.${name}.keywords`, `sites.${name}.searchUrls`, ...(info.locations ? [`sites.${name}.locations`] : []),
  ]),
  "sites.linkedin.referral.peopleKeywords", "sites.linkedin.referral.skipHeadline", "sites.linkedin.referral.jobs",
]);

/** One site's search and limits fields. */
function sitePanel(name, info) {
  const base = `sites.${name}`;
  const field = (cls, label, hint, control) => el("label", { className: cls }, label, hint ? el("small", { textContent: hint }) : null, control);
  const area = (path, rows) => el("textarea", { name: path, rows, spellcheck: false });
  const num = (path, min) => el("input", { type: "number", name: path, min, step: 1 });
  const depth = info.list ? null : JB.sites[name].paged
    ? field("field narrow", "Pages per search", info.pages, num(`${base}.limits.maxPages`, 1))
    : field("field narrow", "Scrolls per search", "Each loads more results", num(`${base}.limits.maxScrolls`, 0));
  const box = el("div", { className: "site-panel", id: `site-panel-${name}`, role: "tabpanel" },
    info.list ? companySettings(base, field, area) : el("div", { className: "two" },
      field("field", "Search keywords", info.keywords, area(`${base}.keywords`, 12)),
      field("field", "Extra search pages", `Optional. Whole ${info.name} search addresses, one per line.`, area(`${base}.searchUrls`, 12))),
    info.locations ? field("field", "Places", info.places || "One per line: a country or city, like india, or remote.", area(`${base}.locations`, 3)) : null,
    el("h3", { textContent: "How many" }),
    el("div", { className: "row-fields" },
      field("field narrow", "Per run", null, num(`${base}.limits.maxPerRun`, 1)),
      field("field narrow", "Per day", null, num(`${base}.limits.maxPerDay`, 1)),
      depth),
    el("div", { className: "row-fields" },
      field("field narrow", "Pause, at least", "seconds", num(`${base}.limits.delaySeconds.0`, 0)),
      field("field narrow", "Pause, at most", "seconds", num(`${base}.limits.delaySeconds.1`, 0))),
    el("p", { className: "hint", textContent: "After each application the bot waits a random time in this range, like a person would." }),
    info.linkedin ? linkedinSettings(base, field) : null,
    info.naukri ? naukriSettings(base, field) : null);
  box.setAttribute("aria-labelledby", `site-tab-${name}`);
  return box;
}

/** Company sites: the job links to apply to, and whether to show you each form before it's sent. */
function companySettings(base, field, area) {
  return el("div", { className: "site-extra first" },
    el("p", { className: "hint", textContent: "Applies on a company's own form when it's on Greenhouse, Lever, Ashby or Workday. Your profile and resume (Settings > Your profile) fill the standard boxes; the company's own questions are answered like any site's, and asked once when nothing answers them. On Workday you sign in yourself (each company has its own account); then it goes page by page." }),
    field("field", "Job links", "Greenhouse, Lever, Ashby or Workday job pages, one per line, like https://jobs.lever.co/acme/… . Each one is applied to once.", area(`${base}.searchUrls`, 8)),
    el("label", { className: "tick" }, el("input", { type: "checkbox", name: `${base}.fromOthers` }),
      el("span", {}, "Also the jobs the other sites found that apply on Greenhouse, Lever, Ashby or Workday",
        el("small", { textContent: "They're in History as Other site, with the link they opened." }))),
    field("field", "Before sending each application", null, el("div", { className: "checks" },
      el("label", {}, el("input", { type: "radio", name: `${base}.sendMode`, value: "review" }), "Show me the filled-in form first, with a Send button (recommended)"),
      el("label", {}, el("input", { type: "radio", name: `${base}.sendMode`, value: "direct" }), "Send it straight away"))));
}

/** Asking people at the companies applied to for a referral. */
function referralSettings(base, field, checks, tick) {
  const r = `${base}.referral`;
  const area = (path, rows, extra = {}) => el("textarea", { name: path, rows, spellcheck: false, ...extra });
  const num = (path, min) => el("input", { type: "number", name: path, min, step: 1 });
  const note = area(`${r}.connectNote`, 3);
  note.style.fontFamily = "var(--sans)";
  const counter = el("span", { className: "counter" });
  const count = () => {
    counter.textContent = `${note.value.length} of 300 characters`;
    counter.classList.toggle("over", note.value.length > 300);
  };
  note.addEventListener("input", count);
  note.dataset.counted = "1";
  note.count = count;
  const message = area(`${r}.message`, 8);
  message.style.fontFamily = "var(--sans)";
  return el("div", { className: "site-extra" },
    el("h3", { textContent: "Asking for referrals" }),
    el("p", { className: "hint", textContent: "For jobs it applied to, it finds people at the company among your 1st and 2nd-degree connections (alumni of your college first). People you're connected with get the message; the others get an invite with the note, and the message once they accept. Nobody is contacted twice." }),
    field("field", "Message", "{first_name}, {name}, {company}, {title} and {job_url} are filled in. Write the <…> part in your own words: until then it won't send referrals.", message),
    field("field", "Invite note", "To people you're not connected with yet. Free accounts get a few notes a month.", note),
    counter,
    tick(`${r}.inviteWithoutNote`, "Invite without a note once the free notes run out"),
    field("field", "Before each message or invite", null, el("div", { className: "checks" },
      el("label", {}, el("input", { type: "radio", name: `${r}.sendMode`, value: "review" }), "Show it to me first, with who it goes to (recommended)"),
      el("label", {}, el("input", { type: "radio", name: `${r}.sendMode`, value: "direct" }), "Send it straight away"))),
    field("field", "Which jobs to ask about", null, checks(`${r}.forJobs`, [["applied", "Jobs it applied to"], ["external", "Jobs that apply on the company's site"]])),
    el("div", { className: "row-fields" },
      field("field narrow", "From the last", "days", num(`${r}.withinDays`, 1)),
      field("field narrow", "People per company", null, num(`${r}.perCompany`, 1)),
      field("field narrow", "Per run", "messages + invites", num(`${r}.maxPerRun`, 1)),
      field("field narrow", "Per day", "LinkedIn allows ~100 invites a week", num(`${r}.maxPerDay`, 1)),
      field("field narrow", "Stop waiting after", "days without an accept", num(`${r}.inviteExpiryDays`, 1))),
    el("div", { className: "two" },
      field("field", "Your college", "Its alumni are asked first. Optional.", el("input", { name: `${r}.school` })),
      field("field", "Search people with", "One per line, like software engineer.", area(`${r}.peopleKeywords`, 3))),
    el("div", { className: "two" },
      field("field", "Skip people whose headline has", "One per line, like intern.", area(`${r}.skipHeadline`, 3)),
      field("field", "Also ask about these jobs", "LinkedIn job links, one per line, e.g. ones you applied to elsewhere.", area(`${r}.jobs`, 3))));
}

/** LinkedIn's own search filters, Easy Apply questions and answers. */
function linkedinSettings(base, field) {
  const checks = (path, options) => {
    const group = el("div", { className: "checks" }, ...options.map(([value, text]) => el("label", {}, el("input", { type: "checkbox", value }), text)));
    group.dataset.list = path;
    return group;
  };
  const tick = (path, text, hint) => el("label", { className: "tick" }, el("input", { type: "checkbox", name: path }), el("span", {}, text, hint ? el("small", { textContent: hint }) : null));
  const table = (id, head) => el("div", { className: "table-wrap" }, el("table", { className: "answers" },
    el("thead", {}, el("tr", {}, ...head.map(h => el("th", { textContent: h })))), el("tbody", { id })));
  const posted = el("select", { name: `${base}.postedWithin` }, ...POSTED_WITHIN.map(([v, t]) => new Option(t, v)));
  return el("div", { className: "site-extra" },
    el("h3", { textContent: "LinkedIn's search filters" }),
    field("field", "Experience level", "LinkedIn's own levels. None ticked: any.", checks(`${base}.experienceLevels`, LINKEDIN_LEVELS)),
    field("field", "Where you work", "None ticked: any.", checks(`${base}.workTypes`, LINKEDIN_WORK)),
    field("field narrow", "Posted within", null, posted),
    tick(`${base}.easyApplyOnly`, "Easy Apply jobs only", "The bot can only apply through Easy Apply; other jobs are listed as Other site."),
    el("h3", { textContent: "Years of experience with a skill" }),
    el("p", { className: "hint", textContent: "For questions like \"How many years of experience do you have with Python?\". The skill is matched as a whole word." }),
    table("skill-rows-linkedin", ["Skill", "Years", ""]),
    el("div", { className: "inline" },
      el("button", { type: "button", className: "btn", textContent: "Add a skill", onclick: () => { $("skill-rows-linkedin").append(skillRow()); dirty(); } }),
      field("field wide-hint", "Any other skill", "0 is honest for ones you haven't used. Empty: ask you.", el("input", { type: "number", name: `${base}.otherSkillYears`, min: 0, step: 0.5 }))),
    tick(`${base}.followCompanies`, "Follow the company when applying", "LinkedIn ticks this on every application; off unticks it."),
    referralSettings(base, field, checks, tick),
    el("h3", { textContent: "Answers for LinkedIn" }),
    el("p", { className: "hint", textContent: "LinkedIn uses these instead of the shared answers: some of its questions are number boxes, so salaries are plain rupee amounts, and the phone number goes without +91 because the country code is its own dropdown." }),
    table("answer-rows-linkedin", ["When the question matches", "Answer", ""]),
    el("div", {}, el("button", { type: "button", className: "btn", textContent: "Add an answer", onclick: () => { $("answer-rows-linkedin").append(answerRow()); dirty(); } })));
}

/** Naukri's own search filter, and how its questions get answered. */
function naukriSettings(base, field) {
  const posted = el("select", { name: `${base}.postedWithin` }, ...POSTED_WITHIN.map(([v, t]) => new Option(t, v)));
  return el("div", { className: "site-extra" },
    el("h3", { textContent: "Naukri's search filters" }),
    field("field narrow", "Posted within", null, posted),
    el("p", { className: "hint", textContent: "Naukri asks a job's questions in a chat, one at a time, and the shared answers answer them. When a question has options, the answer has to be one of them (or how one starts); for a length of time, like the notice period, the option covering it is picked: \"30 days\" picks \"1 Month\", \"15 days\" picks \"15 Days or less\". If none fits, or two fit as well, the job is left for you." }));
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
  tr.append(
    el("td", {}, input("pattern", pattern, "When the question matches")),
    el("td", {}, input("answer", answerText, "Answer")),
    rowTools(tr, "Move up: checked earlier"),
  );
  return tr;
}

/** A settings table row's last cell: move it up, down, or remove it. */
function rowTools(tr, up = "Move up") {
  const move = dir => () => {
    const to = dir < 0 ? tr.previousElementSibling : tr.nextElementSibling?.nextElementSibling;
    if (dir < 0 && !to) return;
    tr.parentElement.insertBefore(tr, to || null);
    dirty();
  };
  return el("td", {},
    el("button", { type: "button", className: "btn icon", textContent: "↑", title: up, onclick: move(-1) }), " ",
    el("button", { type: "button", className: "btn icon", textContent: "↓", title: "Move down", onclick: move(1) }), " ",
    el("button", { type: "button", className: "btn icon", textContent: "✕", title: "Remove", onclick: () => { tr.remove(); dirty(); } }),
  );
}

/** One round template: its name, and its rounds in order. */
function templateBox(t = { name: "", rounds: [] }) {
  const rows = el("tbody");
  const addRow = (kind = "interview", name = "") => {
    const tr = el("tr");
    const k = el("select", {}, ...JB.tracker.KINDS.map(([v, text]) => new Option(text, v, false, v === kind)));
    k.setAttribute("aria-label", "Kind");
    const n = el("input", { value: name, placeholder: "Like Technical, or Take-home", spellcheck: false });
    n.setAttribute("aria-label", "Round");
    tr.append(el("td", {}, k), el("td", {}, n), rowTools(tr));
    rows.append(tr);
    return tr;
  };
  for (const [kind, name] of t.rounds) addRow(kind, name);
  const name = el("input", { value: t.name, placeholder: "Its name, like Startup" });
  name.dataset.key = "template";
  name.setAttribute("aria-label", "Template name");
  const box = el("div", { className: "template" },
    el("div", { className: "template-head" }, name,
      el("button", { type: "button", className: "btn", textContent: "Remove template", onclick: () => { box.remove(); dirty(); } })),
    el("div", { className: "table-wrap" }, el("table", { className: "answers rounds-table" },
      el("thead", {}, el("tr", {}, el("th", { textContent: "Kind" }), el("th", { textContent: "Round" }), el("th", {}, el("span", { className: "sr", textContent: "Order" })))),
      rows)),
    el("div", {}, el("button", { type: "button", className: "btn", textContent: "Add a round", onclick: () => { addRow().querySelector("input").focus(); dirty(); } })));
  return box;
}

const readTemplates = () => [...document.querySelectorAll("#templates .template")].map(box => ({
  name: box.querySelector('[data-key="template"]').value.trim(),
  rounds: [...box.querySelectorAll("tbody tr")].map(tr => [tr.querySelector("select").value, tr.querySelector("input").value.trim()]).filter(([, n]) => n),
})).filter(t => t.name || t.rounds.length);

function skillRow(skill = "", years = "") {
  const tr = el("tr");
  const name = el("input", { value: skill, spellcheck: false });
  name.dataset.key = "skill";
  name.setAttribute("aria-label", "Skill");
  const n = el("input", { type: "number", min: 0, step: 0.5, value: years ?? "" });
  n.dataset.key = "years";
  n.setAttribute("aria-label", "Years");
  tr.append(el("td", {}, name), el("td", {}, n),
    el("td", {}, el("button", { type: "button", className: "btn icon", textContent: "✕", title: "Remove", onclick: () => { tr.remove(); dirty(); } })));
  return tr;
}

const rowsOf = id => [...document.querySelectorAll(`#${id} tr`)];
const readAnswers = id => rowsOf(id)
  .map(tr => [tr.querySelector('[data-key="pattern"]').value.trim(), tr.querySelector('[data-key="answer"]').value.trim()])
  .filter(([p, a]) => p || a);

function fillForm(s) {
  for (const input of form.querySelectorAll("[name]")) {
    const value = getPath(s, input.name);
    if (input.type === "radio") input.checked = input.value === (value || "review");
    else if (input.type === "checkbox") input.checked = !!value;
    else input.value = LIST_FIELDS.has(input.name) ? (value || []).join("\n") : value ?? "";
    input.removeAttribute("aria-invalid");
  }
  for (const group of form.querySelectorAll("[data-list]")) {
    const chosen = getPath(s, group.dataset.list) || [];
    for (const box of group.querySelectorAll("input")) box.checked = chosen.includes(box.value);
  }
  $("answer-rows").replaceChildren(...s.profile.answers.map(([p, a]) => answerRow(p, a)));
  $("answer-rows-linkedin").replaceChildren(...(s.sites.linkedin.answers || []).map(([p, a]) => answerRow(p, a)));
  $("skill-rows-linkedin").replaceChildren(...Object.entries(s.sites.linkedin.skillYears || {}).map(([k, v]) => skillRow(k, v)));
  $("templates").replaceChildren(...s.tracker.templates.map(templateBox));
  for (const area of form.querySelectorAll("[data-counted]")) area.count();
  setDirty(false);
  $("errors").textContent = "";
}

function readForm() {
  const s = structuredClone(settings);
  for (const input of form.querySelectorAll("[name]")) {
    let value;
    if (input.type === "radio" && !input.checked) continue; // the chosen one of the group sets the value
    if (LIST_FIELDS.has(input.name)) value = input.value.split("\n").map(l => l.trim()).filter(Boolean);
    else if (input.type === "checkbox") value = input.checked;
    else if (input.type === "number") value = input.value.trim() === "" ? null : Number(input.value);
    else value = input.value;
    setPath(s, input.name, value);
  }
  for (const group of form.querySelectorAll("[data-list]")) {
    setPath(s, group.dataset.list, [...group.querySelectorAll("input:checked")].map(box => box.value));
  }
  s.profile.answers = readAnswers("answer-rows");
  s.sites.linkedin.answers = readAnswers("answer-rows-linkedin");
  s.sites.linkedin.skillYears = Object.fromEntries(rowsOf("skill-rows-linkedin")
    .map(tr => [tr.querySelector('[data-key="skill"]').value.trim(), tr.querySelector('[data-key="years"]').value.trim()])
    .filter(([k]) => k)
    .map(([k, v]) => [k, v === "" ? null : Number(v)]));
  s.tracker.templates = readTemplates();
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
    const depth = info.list || (JB.sites[name].paged ? whole(`${base}.maxPages`, 1) : whole(`${base}.maxScrolls`, 0));
    if (![whole(`${base}.maxPerRun`, 1), whole(`${base}.maxPerDay`, 1), depth].every(Boolean)) {
      errors.push(`${info.name}: per run and per day are whole numbers, at least 1; so is how far to go through results.`);
    }
    const [lo, hi] = s.sites[name].limits.delaySeconds;
    if (![lo, hi].every(v => v != null && v >= 0) || lo > hi) {
      bad(`${base}.delaySeconds.0`);
      bad(`${base}.delaySeconds.1`);
      errors.push(`${info.name}: the pause is two numbers of seconds, the first not more than the second.`);
    }
    if (info.list) {
      const wrong = s.sites[name].searchUrls.filter(u => !JB.sites[name].parse(u));
      if (wrong.length) {
        bad(`sites.${name}.searchUrls`);
        errors.push(`${info.name}: these aren't Greenhouse, Lever, Ashby or Workday job links: ${wrong.slice(0, 3).join(", ")}${wrong.length > 3 ? ", …" : ""}`);
      }
    } else if (s.sites[name].searchUrls.some(u => !JB.sites[name].searchHost.test(u))) {
      bad(`sites.${name}.searchUrls`);
      errors.push(`${info.name}: extra search pages must be ${info.name} pages, starting ${JB.sites[name].loginUrl}`);
    }
  }
  const rc = s.sites.linkedin.referral || {};
  const base = "sites.linkedin.referral";
  const counts = ["withinDays", "perCompany", "maxPerRun", "maxPerDay", "inviteExpiryDays"].map(k => whole(`${base}.${k}`, 1));
  if (!counts.every(Boolean)) errors.push("LinkedIn referrals: the days and how many are whole numbers, at least 1.");
  if ((rc.connectNote || "").length > 300) { bad(`${base}.connectNote`); errors.push("LinkedIn referrals: the invite note can be 300 characters at most."); }
  if ((rc.jobs || []).some(u => !JB.sites.linkedin.jobUrlRe.test(u))) { bad(`${base}.jobs`); errors.push("LinkedIn referrals: the extra jobs must be LinkedIn job links (linkedin.com/jobs/view/…)."); }
  const other = s.sites.linkedin.otherSkillYears;
  if (other != null && !(other >= 0)) { bad("sites.linkedin.otherSkillYears"); errors.push("LinkedIn: years for other skills can't be negative."); }
  if (Object.values(s.sites.linkedin.skillYears).some(v => v != null && !(v >= 0))) errors.push("LinkedIn: years with a skill can't be negative.");
  const firstBad = $("site-panels").querySelector('[aria-invalid="true"]');
  if (firstBad) showSiteSettings(firstBad.closest(".site-panel").id.replace("site-panel-", ""));

  if (!whole("tracker.quietDays", 1)) errors.push("Applications: gone quiet after is a whole number of days, at least 1.");
  const unnamed = [...document.querySelectorAll('#templates [data-key="template"]')]
    .filter(input => !input.value.trim() && [...input.closest(".template").querySelectorAll("tbody input")].some(i => i.value.trim()));
  unnamed.forEach(input => input.setAttribute("aria-invalid", "true"));
  if (unnamed.length) errors.push("Applications: each round template needs a name.");

  let broken = 0;
  for (const tr of document.querySelectorAll("#answer-rows tr, #answer-rows-linkedin tr")) {
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
  $("add-template").onclick = () => {
    const box = templateBox();
    $("templates").append(box);
    box.querySelector("input").focus();
    dirty();
  };
  $("import-file").onchange = importFile;
  $("export").onclick = exportBackup;
  window.addEventListener("beforeunload", e => {
    if ($("savebar").classList.contains("dirty")) e.preventDefault();
  });
}

// ---------------------------------------------------------------- your resume

async function renderResume() {
  const file = await JB.store.resume();
  $("resume-status").textContent = file ? `${file.name}, ${Math.max(1, Math.round(file.size / 1024))} KB` : "None yet: a form that wants one is left for you.";
  $("resume-remove").hidden = !file;
}

function buildResume() {
  const pick = $("resume-file");
  for (const type of ["input", "change"]) pick.addEventListener(type, e => e.stopPropagation()); // saved by itself, not with Save
  pick.addEventListener("change", async () => {
    const file = pick.files[0];
    pick.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      $("resume-status").textContent = "That's over 5 MB; forms take smaller ones.";
      return;
    }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    await JB.store.saveResume({ name: file.name, type: file.type, size: file.size, data });
    renderResume();
  });
  $("resume-remove").onclick = async () => {
    await JB.store.saveResume(null);
    renderResume();
  };
  renderResume();
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
    const { added, apps } = await send({
      type: "import", settings: data.settings, history: data.history, cache: data.cache, contacts: data.contacts, referralJobs: data.referralJobs,
      track: data.track, kept: data.kept,
    });
    status.textContent = `Done: settings replaced, ${added} past jobs added${added < data.history.length ? ` (${data.history.length - added} were already here)` : ""}`
      + `${apps ? `, and ${apps} application${apps > 1 ? "s" : ""} you were following` : ""}.`;
  } catch (err) {
    status.classList.add("err");
    status.textContent = err.message;
  }
}

function exportBackup() {
  const history = Object.values(jobs).map(({ shot, ...r }) => r);
  const data = { format: FORMAT, exported: new Date().toISOString(), settings, history, track, kept };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  el("a", { href: url, download: `sendoff-backup-${today()}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------- start

async function init() {
  buildRunPanel();
  buildRail();
  buildHistory();
  buildApps();
  buildSettings();
  buildResume();
  buildShots();
  for (const link of document.querySelectorAll("[data-goto]")) {
    link.addEventListener("click", e => { e.preventDefault(); goto(link.dataset.goto); });
  }
  window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));
  $("reload-sendoff").onclick = () => chrome.runtime.reload(); // closes this tab; open the dashboard again from the icon
  checkWorker();
  selectSite(site);
  showPage(location.hash.slice(1));

  settings = await JB.store.getSettings();
  jobs = await JB.store.jobs();
  people = await JB.store.contacts();
  track = await JB.store.tracks();
  kept = await JB.store.kept();
  waiting = await JB.store.waiting();
  ui.day = today();
  for (const [k, run] of Object.entries(await chrome.storage.session.get(null))) {
    if (k.startsWith("run:") && SITES[k.slice(4)]) runs[k.slice(4)] = run;
  }
  fillForm(settings);
  $("first-run").hidden = !!settings.savedAt;
  renderRun();
  renderRail();
  renderHistory();
  renderApps();
  renderAnswers();

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
        renderApps();
      }
      if (changes.track) {
        track = changes.track.newValue || {};
        renderApps();
        renderHistory();
      }
      if (changes.kept || changes.waiting) {
        if (changes.kept) kept = changes.kept.newValue || {};
        if (changes.waiting) waiting = changes.waiting.newValue || {};
        renderAnswers();
        renderRail();
        renderHistory();
      }
      if (changes.contacts) {
        people = changes.contacts.newValue || {};
        renderReferrals();
        renderReferBox();
        renderApps();
      }
      if (changes.settings) {
        settings = JB.store.normalize(changes.settings.newValue);
        if (!$("savebar").classList.contains("dirty")) fillForm(settings);
        $("first-run").hidden = !!settings.savedAt;
        renderRail();
        renderReferBox();
        renderApps();
      }
    }
  });
  setInterval(() => { // "today" moves on at midnight
    renderRail();
    if (ui.day !== today()) {
      ui.day = today();
      renderApps();
    }
  }, 60000);
}

init();
