// The extension's background worker: runs the bots (engine.js) and takes requests from the dashboard.
importScripts(
  "lib/defaults.js", "lib/filters.js", "lib/answers.js", "lib/store.js",
  "sites/hirist.js", "sites/instahyre.js", "sites/wellfound.js", "sites/cutshort.js", "sites/linkedin.js",
  "engine.js", "referral.js",
);

const DASHBOARD = chrome.runtime.getURL("dashboard.html");

async function openDashboard() {
  const [open] = await chrome.tabs.query({ url: DASHBOARD });
  if (open) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD });
  }
}

chrome.action.onClicked.addListener(openDashboard);
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  for (let tries = 0; tries < 10; tries++) {
    try {
      return await openDashboard();
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000)); // installed as Chrome starts: no window yet
    }
  }
});

const handlers = {
  start: m => JB.engine.start(m.site, m.action, m.opts),
  stop: m => JB.engine.stop(m.site),
  answer: m => JB.engine.answer(m.site, m.id, m.value),
  forget: async m => ({ count: await JB.store.forget(m.site, m.status) }),
  import: async m => {
    if (m.settings) await JB.store.saveSettings(m.settings);
    for (const [key, found] of Object.entries(m.cache || {})) { // e.g. Cutshort skill ids the Python bot looked up
      if (!key.startsWith("cache:") || !found || typeof found !== "object") continue;
      const have = (await chrome.storage.local.get(key))[key] || {};
      await chrome.storage.local.set({ [key]: { ...found, ...have } });
    }
    const people = await JB.store.importReferrals(m.contacts, m.referralJobs);
    return { added: await JB.store.importHistory(m.history), people };
  },
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only the extension's own pages; never a content script running inside a job site.
  if (sender.id !== chrome.runtime.id || !(sender.url || "").startsWith(chrome.runtime.getURL(""))) return false;
  const handler = handlers[message && message.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message))
    .then(result => reply({ ok: true, ...(result || {}) }), e => reply({ error: String((e && e.message) || e) }));
  return true; // reply comes later
});

JB.engine.markInterrupted();
