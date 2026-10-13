// Runs inside the job site's page, injected by the background worker: reads the page, fills forms and clicks
// (ported from core.py). The worker calls these through JB.page.call; "site.<name>" calls the site's own `page`.
(function (JB) {
  const norm = s => (s || "").replace(/\s+/g, " ").trim();
  const isVisible = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function waitUntil(test, timeout) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) if (test()) return true;
    return test();
  }

  // ------------------------------------------------------------ finding things

  const ROLE_CSS = {
    button: "button, [role=button], input[type=submit], input[type=button]",
    link: "a[href], [role=link]",
  };
  const nameOf = e => norm(e.getAttribute("aria-label") || e.innerText || e.value || e.getAttribute("title"));

  /** The first visible button (then link) whose name matches. */
  function firstVisible(scope, re, roles = ["button", "link"]) {
    for (const role of roles) {
      for (const e of scope.querySelectorAll(ROLE_CSS[role])) if (isVisible(e) && re.test(nameOf(e))) return e;
    }
    return null;
  }

  const DIALOG_CSS = "[role=dialog], dialog[open], [aria-modal=true], .modal, .ReactModal__Content";

  function visibleDialog() {
    const open = [...document.querySelectorAll(DIALOG_CSS)].filter(isVisible);
    return open.length ? open[open.length - 1] : null;
  }

  function click(e) {
    e.scrollIntoView({ block: "center" });
    e.click();
  }

  const APPLIED_BUTTON_RE = /^\s*applied\s*$/i;
  const APPLIED_TEXT_RE = new RegExp(
    "you('ve| have) (already )?applied|already applied|application (has been )?(sent|submitted|received)" +
      "|applied successfully|successfully applied",
    "i",
  );

  function isApplied() {
    if (JB.site.page.isApplied) return JB.site.page.isApplied(); // a site with its own way of showing it
    return !!firstVisible(document, APPLIED_BUTTON_RE) || APPLIED_TEXT_RE.test(document.body ? document.body.innerText : "");
  }

  /** [job URL, card text] pairs from a search page in the site's order, scrolling to load more results.
   * (Pairs, not an object: Chrome hands objects back to the extension with their keys sorted.) */
  async function collectLinks(maxScrolls) {
    const site = JB.site;
    const found = new Map();
    for (let i = 0; i <= maxScrolls; i++) {
      const before = found.size;
      for (const a of document.querySelectorAll(site.jobLinkCss)) {
        if (!site.jobUrlRe.test(a.href)) continue;
        const u = new URL(a.href);
        const url = `${u.protocol}//${u.host}${u.pathname}`;
        const text = norm(a.innerText);
        if (text.length > (found.get(url) || "").length) found.set(url, text);
      }
      if (found.size === before) break;
      window.scrollBy(0, 6000);
      await sleep(2000);
    }
    return [...found];
  }

  // ------------------------------------------------------------ forms

  // A label like "Enter your answer" says nothing; the question is in the surrounding block then.
  const GENERIC = /^(enter|type|write|add)?\s*(your|an?)?\s*(answer|response|text|here)\b|^[-–—\s]*$|^select\b/i;

  function labelOf(e) {
    const by = e.getAttribute("aria-labelledby") && document.getElementById(e.getAttribute("aria-labelledby"));
    const own = (e.labels && e.labels.length && e.type !== "radio" && norm(e.labels[0].innerText))
      || norm(e.getAttribute("aria-label")) || (by && norm(by.innerText)) || norm(e.placeholder);
    if (own && !GENERIC.test(own)) return own;
    for (let p = e.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      const s = norm(p.innerText);
      if (s && s !== own && !GENERIC.test(s)) return s.slice(0, 200);
    }
    return own || norm(e.name);
  }

  /** Climb past the block holding just the options to reach the question text. */
  function radioQuestion(root, e) {
    const same = [...root.querySelectorAll("input[type=radio]")].filter(r => r.name === e.name);
    let p = e.parentElement;
    while (p && !same.every(r => p.contains(r))) p = p.parentElement;
    const options = norm(p ? p.innerText : "");
    for (let i = 0; p && i < 4 && norm(p.innerText).length <= options.length + 5; i++) p = p.parentElement;
    return p ? norm(p.innerText).slice(0, 200) : "";
  }

  const optionOf = e => norm((e.labels && e.labels[0] && e.labels[0].innerText) || (e.closest("label") || {}).innerText || e.value);

  function fields(root) {
    return [...root.querySelectorAll("input, textarea, select")].map((e, i) => ({
      i,
      tag: e.tagName.toLowerCase(),
      type: (e.type || "").toLowerCase(),
      name: e.name || "",
      value: norm(e.value),
      checked: !!e.checked,
      disabled: e.disabled,
      visible: isVisible(e),
      label: e.type === "radio" ? radioQuestion(root, e) : labelOf(e),
      option: e.type === "radio" ? optionOf(e) : "",
      combo: e.getAttribute("aria-autocomplete") === "list" || e.getAttribute("role") === "combobox",
      chosen: !!(e.closest("[class*=container]") || e.parentElement)?.querySelector("[class*=singleValue], [class*=single-value]"),
    }));
  }

  /** Set a value the way typing would, so React and friends notice it. */
  function setValue(e, value, { blur = true } = {}) {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    e.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(e, value); // past React's own value setter
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    if (blur) e.blur();
  }

  /** Searchable dropdown: type the answer, pick the option that matches it. Never picks a mere guess. */
  async function chooseOption(box, answer) {
    if (!answer) return false;
    box.click();
    setValue(box, answer, { blur: false });
    await sleep(900);
    const options = [...document.querySelectorAll("[id*='-option-'], [role=option]")].filter(isVisible);
    // "Institute Of Technology, Delhi" == "institute of technology delhi"
    const plain = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const texts = options.map(o => plain(o.innerText));
    const want = plain(answer);
    for (const rule of [t => t === want, t => t.startsWith(want), t => t.includes(want)]) {
      const i = texts.findIndex(t => t && rule(t));
      if (i >= 0) {
        options[i].click();
        await sleep(300);
        return true;
      }
    }
    setValue(box, "", { blur: false }); // no matching option: clear it and move on
    box.blur();
    return false;
  }

  const NOTE_RE = /note|cover|message|pitch|recruiter|why|introduc|about (you|yourself)|interests? you|good fit/i;
  const IGNORED_TYPES = new Set(["hidden", "submit", "button", "file", "search", "checkbox", "image", "reset"]);

  /** Fill what we have answers for. Returns the questions we couldn't answer (empty = ready to submit). */
  async function fillForm(root, answers, note) {
    const { answerFor, numberAnswer } = JB.answers;
    const inputs = [...root.querySelectorAll("input, textarea, select")];
    const missing = [];
    const radioGroups = new Map();
    for (const f of fields(root)) {
      if (f.disabled || IGNORED_TYPES.has(f.type)) continue;
      if (f.type === "radio") {
        const key = f.name || f.label;
        if (!radioGroups.has(key)) radioGroups.set(key, { label: f.label, checked: false, options: [] });
        const group = radioGroups.get(key);
        group.checked = group.checked || f.checked;
        group.options.push([f.i, f.option]);
        continue;
      }
      if (f.combo) {
        if (!f.chosen && !(await chooseOption(inputs[f.i], answerFor(f.label, answers)))) {
          missing.push(f.label.slice(0, 60) || "dropdown");
        }
        continue;
      }
      if (!f.visible || f.value) continue;
      if (f.tag === "select") {
        missing.push(f.label.slice(0, 60) || "dropdown");
        continue;
      }
      let answer = answerFor(f.label, answers);
      const isMessageBox = f.tag === "textarea" && (!f.label || NOTE_RE.test(f.label));
      if (answer == null && isMessageBox) {
        if (!note) continue; // no cover note set: send without a message
        answer = note;
      }
      if (answer == null) {
        missing.push(f.label.slice(0, 60) || f.name || f.tag);
        continue;
      }
      setValue(inputs[f.i], f.type === "number" ? numberAnswer(answer) : answer);
    }
    for (const group of radioGroups.values()) {
      if (group.checked) continue;
      const answer = (answerFor(group.label, answers) || "").toLowerCase();
      const pick = group.options.find(([, option]) => answer && option.toLowerCase() === answer);
      if (!pick) {
        missing.push(group.label.slice(0, 60) || "choice");
        continue;
      }
      inputs[pick[0]].click(); // radios are often hidden behind custom styling
    }
    return missing;
  }

  const SUBMIT_RE = /^\s*(submit|apply|send|confirm|continue|next|done|yes)\b/i;
  const isDisabled = e => e.disabled || e.getAttribute("aria-disabled") === "true";

  /** One step of an application form: fill it, then submit it if everything got an answer. */
  async function formStep(answers, note) {
    const form = visibleDialog() || (JB.site.page.questionPage ? JB.site.page.questionPage() : null);
    if (!form) return { found: false };
    const missing = await fillForm(form, answers, note);
    if (missing.length) return { found: true, missing };
    const submit = firstVisible(form, SUBMIT_RE);
    if (!submit) return { found: true, missing: [], submitted: false };
    await waitUntil(() => !isDisabled(submit), 5000); // the form enables it once it has seen the answers
    click(submit);
    return { found: true, missing: [], submitted: true };
  }

  /** Click the apply button. Returns false if there's none, else the URL of a new tab it opens (or null). */
  function clickApply() {
    const button = firstVisible(document, JB.site.applyRe);
    if (!button) return false;
    const link = button.closest("a[href]");
    click(button);
    // Chrome blocks a new tab opened by a click that isn't the user's, so note where it would have gone.
    return link && link.target === "_blank" ? link.href : null;
  }

  JB.page = {
    norm,
    firstVisible,
    fields,
    fillForm,
    exists: css => !!document.querySelector(css),
    isApplied,
    collectLinks,
    clickApply,
    formStep,
    call(path, args) {
      const [scope, name] = path.startsWith("site.") ? [JB.site.page, path.slice(5)] : [JB.page, path];
      return typeof scope[name] === "function" ? scope[name](...(args || [])) : undefined;
    },
  };
})(globalThis.JB = globalThis.JB || {});
