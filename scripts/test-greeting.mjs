if (!process.env.VELTR_TELEGRAM_BOT_TOKEN) throw new Error("VELTR_TELEGRAM_BOT_TOKEN is not set — run with: node --env-file=.env.local " + import.meta.filename);
// Does the greeting name survive Telegram's decorative characters?
const TG = process.env.VELTR_TELEGRAM_BOT_TOKEN;
const CHAT = process.env.VELTR_TEST_CHAT_ID;

function clean(raw) {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[​-‏‪-‮️]/g, "")
    .replace(/[^\p{L}\p{N}\s'’.-]/gu, "")
    .trim()
    .split(/\s+/)[0];
  return cleaned && cleaned.length >= 2 ? cleaned : null;
}

const chat = await (await fetch(`https://api.telegram.org/bot${TG}/getChat?chat_id=${CHAT}`)).json();
const r = chat.result ?? {};
const raw = r.first_name ?? r.username ?? "";

console.log("raw name      :", JSON.stringify(raw));
console.log("codepoints    :", [...raw].map((c) => c.codePointAt(0).toString(16)).join(" "));
console.log("cleaned       :", JSON.stringify(clean(raw)));

for (const sample of ["‎ dim", "🚀Alex🚀", "Мария", "x", "  John  Smith "]) {
  console.log(`  ${JSON.stringify(sample).padEnd(20)} -> ${JSON.stringify(clean(sample))}`);
}

const name = clean(raw);
const text = name
  ? `${name}, here is what I have.\n\nThe greeting now uses your Telegram name, cleaned of invisible characters. Replies stay in English regardless of the language you write in.`
  : "No usable name found, so greetings are skipped rather than rendered broken.";

const sent = await (
  await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id: CHAT, text }),
  })
).json();
console.log("telegram      :", sent.ok ? `sent ${sent.result.message_id}` : sent.description);
