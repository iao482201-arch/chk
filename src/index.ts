import { Telegraf } from "telegraf";

// === CONFIG ===
interface Env {
  TELEGRAM_TOKEN: string;
  MOCK_GATEWAY: string;
  BIN_API: string;
  RATE_KV: KVNamespace;
}

// === Luhn Generator ===
function luhnGenerate(prefix: string, length: number): string {
  let number = prefix;
  while (number.length < length - 1) {
    number += Math.floor(Math.random() * 10);
  }
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

// === BIN Lookup ===
async function getBinInfo(bin: string, env: Env): Promise<string> {
  const cacheKey = `bin:${bin}`;
  const cached = await env.RATE_KV.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${env.BIN_API}/${bin}/`);
    if (!res.ok) return "BIN lookup failed";

    const data = await res.json<any>();
    if (!data.success) return "BIN not found";

    const info = `
<b>BIN:</b> <code>${bin}</code>
<b>Scheme:</b> ${data.scheme || "—"} • <b>Type:</b> ${data.type || "—"}
<b>Category:</b> ${data.category || "—"}
<b>Bank:</b> ${data.bank?.name || "—"}
<b>Country:</b> ${data.country?.emoji || ""} ${data.country?.name || "—"}
    `.trim();

    await env.RATE_KV.put(cacheKey, info, { expirationTtl: 86400 });
    return info;
  } catch {
    return "BIN lookup error";
  }
}

// === Card Checker ===
async function checkCard(card: string, env: Env): Promise<{
  status: "live" | "die" | "unknown" | "error";
  message: string;
  binInfo: string;
}> {
  const [cc, mm, yy, cvv] = card.split("|").map(s => s.trim());
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
    const binInfo = await getBinInfo(bin, env);

    if (/color:#008000.*Live/i.test(html)) {
      return { status: "live", message: "Live", binInfo };
    } else if (/color:#FF0000.*Die/i.test(html)) {
      return { status: "die", message: "Die", binInfo };
    } else if (/color:#800080.*Unknown/i.test(html)) {
      return { status: "unknown", message: "Unknown", binInfo };
    } else {
      return { status: "error", message: "Unknown response", binInfo };
    }
  } catch {
    return { status: "error", message: "Request failed", binInfo: "" };
  }
}

// === Generate Cards ===
function generateCards(bin: string, amount: number): string[] {
  const cards: string[] = [];
  const prefix = bin.padEnd(16, "0").slice(0, 16);
  for (let i = 0; i < amount; i++) {
    const cc = luhnGenerate(prefix.slice(0, 15), 16);
    const mm = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
    const yy = String(26 + Math.floor(Math.random() * 8)).padStart(2, "0");
    const cvv = String(100 + Math.floor(Math.random() * 900));
    cards.push(`${cc}|${mm}|${yy}|${cvv}`);
  }
  return cards;
}

// === Rate Limit ===
async function isRateLimited(userId: number, env: Env): Promise<boolean> {
  const key = `rate:${userId}`;
  const now = Date.now();
  const recent = ((await env.RATE_KV.get(key, { type: "json" })) as number[]) || [];
  const valid = recent.filter(t => now - t < 60_000);
  if (valid.length >= 3) return true;
  valid.push(now);
  await env.RATE_KV.put(key, JSON.stringify(valid), { expirationTtl: 120 });
  return false;
}

// === Telegraf Bot ===
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json<any>();
      const bot = new Telegraf(env.TELEGRAM_TOKEN);

      // /start
      bot.start((ctx) => {
        ctx.replyWithMarkdownV2(`
*CC Checker & Generator Bot*

*Commands:*
\`/gen bin amount\` – Generate cards
\`/chk\` – Paste cards (cc|mm|yy|cvv)
\`/bin bin\` – Lookup BIN

*Example:*
\`/gen 486796 10\`
        `);
      });

      // /gen
      bot.command("gen", async (ctx) => {
        const args = ctx.message.text.split(/\s+/).slice(1);
        if (args.length < 2) return ctx.reply("Usage: /gen bin amount");

        const bin = args[0].replace(/\D/g, "").slice(0, 6);
        const amount = Math.min(parseInt(args[1]) || 10, 50);
        if (bin.length < 6) return ctx.reply("Invalid BIN");

        const cards = generateCards(bin, amount);
        const list = cards.map(c => `<code>${c}</code>`).join("\n");

        ctx.replyWithHTML(`<b>Generated ${amount} Cards</b>\n<i>BIN: ${bin}</i>\n\n${list}`);
      });

      // /bin
      bot.command("bin", async (ctx) => {
        const bin = ctx.message.text.split(/\s+/)[1]?.replace(/\D/g, "").slice(0, 6);
        if (!bin) return ctx.reply("Usage: /bin 601120");

        const info = await getBinInfo(bin, env);
        ctx.replyWithHTML(`<b>BIN Lookup</b>\n\n${info}`);
      });

      // /chk
      bot.command("chk", async (ctx) => {
        const userId = ctx.from!.id;
        if (await isRateLimited(userId, env)) {
          return ctx.reply("Rate limit: 3 checks per minute");
        }

        const text = ctx.message.text;
        const lines = text
          .split("\n")
          .map(l => l.trim())
          .filter(l => /^\d{15,19}\|\d{2}\|\d{2,4}\|\d{3,4}$/.test(l))
          .slice(0, 30);

        if (lines.length === 0) {
          return ctx.replyWithHTML("Send cards in format:\n<code>6011201234567890|07|32|839</code>");
        }

        const statusMsg = await ctx.replyWithHTML(
          `<b>Mass Checking Started!</b>\n` +
          `Cards: ${lines.length}\n` +
          `Gateway: Mock Payate\n` +
          `Status: <i>0/${lines.length} checked...</i>`
        );

        const startTime = Date.now();
        let live = 0, die = 0, unknown = 0, error = 0;
        const results: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const card = lines[i];
          const res = await checkCard(card, env);

          if (res.status === "live") live++;
          else if (res.status === "die") die++;
          else if (res.status === "unknown") unknown++;
          else error++;

          const icon = res.status === "live" ? "Approved" : res.status === "die" ? "Declined" : res.status === "unknown" ? "Unknown" : "Warning";
          results.push(`<b>${icon}</b> | <code>${card}</code>\n${res.binInfo}`);

          if (i % 3 === 2 || i === lines.length - 1) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            await ctx.telegram.editMessageText(
              ctx.chat!.id,
              statusMsg.message_id,
              undefined,
              `<b>Mass Checking In Progress...</b>\n` +
              `Cards: ${lines.length}\n` +
              `Time: ${elapsed}s\n` +
              `Gateway: Mock Payate\n\n` +
              `Approved ${live} Approved\n` +
              `Declined ${die} Declined\n` +
              `Unknown ${unknown} Unknown\n` +
              `Errors ${error} Warning\n\n` +
              `<i>Checked: ${i + 1}/${lines.length}</i>`,
              { parse_mode: "HTML" }
            );
          }
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
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

        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          undefined,
          final,
          { parse_mode: "Markdown" }
        );
      });

      // Handle update
      await bot.handleUpdate(update);
      return new Response("OK");
    }

    // Health check
    return new Response("CC Checker Bot – POST /webhook");
  },
};
