export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  parse_mode = "HTML"
) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode }),
  });
}
