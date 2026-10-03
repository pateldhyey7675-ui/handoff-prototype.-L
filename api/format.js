// Vercel serverless function.
// Put this file at: api/format.js
// Set ANTHROPIC_API_KEY in Vercel's environment variables.
// The key never reaches the browser.

const SYSTEM = `You format EMS field notes into a structured pre-arrival handoff report for a receiving emergency department.

Rules, in order of importance:
1. Reorganize ONLY what the medic wrote. Never add information.
2. Do not infer or state a diagnosis. Do not add severity judgments. Do not recommend or comment on treatment.
3. Never invent a vital sign, a dose, a time, or a history item. If a field has no information in the notes, return an empty string for it.
4. Expand standard EMS abbreviations only where the meaning is unambiguous.
5. If the notes contain conflicting values (two different blood pressures, two ages), include both as written. Do not pick one.
6. If the notes describe more than one patient, put all of it in the fields as written rather than merging them into one patient.
7. A negative ("denies cardiac hx", "no allergies") stays a negative. Never convert it into a positive finding.
8. Crew names and unit identifiers belong in the unit field, never in patient fields.

Return JSON only. No preamble, no markdown fences. Exactly these keys:
unit, patient, mechanism, history, vitals, treatment, destination`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const notes = req.body && req.body.notes;
  if (!notes || typeof notes !== "string") {
    return res.status(400).json({ error: "notes required" });
  }
  if (notes.length > 4000) {
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
        max_tokens: 1000,
        system: SYSTEM,
        messages: [{ role: "user", content: "Field notes:\n\n" + notes }]
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error("anthropic error", r.status, detail);
      return res.status(502).json({ error: "upstream failed" });
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error("unparseable model output", text);
      return res.status(502).json({ error: "bad model output" });
    }

    const keys = ["unit","patient","mechanism","history","vitals","treatment","destination"];
    const out = {};
    for (const k of keys) {
      out[k] = typeof parsed[k] === "string" ? parsed[k] : "";
    }

    return res.status(200).json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
