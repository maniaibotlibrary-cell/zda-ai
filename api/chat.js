// ZDA AI Assistant - backend (Vercel serverless function)
// Ye file Gemini ko sawal bhejti hai. API key yahin server par rehti hai,
// users ko kabhi nazar nahi aati.

const MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-flash-latest',
].filter(Boolean);

const SYSTEM_PROMPT =
  'Tum "ZDA AI Assistant" ho, ek madadgar, dostana aur sachcha AI assistant. ' +
  'Jis zabaan mein user likhe usi mein jawab do: Urdu (Urdu script), Roman Urdu ya English. ' +
  'Agar user Roman Urdu mein likhe to Roman Urdu mein jawab do. ' +
  'Jawab saaf, aasan aur mukhtasir rakho. Zaroorat ho to chhoti list ya steps do. ' +
  'Agar kisi baat ka pata na ho to saaf bata do, andaza mat lagao.';

const MODE_HINTS = {
  write: 'Abhi user likhne ya edit karne mein madad chahta hai (text, khat, content). Behtareen likhai do.',
  explore: 'Abhi user naye khayalat aur brainstorming chahta hai. Kai alag alag aur dilchasp options do.',
  code: 'Abhi user coding mein madad chahta hai. Code code-block mein do aur chhota sa samjhao.',
  learn: 'Abhi user kuch seekhna ya padhna chahta hai. Aasan misalon ke saath step by step samjhao.',
};

// Bohat simple rok-tham (har server instance ke liye): ek IP se 1 minute mein 20 sawal.
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 20;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Sirf POST chalta hai.' });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Server par GEMINI_API_KEY set nahi hai.' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip)) {
    return res.status(429).json({ error: 'Bohat tez sawal ho gaye. Thori der baad try karein.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const raw = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  const contents = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 4000) }] }));

  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Koi sawal nahi mila.' });
  }

  const hint = MODE_HINTS[body.mode];
  const systemText = hint ? SYSTEM_PROMPT + ' ' + hint : SYSTEM_PROMPT;

  let lastStatus = 500;
  for (const model of MODELS) {
    try {
      // Pehle "sochne" (thinking) ko band kar ke tez jawab maango.
      // Agar model ye na maane (400 error) to bagair us ke dobara try karo.
      const ask = (fast) => {
        const generationConfig = { temperature: 0.7, maxOutputTokens: 2048 };
        if (fast) generationConfig.thinkingConfig = { thinkingBudget: 0 };
        return fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemText }] },
              contents,
              generationConfig,
            }),
          }
        );
      };
      let r = await ask(true);
      if (r.status === 400) r = await ask(false);

      if (r.status === 404) { lastStatus = 404; continue; } // is naam ka model nahi, agla try karo

      const data = await r.json().catch(() => ({}));

      if (r.status === 429) {
        return res.status(429).json({ error: 'Abhi free limit poori ho gayi hai. Thori der baad try karein.' });
      }
      if (!r.ok) {
        lastStatus = r.status;
        continue;
      }

      const cand = data.candidates && data.candidates[0];
      const text = cand && cand.content && cand.content.parts
        ? cand.content.parts.map((p) => p.text || '').join('')
        : '';

      if (!text) {
        return res.status(200).json({ reply: 'Is sawal ka jawab main nahi de sakta. Kisi aur tarah se poochein.' });
      }
      return res.status(200).json({ reply: text });
    } catch (e) {
      lastStatus = 502;
    }
  }

  return res.status(502).json({
    error: 'AI se jawab nahi aa saka. API key check karein ya thori der baad try karein.',
  });
};
