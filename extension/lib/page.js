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
    menuitem: "[role=menuitem]",
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
    // a dropdown's own options are in the text around it: the question is what comes before them
    const first = e.tagName === "SELECT" && e.options.length ? norm(e.options[0].text) : "";
    for (let p = e.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
      let s = norm(p.innerText);
      if (first && s.includes(first)) s = s.slice(0, s.indexOf(first)).trim();
      if (s && s !== own && !GENERIC.test(s)) return s.slice(0, 200);
    }
    return own || norm(e.name);
  }

  const optionOf = e => norm((e.labels && e.labels[0] && e.labels[0].innerText) || (e.closest("label") || {}).innerText || e.value);

  /** Climb past the block holding just the options (radios, or checkboxes of one question) to reach the question text. */
  function radioQuestion(root, e) {
    const same = [...root.querySelectorAll(`input[type=${e.type}]`)].filter(r => r.name === e.name);
    let p = e.parentElement;
    while (p && !same.every(r => p.contains(r))) p = p.parentElement;
    const options = norm(same.map(optionOf).join(" ")); // the options' own text: a block with more has the question too
    for (let i = 0; p && i < 4 && norm(p.innerText).length <= options.length + 5; i++) p = p.parentElement;
    return p ? norm(p.innerText).slice(0, 200) : "";
  }

  /** Must it be answered? Marked so, or its label ends in * or ✱ (or says required, as some forms' classes do). */
  function isRequired(e, label) {
    return e.required || e.getAttribute("aria-required") === "true" || /[*✱]\s*$/.test(label)
      || [...(e.labels || [])].some(l => /required/i.test(l.className)) || !!e.closest(".required-field, [aria-required=true]");
  }

  function fields(root) {
    return [...root.querySelectorAll("input, textarea, select")].map((e, i) => {
      const choice = e.type === "radio" || e.type === "checkbox";
      const label = choice ? radioQuestion(root, e) : labelOf(e);
      return {
        i,
        tag: e.tagName.toLowerCase(),
        type: (e.type || "").toLowerCase(),
        name: e.name || "",
        value: norm(e.value),
        checked: !!e.checked,
        disabled: e.disabled,
        hidden: e.getAttribute("aria-hidden") === "true", // a form's own helper, like the box a custom dropdown checks with
        visible: isVisible(e),
        label,
        required: isRequired(e, label),
        option: choice ? optionOf(e) : "",
        combo: e.getAttribute("aria-autocomplete") === "list" || e.getAttribute("role") === "combobox",
        // a searchable dropdown shows what's picked beside its box (react-select: "select__single-value")
        chosen: !!(e.closest("[class*=control]") || e.closest("[class*=container]") || e.parentElement)?.querySelector("[class*=singleValue], [class*=single-value]"),
      };
    });
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

  const OPTION_CSS = "[id*='-option-'], [role=option]";

  /** Press the way a mouse does: some dropdowns (Greenhouse's) open only on the whole pointer-and-mouse sequence. */
  function press(e) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Kind = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      e.dispatchEvent(new Kind(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true }));
    }
  }

  const KEY_CODES = { ArrowDown: 40, Escape: 27 }; // some only read the old keyCode
  const key = (e, k) => e.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, keyCode: KEY_CODES[k], which: KEY_CODES[k], bubbles: true, cancelable: true }));
  const shownOptions = () => [...document.querySelectorAll(OPTION_CSS)].filter(isVisible);

  /** Open a searchable dropdown as a person would: click its box, else the down arrow. Returns its options. */
  async function openCombo(box) {
    box.focus();
    press(box.closest("[class*=control]") || box);
    await sleep(500);
    if (!shownOptions().length) {
      key(box, "ArrowDown");
      await sleep(400);
    }
    return shownOptions();
  }

  function closeCombo(box) {
    key(box, "Escape");
    box.blur();
  }

  /** Type a key at a time: a box that suggests (a city, a college) searches only then. */
  async function typeIn(box, text) {
    box.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(box, "");
    for (const ch of text) {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      set.call(box, box.value + ch);
      box.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      box.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(40);
    }
  }

  /** A searchable dropdown's options, to ask you which one: open it, read them, close it. None for one that only
   * searches as you type (like a list of colleges). */
  async function comboOptions(box) {
    const options = (await openCombo(box)).map(o => norm(o.innerText)).filter(Boolean);
    closeCombo(box);
    return options.slice(0, 300);
  }

  /** The option that's the answer: the same ("Institute Of Technology, Delhi" == "institute of technology delhi"),
   * else the first starting with it, else one containing it. */
  function matching(options, answer) {
    const want = plainText(answer);
    const texts = options.map(o => plainText(o.innerText));
    for (const rule of [t => t === want, t => t.startsWith(want), t => t.includes(want)]) {
      const i = texts.findIndex(t => t && rule(t));
      if (i >= 0) return options[i];
    }
    return null;
  }

  /** Searchable dropdown: pick the option that's the answer, from its list or, for one that searches as you type,
   * from what typing the answer brings up. Never picks a mere guess. */
  async function chooseOption(box, answer) {
    if (!answer) return false;
    let option = matching(await openCombo(box), answer);
    if (!option) {
      await typeIn(box, answer);
      for (let i = 0; i < 12 && !(option = matching(shownOptions(), answer)); i++) await sleep(250);
    }
    if (!option) {
      setValue(box, "", { blur: false }); // no matching option: clear it and move on
      closeCombo(box);
      return false;
    }
    option.scrollIntoView({ block: "nearest" });
    option.click();
    await sleep(300);
    if (option.isConnected && isVisible(option)) press(option); // still showing: it takes only the whole click
    await sleep(200);
    return true;
  }

  const NOTE_RE = /note|cover|message|pitch|recruiter|why|introduc|about (you|yourself)|interests? you|good fit/i;
  const plainText = t => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const IGNORED_TYPES = new Set(["hidden", "submit", "button", "file", "search", "checkbox", "image", "reset"]);

  // a dropdown's real options: not its "Select…" (or an empty value, like Lever's "Click Here (If you encounter an issue…)")
  const optionTexts = select => [...select.options].filter(o => o.value !== "").map(o => norm(o.text)).filter(t => t && !/^(select|choose|pick)\b|^-+$/i.test(t));

  /** Fill what we have answers for. Returns the questions we couldn't answer, each { q, kind, options } with kind
   * text, number, long, choice (one of the options), several (any of them) or search (a box that suggests). Empty:
   * ready to submit. With `requiredOnly` (long forms, like a company's own), a question that needn't be answered
   * is filled if there's an answer and otherwise left alone. */
  async function fillForm(root, answers, note, { requiredOnly = false } = {}) {
    const { answerFor, numberAnswer, pick, pickDuration } = JB.answers;
    const inputs = [...root.querySelectorAll("input, textarea, select")];
    const missing = [];
    const radioGroups = new Map();
    const boxGroups = new Map(); // checkboxes, by question
    const ask = (f, question) => (!requiredOnly || f.required) && missing.push(question);
    for (const f of fields(root)) {
      if (f.disabled || f.hidden) continue;
      if (f.type === "checkbox") {
        const key = f.name || f.label;
        if (!boxGroups.has(key)) boxGroups.set(key, { label: f.label, required: false, checked: false, options: [] });
        const group = boxGroups.get(key);
        group.required = group.required || f.required;
        group.checked = group.checked || f.checked;
        group.options.push([f.i, f.option]);
        continue;
      }
      if (IGNORED_TYPES.has(f.type)) continue;
      if (f.type === "radio") {
        const key = f.name || f.label;
        if (!radioGroups.has(key)) radioGroups.set(key, { label: f.label, required: false, checked: false, options: [] });
        const group = radioGroups.get(key);
        group.required = group.required || f.required;
        group.checked = group.checked || f.checked;
        group.options.push([f.i, f.option]);
        continue;
      }
      if (f.combo) {
        if (!f.chosen && !(await chooseOption(inputs[f.i], answerFor(f.label, answers))) && (!requiredOnly || f.required)) {
          const options = await comboOptions(inputs[f.i]);
          missing.push(options.length ? { q: f.label || "dropdown", kind: "choice", options } : { q: f.label || "dropdown", kind: "search" });
        }
        continue;
      }
      if (!f.visible) continue;
      if (f.tag === "select") {
        const select = inputs[f.i];
        const chosen = select.options[select.selectedIndex];
        if (chosen && chosen.value && optionTexts(select).includes(norm(chosen.text))) continue; // already picked
        const options = optionTexts(select);
        const given = answerFor(f.label, answers);
        const k = pick(options, given) ?? pickDuration(options, given);
        const option = k == null ? null : [...select.options].find(o => norm(o.text) === options[k]);
        if (option) setValue(select, option.value);
        else ask(f, { q: f.label || "dropdown", kind: "choice", options });
        continue;
      }
      if (f.value) continue;
      let answer = answerFor(f.label, answers);
      const isMessageBox = f.tag === "textarea" && (!f.label || NOTE_RE.test(f.label));
      if (answer == null && isMessageBox && note) answer = note;
      if (answer == null && isMessageBox && !requiredOnly) continue; // no cover note set: send without a message
      if (answer == null) {
        ask(f, { q: f.label || f.name || f.tag, kind: f.tag === "textarea" ? "long" : f.type === "number" ? "number" : "text" });
        continue;
      }
      setValue(inputs[f.i], f.type === "number" ? numberAnswer(answer) : answer);
    }
    for (const group of radioGroups.values()) {
      if (group.checked) continue;
      const answer = (answerFor(group.label, answers) || "").toLowerCase();
      const chosen = group.options.find(([, option]) => answer && option.toLowerCase() === answer);
      if (!chosen) {
        if (!requiredOnly || group.required) missing.push({ q: group.label || "choice", kind: "choice", options: group.options.map(([, option]) => option) });
        continue;
      }
      inputs[chosen[0]].click(); // radios are often hidden behind custom styling
    }
    for (const group of boxGroups.values()) {
      const options = group.options.map(([, option]) => option);
      if (group.checked || !options.some(o => o && o !== "on")) continue; // ticked already, or no option to read (a custom control's own)
      const given = answerFor(group.label, answers) || "";
      // a lone box ("I agree") takes yes; several take the ones the answer lists, comma separated
      const wanted = options.length === 1 ? (/^(yes|y|true|i agree|agree)$/i.test(given.trim()) || plainText(given) === plainText(options[0]) ? [0] : [])
        : JB.answers.pickSeveral(options, given);
      if (!wanted.length) {
        if (group.required) missing.push({ q: group.label || "choice", kind: options.length === 1 ? "choice" : "several", options });
        continue;
      }
      for (const k of wanted) inputs[group.options[k][0]].click();
    }
    return missing;
  }

  // ------------------------------------------------------------ what you enter yourself

  const TYPED = "__sendoffTyped"; // kept in the tab's sessionStorage: a form going on to its next page keeps it too
  const sameQuestion = (a, b) => a === b || (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a)));

  /** What the boxes for these questions (their keys) hold now: { key: { q, answer } }. */
  function snapshot(keys) {
    const inputs = [...document.body.querySelectorAll("input, textarea, select")];
    const got = {};
    for (const f of fields(document.body)) {
      const k = JB.answers.questionKey(f.label);
      if (!k || f.hidden || !keys.some(w => sameQuestion(w, k))) continue;
      const e = inputs[f.i];
      let answer = "";
      if (f.type === "radio") answer = f.checked ? f.option : got[k]?.answer || "";
      else if (f.type === "checkbox") answer = [got[k]?.answer, f.checked ? f.option : ""].filter(Boolean).join(", ");
      else if (f.combo) answer = norm((e.closest("[class*=control]") || e.parentElement)?.querySelector("[class*=single-value], [class*=singleValue]")?.innerText || e.value);
      else if (f.tag === "select") answer = optionTexts(e).includes(norm(e.options[e.selectedIndex]?.text)) ? norm(e.options[e.selectedIndex].text) : "";
      else if (!IGNORED_TYPES.has(f.type)) answer = f.value;
      if (answer) got[k] = { q: f.label, answer };
    }
    return got;
  }

  /** Watch what you enter for these questions while you fill the form in yourself (typedAnswers reads it). */
  function watchAnswers(questions) {
    window.__sendoffKeys = questions.map(JB.answers.questionKey).filter(Boolean);
    sessionStorage.setItem(TYPED, "{}");
    if (!window.__sendoffWatching) {
      window.__sendoffWatching = true;
      let timer;
      const keep = () => {
        const saved = JSON.parse(sessionStorage.getItem(TYPED) || "{}");
        sessionStorage.setItem(TYPED, JSON.stringify({ ...saved, ...snapshot(window.__sendoffKeys || []) }));
      };
      for (const type of ["input", "change", "focusout", "click"]) {
        document.addEventListener(type, () => {
          clearTimeout(timer);
          timer = setTimeout(keep, 300);
        }, true);
      }
    }
    return true;
  }

  /** What you entered for the questions being watched ([{ q, answer }]); the watching stops. */
  function typedAnswers() {
    const saved = JSON.parse(sessionStorage.getItem(TYPED) || "{}");
    const now = window.__sendoffKeys ? snapshot(window.__sendoffKeys) : {};
    sessionStorage.removeItem(TYPED);
    window.__sendoffKeys = null;
    return Object.values({ ...saved, ...now });
  }

  const SUBMIT_RE = /^\s*(submit|apply|send|confirm|continue|next|done|yes)\b/i;
  const isDisabled = e => e.disabled || e.getAttribute("aria-disabled") === "true";
  /** A form enables its submit button once it has seen the answers; give it a moment. */
  const whenEnabled = (e, timeout = 5000) => waitUntil(() => !isDisabled(e), timeout);

  /** One step of an application form: fill it, then submit it if everything got an answer. */
  async function formStep(answers, note) {
    const form = visibleDialog() || (JB.site.page.questionPage ? JB.site.page.questionPage() : null);
    if (!form) return { found: false };
    const missing = await fillForm(form, answers, note);
    if (missing.length) return { found: true, missing };
    const submit = firstVisible(form, SUBMIT_RE);
    if (!submit) return { found: true, missing: [], submitted: false };
    await whenEnabled(submit);
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
    isVisible,
    click,
    firstVisible,
    APPLIED_TEXT_RE,
    fields,
    fillForm,
    chooseOption,
    comboOptions,
    typeIn,
    matching,
    isRequired,
    setValue,
    visibleDialog,
    whenEnabled,
    exists: css => !!document.querySelector(css),
    isApplied,
    collectLinks,
    clickApply,
    formStep,
    watchAnswers,
    typedAnswers,
    call(path, args) {
      const [scope, name] = path.startsWith("site.") ? [JB.site.page, path.slice(5)] : [JB.page, path];
      return typeof scope[name] === "function" ? scope[name](...(args || [])) : undefined;
    },
  };
})(globalThis.JB = globalThis.JB || {});
