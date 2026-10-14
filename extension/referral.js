// Asking people at a company for a referral, on LinkedIn (ported from linkedin/referral.py). Runs in the
// background worker as the "refer" action; the page work is in sites/linkedin.js.
//
// For each job applied to recently (plus any job link in the settings) it opens the company's page, searches its
// employees among your 1st and 2nd-degree connections (alumni of your college first), and then:
//   - people you're already connected with get the referral message right away;
//   - the others get a connection invite (with a short note while LinkedIn still allows you notes), and get the
//     referral message on a later run, once they've accepted.
// A few people per company, a daily cap, and nobody is contacted twice.
(function (JB) {
  const BASE = "https://www.linkedin.com";
  const MESSAGED = "messaged";
  const INVITED = "invited";
  const EXPIRED = "not_accepted";
  const FAILED = "failed";
  const TITLES = new Set(["dr", "mr", "mrs", "ms", "er", "ca", "prof"]);

  /** Stop asking for now (a LinkedIn limit), keeping what's been done. */
  const halt = message => Object.assign(new Error(message), { stopReferrals: message });
  const firstLine = e => String((e && e.message) || e).split("\n")[0];
  const indent = text => text.split("\n").map(line => `      ${line}`).join("\n");

  function slugOf(url) {
    const m = /\/in\/([^/?#]+)/.exec(url || "");
    return m ? decodeURIComponent(m[1]).toLowerCase() : "";
  }

  function firstName(name) {
    const words = name.replace(/[^\p{L}\p{N}_\s.'-]/gu, " ").split(/\s+/).filter(w => w && !TITLES.has(w.toLowerCase().replace(/\.+$/, "")));
    const first = words[0] || "there";
    const lower = first === first.toLowerCase() && first !== first.toUpperCase();
    const upper = first === first.toUpperCase() && first !== first.toLowerCase();
    return lower || upper ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : first;
  }

  /** The message with {first_name}, {name}, {company}, {title} and {job_url} filled in. */
  function render(template, name, job) {
    let text = (template || "").trim();
    for (const [key, value] of [["first_name", firstName(name)], ["name", name], ["company", job.company || "your company"],
      ["title", job.title || "the open role"], ["job_url", job.url]]) text = text.replaceAll(`{${key}}`, value);
    return text;
  }

  // Python's quote(safe=""): everything but letters, digits and _.-~ is escaped.
  const quote = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  /** A people search among your 1st and 2nd-degree connections at the company. */
  function peopleUrl(ids, keywords) {
    const params = [["currentCompany", JSON.stringify(ids)], ["network", JSON.stringify(["F", "S"])], ["keywords", keywords], ["origin", "FACETED_SEARCH"]];
    return `${BASE}/search/results/people/?${params.map(([k, v]) => `${k}=${quote(v)}`).join("&")}`;
  }

  async function run(r, cfg) {
    const rc = cfg.referral || {};
    if (!(rc.message || "").trim()) {
      r.log("Write the referral message in Settings > Sites > LinkedIn first.");
      return;
    }
    if (!r.dry && /<[^<>\n]+>/.test(rc.message)) {
      r.log("The referral message still has a <...> placeholder. Write that part in Settings, then run again.");
      return;
    }
    let budget = r.opts.max || rc.maxPerRun || 8;
    const perDay = rc.maxPerDay ?? 15;
    if (!r.dry) {
      budget = Math.min(budget, perDay - (await JB.store.sentToday()));
      if (budget <= 0) {
        r.log(`Daily limit reached (${perDay} messages + invites).`);
        return;
      }
    }
    const state = { notesUsedUp: false, dryAsked: {} }; // dryAsked: company -> people a dry run would have asked
    let sent = 0;
    try {
      sent += await followUp(r, rc, budget, state);
      const forJobs = rc.forJobs && rc.forJobs.length ? rc.forJobs : ["applied"];
      const jobs = [...(await JB.store.jobsToAsk("linkedin", forJobs, rc.withinDays ?? 14)), ...(await extraJobs(r, rc))];
      r.log();
      r.log(`${jobs.length} job(s) to ask about.`);
      for (const job of jobs) {
        if (sent >= budget) break;
        try {
          sent += await askAtCompany(r, rc, job, budget - sent, state);
        } catch (e) {
          if (e.stopReferrals || r.isStop(e)) throw e;
          r.log(`  x ${firstLine(e)}`);
        }
      }
    } catch (e) {
      if (!e.stopReferrals) throw e;
      r.log();
      r.log(e.stopReferrals);
    }
    r.log();
    r.log(`Done: ${r.dry ? "would contact" : "contacted"} ${sent}.`);
  }

  async function extraJobs(r, rc) {
    const jobs = [];
    for (const url of rc.jobs || []) {
      const m = JB.sites.linkedin.jobUrlRe.exec(url || "");
      if (!m) r.log(`Not a LinkedIn job link, skipped: ${url}`);
      else if (!(await JB.store.askedAbout(m[1]))) jobs.push({ url: `${BASE}/jobs/view/${m[1]}/`, jobId: m[1], title: "", company: "" });
    }
    return jobs;
  }

  /** Find people at the job's company and contact up to perCompany of them. Returns how many. */
  async function askAtCompany(r, rc, job, budget, state) {
    const finish = async (status, note = "") => {
      if (!r.dry) await JB.store.jobDone(job, status, note);
    };
    r.step(`Finding people to ask at ${job.company || "the company"}`);
    await r.goto(job.url);
    if (!(await r.waitFor(JB.sites.linkedin.jobReadyCss, 15000))) {
      r.log();
      r.log(job.url);
      r.log("  x couldn't open the job");
      return 0;
    }
    await r.sleep(2000);
    job = { ...job, ...(await r.exec("site.readJob")) };
    const companyUrl = await r.exec("site.companyUrl");
    r.log();
    r.log(`${job.title || "?"} @ ${job.company || "?"}  ${job.url}`);
    if (!companyUrl) {
      r.log("  - the job doesn't link to a LinkedIn company page");
      await finish("no_company");
      return 0;
    }
    const asked = (await JB.store.askedAt(companyUrl)) + (state.dryAsked[companyUrl] || 0);
    const want = (rc.perCompany ?? 2) - asked;
    if (want <= 0) {
      r.log(`  = already asked ${asked} people at ${job.company}`);
      await finish("already_asked");
      return 0;
    }
    const ids = await companyIds(r, companyUrl);
    if (!ids.length) {
      r.log(`  - couldn't find ${job.company}'s employee list on ${companyUrl}`);
      await finish("no_employee_list");
      return 0;
    }
    const people = await findPeople(r, ids, rc, want);
    if (!people.length) {
      r.log("  - nobody there among your 1st and 2nd-degree connections");
      await finish("nobody_found");
      return 0;
    }

    let sent = 0;
    for (const person of people.slice(0, want * 3)) { // don't open every profile if several don't work out
      if (sent >= Math.min(want, budget)) break;
      if (await contact(r, rc, person, job, companyUrl, state)) sent++;
    }
    if (r.dry) state.dryAsked[companyUrl] = (state.dryAsked[companyUrl] || 0) + sent;
    if (sent < want && sent >= budget) return sent; // out of today's budget: this company gets the rest next run
    await finish(sent ? "asked" : "nobody_reached", `${sent} contacted`);
    return sent;
  }

  async function companyIds(r, companyUrl) {
    await r.goto(companyUrl);
    if (!(await r.waitForTrue("site.hasCompanyIds", 15000))) return [];
    return r.exec("site.companyIds");
  }

  async function searchPeople(r, ids, keywords) {
    await r.goto(peopleUrl(ids, keywords));
    await r.waitForTrue("site.peopleReady", 15000);
    await r.sleep(1500);
    if (await r.exec("site.searchLimit")) throw halt("LinkedIn's monthly limit on people searches is reached. Referrals can go on when it resets.");
    return (await r.exec("site.people")).map(p => ({ profile: `${BASE}/in/${p.slug}/`, name: p.name, headline: p.headline, degree: p.degree }));
  }

  /** Candidates at the company: people you're connected with first, then alumni of `school`, then the rest. */
  async function findPeople(r, ids, rc, want) {
    const searches = [...(rc.school ? [rc.school] : []), ...(rc.peopleKeywords && rc.peopleKeywords.length ? rc.peopleKeywords : ["engineer"])];
    const skip = rc.skipHeadline || [];
    const found = new Map();
    for (const [rank, keywords] of searches.entries()) {
      for (const p of await searchPeople(r, ids, keywords)) {
        if (found.has(p.profile) || (await JB.store.knownContact(p.profile)) || p.degree.startsWith("3")) continue;
        if (skip.some(word => JB.filters.hasWord(p.headline, word))) continue;
        found.set(p.profile, { ...p, rank });
      }
      if (found.size >= want * 3) break; // plenty; save LinkedIn's search allowance
    }
    return [...found.values()].sort((a, b) => (a.degree !== "1st") - (b.degree !== "1st") || a.rank - b.rank);
  }

  /** Message them if you're connected, else send an invite. Returns true if sent (or, in a dry run, would be). */
  async function contact(r, rc, person, job, companyUrl, state, onlyMessage = false) {
    r.step(`Opening ${person.name}'s profile`);
    await r.goto(person.profile);
    if (!(await r.waitForTrue("site.profileReady", 15000))) {
      r.log(`  x couldn't open ${person.name}'s profile`);
      return false;
    }
    await r.sleep(2000);
    const info = await r.exec("site.profileInfo");
    const profile = info.slug ? `${BASE}/in/${info.slug}/` : person.profile;
    if (!onlyMessage && profile !== person.profile && (await JB.store.knownContact(profile))) return false;
    const name = info.name || person.name;
    if (job.company && !info.main.toLowerCase().includes(job.company.toLowerCase())) {
      r.log(`  - ${name}: their profile doesn't mention ${job.company}, skipped`);
      return false;
    }
    const connected = info.degree === "1st";
    if (onlyMessage && !connected) return false;
    if (!connected && state.notesUsedUp && rc.inviteWithoutNote === false) return false;

    const who = { profile: onlyMessage ? person.profile : profile, name, headline: person.headline }; // follow-ups update their row
    const note = connected || state.notesUsedUp ? "" : render(rc.connectNote, name, job);
    const text = connected ? render(rc.message, name, job) : note;
    const verb = connected ? "Message" : "Invite";
    r.log(`  ${name}: ${(person.headline || "").slice(0, 80) || "?"} (${connected ? "connected" : "not connected yet"})`);
    if (r.dry) {
      r.log(`  ~ would ${verb.toLowerCase()} ${name}${text ? `:\n${indent(text)}` : " (no note)"}`);
      if (note && note.length > 300) r.log(`    (this note is ${note.length} characters; LinkedIn allows 300, so the end would be cut)`);
      r.event({ kind: "contact", status: connected ? "would_message" : "would_invite", name, company: job.company, title: job.title, url: who.profile });
      return true;
    }
    if (r.opts.confirm || rc.sendMode !== "direct") { // you see who it goes to and the exact text, unless you chose otherwise
      const yes = await r.ask("Send this?", `${verb} ${name}${text ? `\n\n${text}` : " (no note)"}`, [["Send", "y", "primary"], ["Skip", "n"], ["Stop run", "stop", "stop"]]);
      if (yes !== "y") return false;
    }

    let ok;
    let result;
    let status;
    if (connected) {
      r.step(`Messaging ${name}`);
      [ok, result] = await sendMessage(r, text);
      status = MESSAGED;
    } else {
      r.step(`Inviting ${name} to connect`);
      [ok, result] = await sendInvite(r, name, note, rc, state);
      status = INVITED;
      if (ok === null) return false; // notes used up and invites without one are off
    }
    await JB.store.saveContact(who, job, companyUrl, ok ? status : FAILED, result);
    r.log(`  ${ok ? "+" : "x"} ${(ok ? status : FAILED).padEnd(13)} ${name}  ${result}`);
    r.event({ kind: "contact", status: ok ? status : FAILED, name, company: job.company, title: job.title, url: who.profile, note: result });
    return ok;
  }

  /** Send the referral message to people who accepted the invite since the last run. Returns how many. */
  async function followUp(r, rc, budget, state) {
    const pending = await JB.store.pendingInvites();
    if (!pending.length) return 0;
    r.log();
    r.log(`Checking which of ${pending.length} invite(s) were accepted...`);
    r.step("Checking which invites were accepted");
    await r.goto(`${BASE}/mynetwork/invite-connect/connections/`);
    if (!(await r.waitForTrue("site.connectionsReady", 15000))) {
      r.log("  Couldn't read your connections list; will check next run.");
      return 0;
    }
    const accepted = new Set(await r.exec("site.connectionSlugs", 3));
    let sent = 0;
    for (const c of pending) {
      const person = { profile: c.profile, name: c.name, headline: c.headline };
      const job = { url: c.jobUrl, jobId: c.jobId, title: c.title, company: c.company };
      if (!accepted.has(slugOf(c.profile))) {
        const days = rc.inviteExpiryDays ?? 21;
        if (c.age >= days && !r.dry) await JB.store.saveContact(person, job, c.companyUrl, EXPIRED, `not accepted in ${days} days`);
        continue;
      }
      if (sent >= budget) break;
      if (await contact(r, rc, person, job, c.companyUrl, state, true)) sent++;
    }
    return sent;
  }

  async function sendMessage(r, text) {
    if (!(await r.exec("site.openMessage"))) return [false, "no Message button"];
    if (!(await r.waitForTrue("site.messageBoxReady", 10000))) return [false, "the message box didn't open"];
    await r.exec("site.typeMessage", text);
    await r.sleep(800);
    if (!(await r.exec("site.sendMessageNow"))) return [false, "no Send button in the chat"];
    await r.sleep(2500);
    const ok = await r.exec("site.messageBoxEmpty");
    await r.exec("site.closeChat");
    return [ok, ok ? "" : "the message may not have been sent"];
  }

  async function checkInviteLimit(r) {
    if (await r.exec("site.inviteLimit")) {
      await r.exec("site.escape");
      throw halt("LinkedIn's weekly invitation limit is reached. Invites can go on next week.");
    }
  }

  /** Returns [ok, note]; ok is null if it was left alone because notes are used up. */
  async function sendInvite(r, name, note, rc, state) {
    if (!(await r.exec("site.openInvite", name))) {
      return (await r.exec("site.pending")) ? [true, "an invite was already pending"] : [false, "no Connect button (they may only allow follows)"];
    }
    await r.sleep(1500);
    await checkInviteLimit(r);
    if (await r.exec("site.inviteWantsEmail")) {
      await r.exec("site.escape");
      return [false, "LinkedIn wants their email address to connect"];
    }
    let withNote = false;
    if (note) {
      const got = await r.exec("site.addNote", note);
      if (got.added) {
        withNote = true;
      } else if (got.premium) { // a Premium offer instead of a note box: this month's free notes are used up
        state.notesUsedUp = true;
        r.log("  LinkedIn's free invitation notes are used up for this month; invites go without a note now.");
        await r.exec("site.escape");
        await r.sleep(800);
        if (rc.inviteWithoutNote === false) {
          await r.exec("site.escape");
          return [null, ""];
        }
        if (!(await r.exec("site.hasDialog")) && !(await r.exec("site.openInvite", name))) return [false, "no Connect button after closing the Premium offer"];
      }
    }
    if (!(await r.exec("site.sendInvite", withNote))) {
      await r.exec("site.escape");
      return [false, "no Send button in the invite dialog"];
    }
    await r.sleep(2500);
    await checkInviteLimit(r);
    if (await r.exec("site.inviteSent")) return [true, withNote ? "with a note" : "without a note"];
    return [false, "couldn't confirm the invite was sent"];
  }

  JB.referral = { run, render, firstName, peopleUrl, slugOf };
})(globalThis.JB = globalThis.JB || {});
