// Applications: what happened after applying. Every job the bot (or you, by hand) applied to is in it on its own, from
// the history; what you add about one (their reply, its rounds, how it ended) is kept in chrome.storage.local "track"
// under the history's own "site:jobId" key, apart from the history so a re-run never overwrites it. Ones you add
// yourself are "manual:<id>". Plain logic, shared by the dashboard, the background worker and the tests.
(function (JB) {
  const KINDS = [["call", "Recruiter call"], ["interview", "Interview"], ["assignment", "Assignment"], ["hr", "HR"], ["other", "Other"]];
  const VIA = [["email", "Email"], ["call", "Call"], ["site", "Site message"], ["linkedin", "LinkedIn"], ["referral", "Referral"], ["other", "Other"]];
  const OUTCOMES = [["offer", "Offer"], ["accepted", "Accepted"], ["declined", "Declined"], ["rejected", "Rejected"], ["withdrawn", "Withdrew"], ["ghosted", "Ghosted"]];
  const ROUND_STATUSES = ["planned", "scheduled", "given", "cleared", "not_cleared", "missed"];
  /** How a round's status reads: [for a round, for an assignment]. */
  const ROUND_WORDS = {
    planned: ["Not yet", "Not yet"], scheduled: ["Scheduled", "To do"], given: ["Given", "Submitted"],
    cleared: ["Cleared", "Cleared"], not_cleared: ["Not cleared", "Not cleared"], missed: ["Missed", "Not done"],
  };
  const OPEN = ["planned", "scheduled", "given"]; // a round that isn't over
  const REPLIED = ["offer", "accepted", "declined", "rejected"]; // endings that mean they answered
  const OFFERED = ["offer", "accepted", "declined"];

  const DEFAULTS = {
    quietDays: 21,
    countOld: false,
    templates: [
      { name: "Startup", rounds: [["call", "Recruiter call"], ["assignment", "Take-home"], ["interview", "Technical"], ["interview", "Founder chat"]] },
      { name: "Product company", rounds: [["call", "Recruiter screen"], ["interview", "Coding"], ["interview", "System design"], ["interview", "Hiring manager"], ["hr", "HR"]] },
      { name: "Service company", rounds: [["assignment", "Online test"], ["interview", "Technical"], ["hr", "HR"]] },
    ],
  };

  /** The Applications settings, with anything missing from the defaults. No templates is a choice, kept. */
  const settings = t => ({ ...DEFAULTS, ...(t || {}), templates: Array.isArray(t?.templates) ? t.templates : DEFAULTS.templates });

  const word = (list, key) => (list.find(([k]) => k === key) || [key, key])[1];
  const roundWord = r => (ROUND_WORDS[r.status] || [r.status, r.status])[r.kind === "assignment" ? 1 : 0];

  /** "2026-10-24", "2026-10-24 14:03:11" or "2026-10-24T14:03" as a local Date; null if it isn't one. */
  function toDate(s) {
    if (!s) return null;
    s = String(s).replace(" ", "T");
    const d = new Date(s.length === 10 ? `${s}T00:00` : s);
    return isNaN(d) ? null : d;
  }
  const daysSince = (s, now = Date.now()) => {
    const d = toDate(s);
    return d ? Math.floor((now - d.getTime()) / 86400000) : null;
  };

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const newRound = (kind = "interview", name = "") => ({ id: newId(), kind, name, at: "", due: "", status: "planned", note: "" });
  const fromTemplate = template => template.rounds.map(([kind, name]) => newRound(kind, name));

  const BLANK = { heard: null, rounds: [], outcome: null, notes: "", log: [], old: false };

  /** Every application: each job in the history that was applied to, with what's tracked about it, and the ones
   * you added. Ones you removed are left out. */
  function list(jobs, track) {
    const out = {};
    for (const r of Object.values(jobs || {})) {
      if (r.status !== "applied" && r.status !== "already_applied") continue;
      const key = `${r.site}:${r.jobId}`;
      out[key] = {
        ...BLANK, key, site: r.site, jobId: r.jobId, title: r.title, company: r.company, url: r.url, appliedAt: r.ts,
        source: r.note === "finished by hand" ? "self" : "bot", old: r.status === "already_applied", updated: r.ts,
      };
    }
    for (const t of Object.values(track || {})) out[t.key] = { ...BLANK, ...out[t.key], ...t };
    return Object.values(out).filter(a => !a.hidden);
  }

  /** Where it stands: waiting, quiet, heard, rounds, or how it ended (offer, accepted, rejected, ...). */
  function stage(a, quietDays = DEFAULTS.quietDays, now = Date.now()) {
    if (a.outcome) return a.outcome;
    if (a.rounds.length) return "rounds";
    if (a.heard) return "heard";
    return daysSince(a.appliedAt, now) > quietDays ? "quiet" : "waiting";
  }
  const GROUPS = { waiting: "waiting", quiet: "quiet", heard: "active", rounds: "active", offer: "active" };
  const group = st => GROUPS[st] || "closed";

  /** The round that's on now: the first that isn't over, else the last one. */
  const current = a => a.rounds.find(r => OPEN.includes(r.status)) || a.rounds[a.rounds.length - 1] || null;

  /** What's next for it, or null. Types: round (an interview booked, `at` when), due (an assignment to hand in),
   * plan (a round with no date yet), result (waiting to hear how one went), more (every round so far went well),
   * end (one didn't: say how it ended), setup (they replied, no rounds yet), reply (an offer to answer). */
  function next(a, quietDays, now = Date.now()) {
    const st = stage(a, quietDays, now);
    if (st === "offer") return { type: "reply", at: null };
    if (st === "heard") return { type: "setup", at: null };
    if (st !== "rounds") return null;
    const r = current(a);
    if (r.status === "planned") return { type: "plan", at: null, round: r };
    if (r.status === "scheduled") return r.kind === "assignment" ? { type: "due", at: toDate(r.due), round: r } : { type: "round", at: toDate(r.at), round: r };
    if (r.status === "given") return { type: "result", at: null, round: r, days: daysSince(r.changed || r.at, now) };
    return { type: r.status === "cleared" ? "more" : "end", at: null, round: r };
  }

  const heardBack = a => !!a.heard || a.rounds.length > 0 || REPLIED.includes(a.outcome);
  const hadRound = a => a.rounds.some(r => r.status !== "planned");
  const gotOffer = a => OFFERED.includes(a.outcome);

  /** The figures: of these applications, how many heard back, had a round, got an offer; replies by site and
   * with or without a referral asked (`asked`: keys of the jobs asked about). */
  function figures(apps, asked = new Set()) {
    const n = apps.length;
    const heard = apps.filter(heardBack);
    const rounds = apps.filter(hadRound);
    const offers = apps.filter(gotOffer);
    const sites = {};
    for (const a of apps) {
      const s = (sites[a.site] = sites[a.site] || { n: 0, heard: 0 });
      s.n++;
      if (heardBack(a)) s.heard++;
    }
    const withRef = apps.filter(a => asked.has(a.key));
    const ended = {};
    for (const a of apps) if (a.outcome && !OFFERED.includes(a.outcome)) ended[a.outcome] = (ended[a.outcome] || 0) + 1;
    return {
      applied: n, bot: apps.filter(a => a.source === "bot").length, heard: heard.length, rounds: rounds.length, offers: offers.length,
      sites, ended,
      referral: { n: withRef.length, heard: withRef.filter(heardBack).length, otherN: n - withRef.length, otherHeard: heard.length - withRef.filter(heardBack).length },
    };
  }

  /** One change to an application, as the dashboard sends it:
   * set: fields to replace (outcome, notes, hidden) · heard: fields of the reply to change (null: no reply)
   * round: one round's id and the fields to change (a new id adds it) · rounds: rounds to add at the end
   * drop: a round's id to remove · move: { id, by: -1 or 1 } */
  function change(a, c) {
    a = { ...a, rounds: [...(a.rounds || [])] };
    if (c.set) Object.assign(a, c.set);
    if (c.heard !== undefined) a.heard = c.heard === null ? null : { ...(a.heard || {}), ...c.heard };
    if (c.round) {
      const i = a.rounds.findIndex(r => r.id === c.round.id);
      if (i < 0) a.rounds.push({ ...newRound(), ...c.round });
      else a.rounds[i] = { ...a.rounds[i], ...c.round };
    }
    if (c.rounds) a.rounds.push(...c.rounds);
    if (c.drop) a.rounds = a.rounds.filter(r => r.id !== c.drop);
    if (c.move) {
      const i = a.rounds.findIndex(r => r.id === c.move.id);
      const j = i + c.move.by;
      if (i >= 0 && j >= 0 && j < a.rounds.length) [a.rounds[i], a.rounds[j]] = [a.rounds[j], a.rounds[i]];
    }
    return a;
  }

  // What a site says about an application, in the text of its card among the jobs you applied to; most telling first.
  const REPLY_SIGNALS = [
    ["rejected", /\bnot (been )?(selected|shortlisted)\b|no longer (being )?considered|\brejected\b|decided (not )?to (move forward|proceed) with other|(position|role) (has been )?filled|application (was |has been )?declined/i],
    ["replied", /\bshortlisted\b|\binterview|recruiter (action|contacted|reached out|messaged|has (contacted|messaged))|assessment (sent|invite)|(a |new )?message from (the )?(recruiter|employer|hiring)/i],
    ["viewed", /application viewed|viewed (by (the )?(employer|recruiter|company)|your application)|resume (was )?(downloaded|viewed)|profile (was )?viewed by/i],
  ];

  /** "rejected", "replied" (shortlisted, an interview, the recruiter got in touch), "viewed", or null. */
  const replySignal = text => (REPLY_SIGNALS.find(([, re]) => re.test(text || "")) || [null])[0];

  /** The change a site's word makes to an application (see change), and its timeline note; null when it changes
   * nothing: said before, or what you've noted already goes further. */
  function fromSite(a, signal, label, today) {
    if (!signal || (a.signals || {})[signal]) return null;
    const signals = { ...(a.signals || {}), [signal]: today };
    if (signal === "rejected") {
      return a.outcome ? null : [{ set: { signals, outcome: "rejected" } }, `${label} says: not selected`];
    }
    if (signal === "replied") {
      return a.heard || a.rounds.length || a.outcome ? [{ set: { signals } }, null]
        : [{ set: { signals }, heard: { at: today, via: "site", who: "" } }, `${label} says they got in touch`];
    }
    return [{ set: { signals, viewed: today } }, `${label} says: application viewed`];
  }

  /** A calendar file (.ics) for a round with a time: an hour long, in UTC. */
  function ics(a, r, now = new Date()) {
    const start = toDate(r.at);
    const stamp = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const text = s => String(s).replace(/[\\;,]/g, m => `\\${m}`).replace(/\r?\n/g, "\\n");
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sendoff//Applications//EN", "BEGIN:VEVENT",
      `UID:${a.key}-${r.id}@sendoff`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(new Date(start.getTime() + 3600000))}`,
      `SUMMARY:${text(`${r.name || word(KINDS, r.kind)}: ${[a.title, a.company].filter(Boolean).join(" at ")}`)}`,
      `DESCRIPTION:${text([r.note, a.url].filter(Boolean).join("\n"))}`,
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
  }

  JB.tracker = {
    KINDS, VIA, OUTCOMES, ROUND_STATUSES, DEFAULTS, settings, word, roundWord, toDate, daysSince, newId, newRound,
    fromTemplate, list, stage, group, current, next, heardBack, hadRound, gotOffer, figures, change, ics, replySignal, fromSite,
  };
})(globalThis.JB = globalThis.JB || {});
