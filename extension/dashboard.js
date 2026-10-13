// The dashboard: start and watch runs, answer the bot's questions, see the history, edit the settings.
// Runs happen in the background worker; this page only shows their state (chrome.storage.session "run:<site>").
const SITES = {
  hirist: { name: "Hirist", how: "Uses your Hirist login in this Chrome. First time: click Log in and sign in (OTP, password or Google)." },
};
const STATUS = {
  applied: "Applied",
  needs_manual: "Needs you",
  failed: "Failed",
  skipped: "Skipped",
  already_applied: "Already applied",
  external: "External site",
};
const CHIPS = [["applied", "Applied"], ["needs_manual", "Needs you"], ["failed", "Failed"], ["skipped", "Skipped"], ["external", "External"], ["", "All"]];
const BUSY = { apply: "Applying…", "dry-run": "Checking jobs…", login: "Logging in…" };
const FORMAT = "job-apply-bots/1";
const HISTORY_LIMIT = 300;

const view = {}; // site -> { el, run, logKey, promptKey, stopping, error }
const filter = { status: "applied" };
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

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
}

async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply || reply.error) throw new Error(reply ? reply.error : "The extension didn't answer. Reload this page.");
  return reply;
}

function when(ts) {
  const d = new Date(String(ts).replace(" ", "T"));
  if (isNaN(d)) return ts || "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return `Today ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

const today = () => JB.store.now().slice(0, 10);

// ---------------------------------------------------------------- site cards

function buildCards() {
  const grid = document.getElementById("bots");
  const tpl = document.getElementById("bot-tpl");
  for (const [site, info] of Object.entries(SITES)) {
    const card = tpl.content.firstElementChild.cloneNode(true);
    card.querySelector("h2").textContent = info.name;
    card.querySelector(".how").textContent = info.how;
    const opts = remember(`opts.${site}`) || {};
    for (const input of card.querySelectorAll(".opts input")) {
      if (input.type === "checkbox") input.checked = !!opts[input.name];
      else input.value = opts[input.name] || "";
      input.addEventListener("change", () => remember(`opts.${site}`, options(site)));
    }
    card.addEventListener("click", e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "stop") stop(site);
      else if (act) start(site, act);
    });
    grid.append(card);
    view[site] = { el: card, run: null, logKey: "", promptKey: "", stopping: false, error: "" };
    renderRun(site);
  }
  grid.style.setProperty("--cols", Math.min(Object.keys(SITES).length, 3));
}

function options(site) {
  const q = name => view[site].el.querySelector(`.opts [name="${name}"]`);
  return { confirm: q("confirm").checked, assist: q("assist").checked, max: parseInt(q("max").value, 10) || null };
}

async function start(site, action) {
  const v = view[site];
  v.error = "";
  v.stopping = false;
  try {
    await send({ type: "start", site, action, opts: options(site) });
  } catch (e) {
    v.error = e.message;
  }
  renderRun(site);
}

async function stop(site) {
  view[site].stopping = true;
  renderRun(site);
  try {
    await send({ type: "stop", site });
  } catch (e) {
    view[site].error = e.message;
    renderRun(site);
  }
}

async function answer(site, id, value) {
  view[site].el.querySelector(".prompt").hidden = true;
  try {
    await send({ type: "answer", site, id, value });
  } catch (e) {
    view[site].error = e.message;
    renderRun(site);
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

function renderLog(site) {
  const v = view[site];
  const pre = v.el.querySelector(".log");
  const log = v.run?.log || [];
  const key = `${v.run?.id}:${log.length}:${log[log.length - 1] || ""}`;
  if (key === v.logKey) return;
  v.logKey = key;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.replaceChildren();
  if (!log.length) {
    pre.append(el("p", { className: "empty", textContent: "Nothing run yet. What the bot does will show up here as it goes." }));
    return;
  }
  for (const line of log.slice(-2000)) {
    pre.append(el("span", { className: lineClass(line), textContent: line.replace(/(\S) {3,}/g, "$1  ") }));
  }
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function renderPrompt(site) {
  const v = view[site];
  const box = v.el.querySelector(".prompt");
  const p = v.run?.running ? v.run.prompt : null;
  const key = p ? String(p.id) : "";
  if (box.dataset.key === key && box.hidden === !p) return; // unchanged; don't rebuild under the cursor
  box.dataset.key = key;
  box.hidden = !p;
  if (!p) return;
  box.querySelector(".prompt-q").replaceChildren(el("small", { textContent: p.title }), p.text);
  box.querySelector(".prompt-answers").replaceChildren(
    ...p.choices.map(([text, value, kind]) => el("button", { className: `btn ${kind || ""}`, textContent: text, onclick: () => answer(site, p.id, value) })),
  );
}

function finished(run) {
  const at = new Date(run.ended).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (run.stopped) return [`Stopped at ${at}.`, false];
  if (run.error === "interrupted") return [`Interrupted at ${at}. Click Apply to carry on.`, true];
  if (run.error) return [`Ended with an error at ${at}: ${run.error}`, true];
  const done = [...run.log].reverse().find(l => /^(Done:|Daily limit|Logged in|Still not logged in|Not logged in .*stopping|Nothing to search|Browser window)/.test(l));
  return [`Finished at ${at}.${done ? ` ${done}` : ""}`, false];
}

function renderRun(site) {
  const v = view[site];
  const run = v.run;
  const running = !!run?.running;
  if (!running) v.stopping = false;
  renderLog(site);
  renderPrompt(site);
  v.el.dataset.state = !running ? "idle" : run.prompt ? "waiting" : "running";

  const apply = v.el.querySelector('[data-act="apply"]');
  apply.textContent = running ? BUSY[run.action] : "Apply";
  apply.classList.toggle("busy", running);
  for (const b of v.el.querySelectorAll('[data-act="apply"], [data-act="dry-run"], [data-act="login"]')) b.disabled = running;
  v.el.querySelector('[data-act="stop"]').hidden = !running;

  let [text, isError] = ["", false];
  if (v.error) [text, isError] = [v.error, true];
  else if (v.stopping && running) text = "Stopping: the bot finishes the current step and closes its window…";
  else if (running) text = run.prompt ? "Waiting for you." : "Running. The bot works in its own Chrome window; leave it open.";
  else if (run) [text, isError] = finished(run);
  const status = v.el.querySelector(".status");
  status.textContent = text;
  status.classList.toggle("err", isError);
  renderTitle();
}

function renderToday(site) {
  const v = view[site];
  const rows = Object.values(jobs).filter(r => r.site === site);
  const applied = rows.filter(r => r.status === "applied" && String(r.ts).startsWith(today())).length;
  const needYou = rows.filter(r => r.status === "needs_manual").length;
  const max = settings?.sites[site]?.limits.maxPerDay;
  const box = v.el.querySelector(".today");
  box.replaceChildren(el("b", { textContent: applied }), max ? ` of ${max} today` : " applied today");
  if (needYou) {
    box.append(el("br"), el("button", {
      className: "need-you", textContent: `${needYou} need you`, title: "Jobs it couldn't finish; see them in History",
      onclick: () => { setFilter("needs_manual"); showTab("history", true); },
    }));
  }
  const maxInput = v.el.querySelector('.opts [name="max"]');
  maxInput.placeholder = settings?.sites[site]?.limits.maxPerRun ?? "";
}

function renderTitle() {
  const waiting = Object.keys(view).filter(s => view[s].run?.running && view[s].run.prompt);
  const running = Object.values(view).some(v => v.run?.running);
  document.title = waiting.length ? `Needs you: ${waiting.map(s => SITES[s].name).join(", ")}` : running ? "Running – Job bots" : "Job bots";
}

// ---------------------------------------------------------------- history

function setFilter(status) {
  filter.status = status;
  for (const chip of document.querySelectorAll(".chip")) chip.setAttribute("aria-pressed", chip.dataset.status === status);
  renderHistory();
}

function buildHistory() {
  const chips = document.getElementById("chips");
  for (const [status, text] of CHIPS) {
    const chip = el("button", { className: "chip", onclick: () => setFilter(status) }, text, el("span", { className: "n" }));
    chip.dataset.status = status;
    chip.setAttribute("aria-pressed", status === filter.status);
    chips.append(chip);
  }
  document.getElementById("recheck").onclick = recheckSkipped;
}

async function showShot(r) {
  const image = await JB.store.shot(r.site, r.jobId);
  if (!image) return;
  const dialog = document.getElementById("shot-dialog");
  dialog.querySelector("img").src = image;
  dialog.showModal();
}

function renderHistory() {
  const all = Object.values(jobs).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  for (const chip of document.querySelectorAll(".chip")) {
    const n = chip.dataset.status ? all.filter(r => r.status === chip.dataset.status).length : all.length;
    chip.querySelector(".n").textContent = n;
  }
  const rows = filter.status ? all.filter(r => r.status === filter.status) : all;
  const body = document.getElementById("history-rows");
  body.replaceChildren();
  if (!rows.length) {
    const text = filter.status === "applied" ? "No applications yet. Click Apply above to start." : "Nothing here.";
    body.append(el("tr", { className: "empty-row" }, el("td", { colSpan: 5, textContent: text })));
  }
  for (const r of rows.slice(0, HISTORY_LIMIT)) {
    const link = el("a", { target: "_blank", rel: "noopener", textContent: r.title || "Untitled job" });
    if (/^https?:\/\//.test(r.url || "")) link.href = r.url;
    const note = el("td", { className: "note" }, r.note || "");
    if (r.shot) note.append(r.note ? " " : "", el("button", { textContent: "Screenshot", onclick: () => showShot(r) }));
    body.append(el("tr", {},
      el("td", { className: "when", textContent: when(r.ts) }),
      el("td", { className: "site", textContent: SITES[r.site]?.name || r.site }),
      el("td", { className: "job" }, link, el("span", { textContent: r.company || "" })),
      el("td", {}, el("span", { className: `badge s-${r.status}`, textContent: STATUS[r.status] || r.status })),
      note,
    ));
  }
  const more = document.getElementById("history-more");
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

const form = document.getElementById("settings-form");
const LIST_FIELDS = new Set([
  "sites.hirist.keywords", "sites.hirist.searchUrls", "profile.filters.includeTitle", "profile.filters.requireRole",
  "profile.filters.excludeTitle", "profile.filters.excludeCompanies", "profile.filters.excludeText",
]);

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
  const p = input("pattern", pattern, "Question pattern");
  const a = input("answer", answerText, "Answer");
  const tr = el("tr");
  const move = dir => () => {
    const to = dir < 0 ? tr.previousElementSibling : tr.nextElementSibling?.nextElementSibling;
    if (dir < 0 && !to) return;
    tr.parentElement.insertBefore(tr, to || null);
    dirty();
  };
  tr.append(
    el("td", {}, p),
    el("td", {}, a),
    el("td", {},
      el("button", { type: "button", className: "btn icon", textContent: "↑", title: "Move up (checked earlier)", onclick: move(-1) }),
      " ",
      el("button", { type: "button", className: "btn icon", textContent: "↓", title: "Move down", onclick: move(1) }),
      " ",
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
  document.getElementById("answer-rows").replaceChildren(...s.profile.answers.map(([p, a]) => answerRow(p, a)));
  setDirty(false);
  document.getElementById("errors").textContent = "";
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
  for (const input of form.querySelectorAll("[aria-invalid]")) input.removeAttribute("aria-invalid");
  for (const input of document.querySelectorAll("#answer-rows [aria-invalid]")) input.removeAttribute("aria-invalid");

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

  for (const [site, info] of Object.entries(SITES)) {
    const base = `sites.${site}.limits`;
    const ok = [whole(`${base}.maxPerRun`, 1), whole(`${base}.maxPerDay`, 1), whole(`${base}.maxPages`, 1)];
    if (ok.includes(false)) errors.push(`${info.name}: how many per run, per day and pages are whole numbers, at least 1.`);
    const [lo, hi] = s.sites[site].limits.delaySeconds;
    if (![lo, hi].every(v => v != null && v >= 0) || lo > hi) {
      bad(`${base}.delaySeconds.0`);
      bad(`${base}.delaySeconds.1`);
      errors.push(`${info.name}: the pause is two numbers of seconds, the first not more than the second.`);
    }
    const offSite = s.sites[site].searchUrls.filter(u => !JB.sites[site].searchHost.test(u));
    if (offSite.length) {
      bad(`sites.${site}.searchUrls`);
      errors.push(`${info.name}: extra search pages must be ${info.name} pages, e.g. ${JB.sites[site].loginUrl}…`);
    }
  }

  const rows = [...document.querySelectorAll("#answer-rows tr")];
  for (const tr of rows) {
    const input = tr.querySelector('[data-key="pattern"]');
    if (JB.answers.badPatterns([[input.value.trim(), ""]]).length && (input.value.trim() || tr.querySelector('[data-key="answer"]').value.trim())) {
      input.setAttribute("aria-invalid", "true");
    }
  }
  const broken = rows.filter(tr => tr.querySelector('[aria-invalid="true"]')).length;
  if (broken) errors.push(`${broken} answer pattern${broken > 1 ? "s aren't" : " isn't"} a valid regular expression (marked in red).`);
  return errors;
}

function setDirty(on) {
  document.getElementById("savebar").classList.toggle("dirty", on);
  if (on) document.getElementById("saved").textContent = "Unsaved changes.";
}

function dirty() {
  setDirty(true);
}

async function save(e) {
  e.preventDefault();
  const s = readForm();
  const errors = check(s);
  document.getElementById("errors").textContent = errors.join("\n");
  if (errors.length) {
    document.getElementById("saved").textContent = "";
    return;
  }
  await JB.store.saveSettings(s);
  setDirty(false);
  document.getElementById("saved").textContent = `Saved. The next run uses these.`;
}

function buildSettings() {
  form.addEventListener("input", dirty);
  form.addEventListener("submit", save);
  document.getElementById("discard").onclick = () => fillForm(settings);
  document.getElementById("add-answer").onclick = () => {
    const row = answerRow();
    document.getElementById("answer-rows").append(row);
    row.querySelector("input").focus();
    dirty();
  };
  document.getElementById("import-file").onchange = importFile;
  document.getElementById("export").onclick = exportBackup;
  window.addEventListener("beforeunload", e => {
    if (document.getElementById("savebar").classList.contains("dirty")) e.preventDefault();
  });
}

// ---------------------------------------------------------------- screenshots

const ALL_SITES = { origins: ["<all_urls>"] };

async function renderShots() {
  const on = await chrome.permissions.contains(ALL_SITES);
  const button = document.getElementById("shots");
  button.dataset.on = on ? "1" : "";
  button.textContent = on ? "Turn screenshots off" : "Allow screenshots";
  document.getElementById("shots-status").textContent = on
    ? "On: each job that needs you gets a screenshot."
    : "Off: the history still lists the questions it couldn't answer.";
}

function buildShots() {
  const button = document.getElementById("shots");
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
  const status = document.getElementById("import-status");
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
  const question = `Replace your settings with the ones in ${file.name}, and add its ${data.history.length} past jobs to the history?`;
  if (!confirm(question)) return;
  try {
    const { added } = await send({ type: "import", settings: data.settings, history: data.history });
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
  el("a", { href: url, download: `job-bots-backup-${today()}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------------------------------------------------------------- tabs, first run, live updates

function showTab(name, scroll = false) {
  for (const tab of document.querySelectorAll(".tab")) tab.setAttribute("aria-selected", tab.dataset.tab === name);
  for (const panel of document.querySelectorAll(".panel")) panel.hidden = panel.id !== name;
  remember("tab", name);
  if (scroll) document.querySelector(".tabs").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSettingsState() {
  document.getElementById("first-run").hidden = !!settings.savedAt;
  for (const site of Object.keys(SITES)) renderToday(site);
}

async function init() {
  buildCards();
  buildHistory();
  buildSettings();
  buildShots();
  for (const link of document.querySelectorAll("[data-tab]")) {
    link.addEventListener("click", e => {
      showTab(link.dataset.tab, link.classList.contains("tab") ? false : true);
      if (link.hash) {
        e.preventDefault();
        document.querySelector(link.hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }
  showTab(remember("tab") === "settings" ? "settings" : "history");

  settings = await JB.store.getSettings();
  jobs = await JB.store.jobs();
  fillForm(settings);
  renderSettingsState();
  renderHistory();
  const saved = await chrome.storage.session.get(null);
  for (const site of Object.keys(SITES)) {
    view[site].run = saved[`run:${site}`] || null;
    renderRun(site);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session") {
      for (const [k, { newValue }] of Object.entries(changes)) {
        const site = k.slice(4);
        if (k.startsWith("run:") && view[site]) {
          view[site].run = newValue || null;
          if (newValue?.running) view[site].error = "";
          renderRun(site);
        }
      }
    } else if (area === "local") {
      if (changes.jobs) {
        jobs = changes.jobs.newValue || {};
        renderHistory();
        Object.keys(SITES).forEach(renderToday);
      }
      if (changes.settings) {
        settings = JB.store.normalize(changes.settings.newValue);
        if (!document.getElementById("savebar").classList.contains("dirty")) fillForm(settings);
        renderSettingsState();
      }
    }
  });
}

init();
