import { sendMessage, editMessage, answerCallback } from "./telegram";

interface Env {
  TELEGRAM_TOKEN: string;
  MOCK_GATEWAY: string;
  BIN_API: string;
  RATE_KV?: KVNamespace;
}

// ———————————————————————— Luhn Algorithm ————————————————————————
function luhnGenerate(prefix: string, length: number): string {
  let number = prefix;
  while (number.length < length - 1) {
    number += Math.floor(Math.random() * 10);
  }
  let sum = 0;
  let alternate = true;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = parseInt(number[i]);
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

// ———————————————————————— BIN Lookup ————————————————————————
interface BinData {
  number: { iin: string; length: number; luhn: boolean };
  scheme: string;
  type: string;
  category: string;
  bank: { name?: string; phone?: string; url?: string };
  country: { name: string; emoji: string };
  success: boolean;
}

async function getBinInfo(bin: string): Promise<string> {
  try {
    const res = await fetch(`https://binlist.io/lookup/${bin}/`);
    if (!res.ok) return "❌ BIN lookup failed";
    const data: BinData = await res.json();

    if (!data.success) return "❌ BIN not found";

    return (
      `<b>BIN:</b> <code>${bin}</code>\n` +
      `<b>Scheme:</b> ${data.scheme || "—"} • <b>Type:</b> ${data.type || "—"}\n` +
      `<b>Category:</b> ${data.category || "—"}\n` +
      `<b>Bank:</b> ${data.bank.name || "—"}\n` +
      `<b>Country:</b> ${data.country.emoji} ${data.country.name}`
    );
  } catch {
    return "⚠️ BIN lookup error";
  }
}

// ———————————————————————— Card Checker ————————————————————————
async function checkCard(env: Env, card: string): Promise<{
  status: "live" | "die" | "unknown" | "error";
  message: string;
  binInfo: string;
}> {
  const [cc, mm, yy, cvv] = card.split("|");
  if (!cc || !mm || !yy || !cvv) return { status: "error", message: "Invalid format", binInfo: "" };

  const body = `data=${cc}|${mm}|${yy}|${cvv}`;

  try {
    const res = await fetch(env.MOCK_GATEWAY, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Chromium";v="107", "Not=A?Brand";v="24"',
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"Android"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        referrer: "https://mock.payate.com/",
      },
      body,
    });

    if (!res.ok) return { status: "error", message: "Gateway error", binInfo: "" };

    const json: any = await res.json();
    const html = json.msg || "";

    const bin = cc.slice(0, 6);
    const binInfo = await getBinInfo(bin);

    // Parse response
    if (html.includes("color:#008000") && html.includes("Live")) {
      return { status: "live", message: html.replace(/<[^>]*>/g, "").trim(), binInfo };
    } else if (html.includes("color:#FF0000") && html.includes("Die")) {
      return { status: "die", message: html.replace(/<[^>]*>/g, "").trim(), binInfo };
    } else if (html.includes("color:#800080") && html.includes("Unknown")) {
      return { status: "unknown", message: html.replace(/<[^>]*>/g, "").trim(), binInfo };
    } else {
      return { status: "error", message: "Unknown response", binInfo };
    }
  } catch (e) {
    return { status: "error", message: "Request failed", binInfo: "" };
  }
}

// ———————————————————————— Generate Cards ————————————————————————
function generateCards(bin: string, amount: number): string[] {
  const cards: string[] = [];
  const length = 16;
  const prefix = bin.padEnd(length, "0").slice(0, length);

  for (let i = 0; i < amount; i++) {
    const cc = luhnGenerate(prefix.slice(0, length - 1), length);
    const mm = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
    const yy = String(26 + Math.floor(Math.random() * 8)).padStart(2, "0");
    const cvv = String(100 + Math.floor(Math.random() * 900));
    cards.push(`${cc}|${mm}|${yy}|${cvv}`);
  }
  return cards;
}

// ———————————————————————— Main Handler ————————————————————————
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const update: any = await request.json();
      const msg = update.message;
      const callback = update.callback_query;

      if (callback) {
        await answerCallback(env, callback.id);
        return new Response("ok");
      }

      if (!msg?.text) return new Response("ok");

      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const userId = msg.from.id;
      const [cmd, ...args] = text.split(/\s+/);

      // Rate limit: 3 checks per minute
      if (env.RATE_KV) {
        const key = `rate:${userId}`;
        const now = Date.now();
        const recent = ((await env.RATE_KV.get(key, { type: "json" })) as number[]) || [];
        const valid = recent.filter(t => now - t < 60_000);
        if (valid.length > 3 && !["/start", "/help"].includes(cmd)) {
          await sendMessage(env, chatId, "Rate limit: 3 commands/min");
          return new Response("ok");
        }
        valid.push(now);
        await env.RATE_KV.put(key, JSON.stringify(valid), { expirationTtl: 120 });
      }

      // ————— /start —————
      if (cmd === "/start") {
        const welcome = `
*CC Checker & Generator Bot* 

*Commands:*
/gen bin amount – Generate cards
/chk – Paste cards (cc|mm|yy|cvv)
/bin bin – Lookup BIN info

*Example:*  
/gen 486796 10
        `.trim();
        await sendMessage(env, chatId, welcome, "Markdown");
        return new Response("ok");
      }

      // ————— /gen —————
      if (cmd === "/gen" && args.length >= 2) {
        const bin = args[0].replace(/\D/g, "").slice(0, 6);
        const amount = Math.min(parseInt(args[1]) || 10, 50);
        if (bin.length < 6) {
          await sendMessage(env, chatId, "Invalid BIN (min 6 digits)");
          return new Response("ok");
        }

        const cards = generateCards(bin, amount);
        const list = cards.map(c => `<code>${c}</code>`).join("\n");

        await sendMessage(
          env,
          chatId,
          `<b>Generated ${amount} Cards</b>\n<i>BIN: ${bin}</i>\n\n${list}`,
          "HTML"
        );
        return new Response("ok");
      }

      // ————— /bin —————
      if (cmd === "/bin" && args[0]) {
        const bin = args[0].replace(/\D/g, "").slice(0, 6);
        const info = await getBinInfo(bin);
        await sendMessage(env, chatId, `<b>BIN Lookup</b>\n\n${info}`, "HTML");
        return new Response("ok");
      }

      // ————— /chk —————
      if (cmd === "/chk") {
        const lines = text
          .split("\n")
          .map(l => l.trim())
          .filter(l => /^\d{15,19}\|\d{2}\|\d{2,4}\|\d{3,4}$/.test(l))
          .slice(0, 30); // max 30

        if (lines.length === 0) {
          await sendMessage(env, chatId, "Send cards in format:\n<code>6011201234567890|07|32|839</code>", "HTML");
          return new Response("ok");
        }

        const startMsg = await sendMessage(
          env,
          chatId,
          `<b>Mass Checking Started!</b>\n` +
          `Cards: ${lines.length}\n` +
          `Gateway: Mock Payate\n` +
          `Status: <i>0/${lines.length} checked...</i>`,
          "HTML"
        );

        const messageId = (startMsg as any).result.message_id;
        const startTime = performance.now();

        let live = 0, die = 0, unknown = 0, error = 0;
        const results: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const card = lines[i];
          const res = await checkCard(env, card);

          if (res.status === "live") live++;
          else if (res.status === "die") die++;
          else if (res.status === "unknown") unknown++;
          else error++;

          const icon = res.status === "live" ? "Approved" : res.status === "die" ? "Declined" : res.status === "unknown" ? "Unknown" : "Warning";
          results.push(
            `<b>${icon}</b> | <code>${card}</code>\n${res.binInfo}`
          );

          // Update progress every 3 cards
          if (i % 3 === 2 || i === lines.length - 1) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            await editMessage(
              env,
              chatId,
              messageId,
              `<b>Mass Checking In Progress...</b>\n` +
              `Cards: ${lines.length}\n` +
              `Time: ${elapsed}s\n` +
              `Gateway: Mock Payate\n\n` +
              `Approved ${live} Approved\n` +
              `Declined ${die} Declined\n` +
              `Unknown ${unknown} Unknown\n` +
              `Errors ${error} Warning\n\n` +
              `<i>Checked: ${i + 1}/${lines.length}</i>`,
              "HTML"
            );
          }
        }

        const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);

        const final = `
*Mass Checking Completed!*
Total Cards: ${lines.length}
Time Taken: ${totalTime}s
Gateway: Mock Payate

Approved ${live} Approved
Declined ${die} Declined
Unknown ${unknown} Unknown
Errors ${error} Warning

${results.join("\n\n")}
        `.trim();

        await editMessage(env, chatId, messageId, final, "Markdown");
        return new Response("ok");
      }

      await sendMessage(env, chatId, "Unknown command. Use /start");
      return new Response("ok");
    }

    return new Response("CC Checker Bot – POST /webhook");
  },
};
