// Vercel serverless function — ERrelay
// Path: api/format.js
// Env var: ANTHROPIC_API_KEY
//
// Field order and the completeness list come from an interview with an EMS
// lieutenant at Blair Volunteer Fire & Rescue (Washington County, NE), Oct 2026.

const SYSTEM = `You turn EMS field notes into a radio report for a receiving emergency department.

The notes arrive as timestamped lines (HH:MM then what the medic wrote). The medic reads the finished report aloud over the radio, so the script must sound like speech, not like a form.

THE ORDER (this service does not use MIST):
unit and transport code, patient age and gender, mental status, dispatch origin (home, care facility, workplace), chief complaint with onset time, critical assessment findings, medications and treatments given either by the crew or before their arrival, vitals (including the trend when the patient is unstable), ETA. Broselow tape for pediatric patients. If an alert type is set, the report leads with it.

RULES, in order of importance:
1. Use ONLY what the medic wrote. Never add information.
2. Do not infer or state a diagnosis. Do not add severity judgments. Do not recommend, question, or comment on treatment.
3. Never invent a vital sign, a dose, a time, or a history item. Leave it out rather than guess.
4. Expand standard EMS abbreviations only where unambiguous (csm -> circulation, sensation and motor; ra -> room air; hx -> history of; po -> by mouth; nc -> nasal cannula).
5. Each distinct set of vitals gets its own row, keyed to the timestamp of the note it came from. Never merge two sets of readings into one row, and never carry a value forward into a later row.
6. If the notes conflict (two ages, two different values at one time), include both as written. Do not pick one.
7. If more than one patient is described, say so in the complaint field rather than merging them.
8. A negative ("denies cardiac hx", "no allergies", "no LOC", "no rotation or shortening") stays a negative. Never convert it into a positive finding.
9. Crew names are not patient information. Leave them out of clinical fields.

THE SCRIPT:
One spoken paragraph in the order above. Natural radio phrasing, past tense for things already done. Do not include the alert type (the app prepends it). Close with the ETA and "any treatment concerns or questions?" only if an ETA is known. Aim for what a medic can say in about 30 seconds. Omit anything the notes do not contain — never substitute a placeholder.

Return JSON only. No preamble, no markdown fences:

{
  "patient": "short line for the header, e.g. '81 F · Right hip pain'. Empty string if age/sex not given.",
  "destination": "receiving facility if stated, else empty string",
  "script": "the spoken report",
  "mentalStatus": "",
  "origin": "",
  "complaint": "chief complaint with onset time",
  "findings": "critical assessment findings",
  "priorMeds": "home or pre-arrival medications, and the full medication list if given",
  "allergies": "",
  "homeOxygen": "only if the notes mention home oxygen",
  "broselow": "only if pediatric and stated",
  "eta": "",
  "vitals": [ { "time":"HH:MM", "bp":"", "hr":"", "rr":"", "spo2":"", "gcs":"", "glucose":"", "temp":"" } ],
  "treatment": [ { "time":"HH:MM", "text":"what the crew gave or did" } ]
}

Every field is a string; use "" where the notes say nothing. Do not write "unknown", "not recorded", or "N/A" — use an empty string, and the app will mark the gap itself.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const b = req.body || {};
  const notes = b.notes;
  if (!notes || typeof notes !== "string") {
    return res.status(400).json({ error: "notes required" });
  }
  if (notes.length > 6000) return res.status(400).json({ error: "notes too long" });

  const ctx = [
    b.unit      ? `Unit: ${String(b.unit).slice(0,40)}`   : "",
    b.code      ? `Transport code: ${String(b.code).slice(0,20)}` : "",
    b.alert     ? `Alert type: ${String(b.alert).slice(0,30)}`    : "",
    b.eta       ? `ETA: ${String(b.eta).slice(0,20)}`             : "",
    b.pediatric ? "Patient is pediatric (include Broselow if stated)" : ""
  ].filter(Boolean).join("\n");

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
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: (ctx ? "Call context:\n" + ctx + "\n\n" : "") + "Field notes:\n\n" + notes
        }]
      })
    });

    if (!r.ok) {
      console.error("anthropic error", r.status, await r.text());
      return res.status(502).json({ error: "upstream failed" });
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter(x => x.type === "text").map(x => x.text).join("")
      .replace(/```json|```/g, "").trim();

    let p;
    try { p = JSON.parse(text); }
    catch (e) {
      console.error("unparseable model output", text);
      return res.status(502).json({ error: "bad model output" });
    }

    const s = v => (typeof v === "string" ? v.trim() : "");
    const VK = ["time","bp","hr","rr","spo2","gcs","glucose","temp"];

    return res.status(200).json({
      patient:      s(p.patient),
      destination:  s(p.destination),
      script:       s(p.script),
      mentalStatus: s(p.mentalStatus),
      origin:       s(p.origin),
      complaint:    s(p.complaint),
      findings:     s(p.findings),
      priorMeds:    s(p.priorMeds),
      allergies:    s(p.allergies),
      homeOxygen:   s(p.homeOxygen),
      broselow:     s(p.broselow),
      eta:          s(p.eta),
      vitals: Array.isArray(p.vitals)
        ? p.vitals.slice(0, 12).map(row => {
            const o = {}; for (const k of VK) o[k] = s(row && row[k]); return o;
          }).filter(row => VK.some(k => row[k]))
        : [],
      treatment: Array.isArray(p.treatment)
        ? p.treatment.slice(0, 15)
            .map(t => ({ time: s(t && t.time), text: s(t && t.text) }))
            .filter(t => t.text)
        : []
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
