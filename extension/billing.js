// The account panel of the billing edition: sign in with Google (the first sign-in starts a free trial), buy or
// extend a pass, sign out. Without an active trial or pass, only this panel, exporting and stopping runs stay open.
// The sign-in is kept in chrome.storage.local (never in a backup) and lasts while it's used.
(() => {
  const origin = globalThis.SENDOFF_BILLING_ORIGIN;
  if (!origin) return;
  const PRODUCT = "sendoff";
  const panel = document.querySelector("#billing");
  panel.hidden = false;
  const status = panel.querySelector("output");
  const who = panel.querySelector("#billing-account");
  const buttons = [...panel.querySelectorAll("[data-billing]")];
  const button = name => buttons.find(b => b.dataset.billing === name);
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const nonce = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  const { local, session } = chrome.storage;
  const day = seconds => new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const price = offer => `₹${(offer.paise / 100).toFixed(offer.paise % 100 ? 2 : 0)} for ${offer.days} days`;

  const exportButton = panel.querySelector("#billing-export");
  function lock(locked) {
    document.querySelectorAll("main, .side .nav, .side .sites").forEach(node => {
      node.inert = locked;
      node.hidden = locked;
    });
    exportButton.hidden = !locked; // the dashboard's own Export is in what's hidden
  }
  lock(true);
  exportButton.onclick = () => document.getElementById("export").click();

  const stopButton = panel.querySelector("#billing-stop");
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

  function show(...names) {
    for (const b of buttons) b.hidden = !names.includes(b.dataset.billing);
  }

  let expiryTimer;
  async function refresh() {
    clearTimeout(expiryTimer);
    const response = await authed(`/access?product=${PRODUCT}`);
    if (!response) {
      lock(true);
      show("signin");
      who.hidden = true;
      status.textContent = "Sign in with Google to use Sendoff, or to restore a pass you bought.";
      const { trial_days: trial } = await call(`/offer?product=${PRODUCT}`).then(r => r.json()).catch(() => ({}));
      if (trial) status.textContent = `Sign in with Google to start your ${trial}-day free trial, or to restore a pass you bought.`;
      return;
    }
    const access = await response.json();
    const now = Date.now() / 1000;
    const active = access.expires > now;
    await session.set({ billingAccess: { expires: access.expires, checked: Date.now() } }); // for the worker
    who.hidden = !access.email;
    who.textContent = "Signed in as " + access.email;
    const offer = access.offer ? price(access.offer) : "";
    if (active && access.trial) status.textContent = `Free trial until ${day(access.expires)}.${offer ? ` After that, a pass is ${offer}.` : ""}`;
    else if (active) status.textContent = `Pass valid until ${day(access.expires)}.`;
    else {
      const ended = !access.expires ? "No active pass." : `Your ${access.trial ? "free trial" : "pass"} ended on ${day(access.expires)}.`;
      status.textContent = `${ended} ${offer ? `A pass is ${offer}.` : "Purchases are paused right now."}`;
    }
    button("upgrade").textContent = active && !access.trial ? "Extend pass" : "Buy pass";
    show(...(access.offer ? ["upgrade"] : []), "refresh", "logout");
    lock(!active);
    if (active) expiryTimer = setTimeout(() => run("refresh"), Math.min((access.expires - now) * 1000 + 1000, 3600000));
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

  let busy = false;
  async function run(action) {
    if (busy) return;
    busy = true;
    buttons.forEach(b => b.disabled = true);
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
    } finally {
      busy = false;
      buttons.forEach(b => b.disabled = false);
    }
  }
  for (const b of buttons) b.onclick = () => run(b.dataset.billing);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && Object.keys(changes).some(k => k.startsWith("run:"))) showStop();
    if (area === "local" && changes.billingToken) run("refresh"); // signed in or out in another dashboard tab
  });
  window.addEventListener("focus", () => run("refresh"));
  run("refresh");
})();
