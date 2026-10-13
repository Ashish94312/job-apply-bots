// Answers to screening questions (ported from core.py). Loaded in job pages, the dashboard and the tests.
(function (JB) {
  const cache = new Map();

  /** The pattern as a case-insensitive regex, or null if it isn't a valid one. */
  function compile(pattern) {
    if (!cache.has(pattern)) {
      try {
        cache.set(pattern, new RegExp(pattern, "i"));
      } catch {
        cache.set(pattern, null);
      }
    }
    return cache.get(pattern);
  }

  /** The first answer whose pattern matches the question; empty answers mean "leave it for me". */
  function answerFor(label, answers) {
    for (const [pattern, answer] of answers || []) {
      if (answer == null || answer === "") continue;
      const re = compile(pattern);
      if (re && re.test(label || "")) return String(answer);
    }
    return null;
  }

  const badPatterns = answers => (answers || []).map(([pattern]) => pattern).filter(p => !p || !compile(p));

  /** The cover note with {title} and {company} filled in. */
  function coverNote(note, job) {
    note = (note || "").trim();
    if (job) note = note.replaceAll("{title}", job.title || "this role").replaceAll("{company}", job.company || "your company");
    return note;
  }

  /** For number boxes: "15 LPA" -> "15"; "+91 98765 43210" -> "919876543210". */
  function numberAnswer(answer) {
    if (/[a-z]/i.test(answer)) {
      const m = answer.match(/\d+(?:\.\d+)?/);
      return m ? m[0] : answer;
    }
    return answer.replace(/[^\d.]/g, "");
  }

  JB.answers = { answerFor, badPatterns, coverNote, numberAnswer };
})(globalThis.JB = globalThis.JB || {});
