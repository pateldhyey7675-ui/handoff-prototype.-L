// Vercel serverless function — ERrelay
// Path: api/format.js
// Env var: ANTHROPIC_API_KEY

const SYSTEM = `You format EMS field notes into a MIST pre-arrival handoff report for a receiving emergency department.

The notes arrive as timestamped lines (HH:MM followed by what the medic wrote).

Rules, in order of importance:
1. Reorganize ONLY what the medic wrote. Never add information.
2. Do not infer or state a diagnosis. Do not add severity judgments. Do not recommend, question, or comment on treatment.
3. Never invent a vital sign, a dose, a time, or a history item. Leave it out rather than guess.
4. Expand standard EMS abbreviations only where the meaning is unambiguous (asa 324 po -> Aspirin 324 mg by mouth; o2 2L nc -> Oxygen 2 L by nasal cannula; hx htn -> hypertension).
5. Each distinct set of vitals gets its own row, keyed to the timestamp of the note it came from. Never merge two sets of readings into one row. Never carry a value forward into a later row.
6. If notes conflict (two ages, two different values at the same time), include both as written. Do not pick one.
7. If more than one patient is described, say so in the complaint field rather than merging them.
8. A negative ("denies cardiac hx", "no allergies", "no LOC") stays a negative. Never convert it into a positive finding.
9. Crew names and unit identifiers are not patient information. Leave them out of the clinical fields.

Return JSON only. No preamble, no markdown fences. This exact shape:

{
  "patient": "short one-line summary, e.g. 'Patient 1 · 64 M · Chest pain'. Empty string if age/sex/complaint not given.",
  "destination": "receiving facility if stated, else empty string",
  "complaint": "the M of MIST: mechanism or medical complaint, in prose",
  "history": "the I of MIST: history, medications, allergies, in prose",
  "vitals": [ { "time":"HH:MM", "bp":"", "hr":"", "rr":"", "spo2":"", "gcs":"", "glucose":"" } ],
  "treatment": [ { "time":"HH:MM", "text":"what was given or done" } ],
  "notEntered": ["short names of standard fields with no data in the notes"]
}

Every vitals and treatment field is a string; use "" for anything not recorded. notEntered lists only genuinely standard handoff items the notes never mention (for example "Glucose", "Allergies", "ETA"). Keep it to at most six entries.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const notes = req.body && req.body.notes;
  if (!notes || typeof notes !== "string") {
    return res.status(400).json({ error: "notes required" });
  }
  if (notes.length > 6000) {
    return res.status(400).json({ error: "notes too long" });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1600,
        system: SYSTEM,
        messages: [{ role: "user", content: "Field notes:\n\n" + notes }]
      })
    });

    if (!r.ok) {
      console.error("anthropic error", r.status, await r.text());
      return res.status(502).json({ error: "upstream failed" });
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    let p;
    try { p = JSON.parse(text); }
    catch (e) {
      console.error("unparseable model output", text);
      return res.status(502).json({ error: "bad model output" });
    }

    const str = v => (typeof v === "string" ? v : "");
    const vitalKeys = ["time","bp","hr","rr","spo2","gcs","glucose"];

    const out = {
      patient:     str(p.patient),
      destination: str(p.destination),
      complaint:   str(p.complaint),
      history:     str(p.history),
      vitals: Array.isArray(p.vitals)
        ? p.vitals.slice(0, 12).map(row => {
            const o = {};
            for (const k of vitalKeys) o[k] = str(row && row[k]);
            return o;
          }).filter(row => vitalKeys.some(k => row[k]))
        : [],
      treatment: Array.isArray(p.treatment)
        ? p.treatment.slice(0, 15)
            .map(t => ({ time: str(t && t.time), text: str(t && t.text) }))
            .filter(t => t.text)
        : [],
      notEntered: Array.isArray(p.notEntered)
        ? p.notEntered.slice(0, 6).map(str).filter(Boolean)
        : []
    };

    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
