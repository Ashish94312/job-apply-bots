// The account panel of the billing edition: sign in with Google, buy or extend a pass, sign out. Without an active
// pass (or a free trial, where one is offered), the dashboard shows a paywall; only this panel, exporting and
// stopping runs stay open. The sign-in is kept in chrome.storage.local (never in a backup) and lasts while it's used.
(() => {
  const origin = globalThis.SENDOFF_BILLING_ORIGIN;
  if (!origin) return;
  const PRODUCT = "sendoff";
  const ENDING_DAYS = 3; // from here the pass is shown as ending, and extending it is the main action
  const $ = selector => document.querySelector(selector);
  const panel = $("#billing");
  panel.hidden = false;
  $("#billing-mode").hidden = !!globalThis.SENDOFF_BILLING_LIVE;
  const status = panel.querySelector("output");
  const who = $("#billing-account");
  const badge = $("#billing-badge");
  const buttons = [...panel.querySelectorAll("[data-billing]")];
  const button = name => buttons.find(b => b.dataset.billing === name);
  const paywall = {
    root: $("#paywall"), title: $("#paywall-title"), lede: $("#paywall-lede"),
    price: $("#paywall-price"), action: $("#paywall-action"),
  };
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const nonce = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  const { local, session } = chrome.storage;
  const day = seconds => new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const rupees = offer => `₹${(offer.paise / 100).toFixed(offer.paise % 100 ? 2 : 0)}`;
  const price = offer => `${rupees(offer)} for ${offer.days} days`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const exportButton = $("#billing-export");
  function lock(locked) {
    document.querySelectorAll("main, .side .nav, .side .sites").forEach(node => {
      node.inert = locked;
      node.hidden = locked;
    });
    paywall.root.hidden = !locked;
    exportButton.hidden = !locked; // the dashboard's own Export is in what's hidden
  }
  lock(true);
  exportButton.onclick = () => document.getElementById("export").click();

  const stopButton = $("#billing-stop");
  async function runningSites() {
    return Object.entries(await session.get(null)).filter(([k, v]) => k.startsWith("run:") && v?.running).map(([k]) => k.slice(4));
  }
  async function showStop() { stopButton.hidden = !(await runningSites()).length; }
  stopButton.onclick = async () => {
    for (const site of await runningSites()) await chrome.runtime.sendMessage({ type: "stop", site });
  };
  showStop();

  const call = (path, options = {}) => fetch(origin + path, { credentials: "omit", redirect: "error", ...options });
  async function forget() {
    await local.remove("billingToken");
    await session.remove("billingAccess");
  }
  /** A request as the signed-in account. Null when not signed in, or the sign-in has ended (then it's forgotten). */
  async function authed(path, options = {}) {
    const { billingToken } = await local.get("billingToken");
    if (!billingToken) return null;
    const response = await call(path, { ...options, headers: { Authorization: "Bearer " + billingToken } });
    if (response.status === 403) {
      await forget();
      return null;
    }
    if (!response.ok) throw Error("Sendoff's billing service is unavailable. Try Refresh in a minute.");
    return response;
  }

  /** Puts one state on the panel and the paywall: which buttons, the badge, and what the main action does. */
  function render({ email = "", text, pill, tone, links = [], upgrade, primary, wall }) {
    who.hidden = !email;
    who.title = email;
    who.querySelector(".avatar").textContent = email.slice(0, 1);
    who.querySelector(".account-email").textContent = email;
    badge.hidden = !pill;
    badge.textContent = pill || "";
    badge.dataset.tone = tone || "";
    status.textContent = text;
    button("signin").hidden = !!email;
    const up = button("upgrade");
    up.hidden = !upgrade;
    if (upgrade) up.textContent = upgrade;
    up.classList.toggle("primary", !!primary);
    for (const name of ["refresh", "logout"]) button(name).hidden = !links.includes(name);
    if (wall) {
      paywall.title.textContent = wall.title;
      paywall.lede.textContent = wall.lede;
      paywall.price.hidden = !wall.offer;
      if (wall.offer) {
        paywall.price.replaceChildren(Object.assign(document.createElement("strong"), { textContent: rupees(wall.offer) }),
                                      `for ${wall.offer.days} days`);
      }
      paywall.action.hidden = !wall.action;
      paywall.action.dataset.action = wall.action || "";
      paywall.action.textContent = wall.label || "";
    }
  }

  let expiryTimer;
  async function refresh() {
    clearTimeout(expiryTimer);
    const response = await authed(`/access?product=${PRODUCT}`);
    if (!response) {
      lock(true);
      const { trial_days: trial, offer } = await call(`/offer?product=${PRODUCT}`).then(r => r.json()).catch(() => ({}));
      const lede = trial ? `Sign in with Google to start your ${trial}-day free trial, or to restore a pass you bought.`
        : "Sign in with Google to buy a pass, or to restore one you bought on another computer.";
      render({ text: trial ? `Sign in with Google to start your ${trial}-day free trial.` : "Sign in with Google to use Sendoff.",
               wall: { title: "Sign in to use Sendoff", lede, offer, action: "signin", label: "Sign in with Google" } });
      return;
    }
    const access = await response.json();
    const now = Date.now() / 1000;
    const active = access.expires > now;
    await session.set({ billingAccess: { expires: access.expires, checked: Date.now() } }); // for the worker
    const email = access.email || "";
    const offer = access.offer;
    const links = ["refresh", "logout"];
    const buy = offer ? `Buy pass · ${rupees(offer)}` : "";
    if (active) {
      const left = Math.max(1, Math.ceil((access.expires - now) / 86400));
      const ending = left <= ENDING_DAYS;
      const kind = access.trial ? "Free trial" : "Pass";
      render({
        email, links, primary: ending || access.trial,
        pill: ending ? `Ends in ${plural(left, "day")}` : `${access.trial ? "Trial" : "Active"} · ${plural(left, "day")} left`,
        tone: ending ? "warn" : "",
        text: `${kind} valid until ${day(access.expires)}.` +
              (offer && !access.trial ? ` Extending adds ${offer.days} days after that.` : "") +
              (offer && access.trial ? ` After that, a pass is ${price(offer)}.` : ""),
        upgrade: offer ? (access.trial ? buy : `Extend pass · ${rupees(offer)}`) : "",
      });
      lock(false);
      expiryTimer = setTimeout(() => run("refresh"), Math.min((access.expires - now) * 1000 + 1000, 3600000));
      return;
    }
    const ended = access.expires ? `Your ${access.trial ? "free trial" : "pass"} ended on ${day(access.expires)}.` : "No active pass.";
    const title = !access.expires ? "Get a pass to start applying" : `Your ${access.trial ? "free trial" : "pass"} has ended`;
    render({
      email, links, primary: true, upgrade: buy,
      pill: access.expires ? "Ended" : "No pass", tone: "off",
      text: `${ended} ${offer ? `A pass is ${price(offer)}.` : "Purchases are paused right now."}`,
      wall: {
        title, offer,
        lede: offer ? `${ended} Buy a pass to unlock everything for ${offer.days} days. One payment, no auto-renewal.`
          : `${ended} Purchases are paused right now; try again later.`,
        action: offer ? "upgrade" : "", label: buy,
      },
    });
    lock(true);
  }

  async function signIn() {
    const verifier = nonce(), state = nonce();
    const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const url = origin + "/authorize?" + new URLSearchParams({ state, challenge, product: PRODUCT });
    let result;
    try {
      result = new URL(await chrome.identity.launchWebAuthFlow({ url, interactive: true }));
    } catch {
      throw Error("Sign-in didn't finish. Try again.");
    }
    if (result.origin + result.pathname !== chrome.identity.getRedirectURL("billing") ||
        result.searchParams.get("state") !== state) throw Error("Sign-in could not be verified.");
    if (!result.searchParams.get("code")) throw Error("Sign-in cancelled.");
    const response = await call("/token", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: result.searchParams.get("code"), verifier }) });
    if (!response.ok) throw Error("Sign-in expired. Please retry.");
    await local.set({ billingToken: (await response.json()).token });
  }

  // Checkout happens in its own tab: when it closes, look again (the payment may take a few seconds to confirm).
  let checkoutTab = null;
  chrome.tabs.onRemoved.addListener(id => {
    if (id !== checkoutTab) return;
    checkoutTab = null;
    run("refresh");
    setTimeout(() => run("refresh"), 10000);
  });
  async function buy() {
    const response = await authed(`/checkout/start?product=${PRODUCT}`, { method: "POST" });
    if (!response) return;
    const { url } = await response.json();
    if (!url.startsWith(origin + "/checkout?")) throw Error("Checkout could not be opened.");
    checkoutTab = (await chrome.tabs.create({ url })).id;
  }

  const WORKING = { signin: "Opening Google sign-in…", upgrade: "Opening checkout…" };
  let busy = false;
  async function run(action) {
    if (busy) return;
    busy = true;
    const controls = [...buttons, paywall.action];
    controls.forEach(b => b.disabled = true);
    const label = paywall.action.textContent;
    if (WORKING[action] && paywall.action.dataset.action === action) {
      paywall.action.classList.add("busy");
      paywall.action.textContent = WORKING[action];
    }
    try {
      if (action === "signin") await signIn();
      if (action === "upgrade") await buy();
      if (action === "logout") {
        try {
          await authed("/logout", { method: "POST" });
        } catch {
          // signed out here all the same
        } finally {
          await forget();
        }
      }
      await refresh();
    } catch (error) {
      // An outage keeps what was last seen: a trial or pass that hasn't ended yet still counts.
      const { billingAccess } = await session.get("billingAccess");
      lock(!(billingAccess && billingAccess.expires > Date.now() / 1000));
      status.textContent = error.message;
      if (!paywall.root.hidden) paywall.lede.textContent = error.message;
      if (paywall.action.classList.contains("busy")) paywall.action.textContent = label;
    } finally {
      busy = false;
      paywall.action.classList.remove("busy");
      controls.forEach(b => b.disabled = false);
    }
  }
  for (const b of buttons) b.onclick = () => run(b.dataset.billing);
  paywall.action.onclick = () => paywall.action.dataset.action && run(paywall.action.dataset.action);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && Object.keys(changes).some(k => k.startsWith("run:"))) showStop();
    if (area === "local" && changes.billingToken) run("refresh"); // signed in or out in another dashboard tab
  });
  window.addEventListener("focus", () => run("refresh"));
  run("refresh");
})();
