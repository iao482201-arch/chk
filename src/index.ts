export interface Env {
  // Add any environment variables if needed, e.g., for rate limiting with KV.
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      // Read the incoming request body
      const body = await request.text();
      if (!body) {
        return new Response('Bad Request: Missing body', { status: 400 });
      }

      const params = new URLSearchParams(body);
      const ccData = params.get('cc');
      const data = params.get('data');

      const results: any[] = [];

      if (ccData) {
        // Batch processing mode
        const cards = ccData.split('\n').filter(card => card.trim() !== '');

        // Process each card sequentially to avoid rate limits
        for (const card of cards) {
          let binInfo: any;
          try {
            binInfo = await getBinInfo(card);
          } catch (error) {
            console.error(`Error fetching BIN for card "${card}":`, error);
            binInfo = { error: true, message: error instanceof Error ? error.message : 'Unknown error' };
          }

          try {
            const encodedData = encodeURIComponent(card.trim().replace(/\|/g, '%7C'));
            const apiResponse = await fetchApi(`data=${encodedData}`);
            results.push({ card, response: apiResponse, binInfo });
          } catch (error) {
            console.error(`Error processing card "${card}":`, error);
            results.push({ card, error: true, message: error instanceof Error ? error.message : 'Unknown error', binInfo });
          }
        }
      } else if (data) {
        // Single card mode
        const decodedData = decodeURIComponent(data);
        const card = decodedData; // Full card string like "4345591312747821|02|2029|455"

        let binInfo: any;
        try {
          binInfo = await getBinInfo(card);
        } catch (error) {
          console.error(`Error fetching BIN for card "${card}":`, error);
          binInfo = { error: true, message: error instanceof Error ? error.message : 'Unknown error' };
        }

        try {
          const apiResponse = await fetchApi(body);
          results.push({ card, response: apiResponse, binInfo });
        } catch (error) {
          console.error(`Error processing card "${card}":`, error);
          results.push({ card, error: true, message: error instanceof Error ? error.message : 'Unknown error', binInfo });
        }
      } else {
        return new Response('Bad Request: Missing "cc" or "data" in body', { status: 400 });
      }

      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Proxy error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

async function fetchApi(body: string): Promise<any> {
  const response = await fetch('https://www.binsearcher.com/api.php', {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'sec-ch-ua': '"Chromium";v="107", "Not=A?Brand";v="24"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'x-requested-with': 'XMLHttpRequest',
      // Note: Referrer is set statically; adjust if dynamic is needed
      'referrer': 'https://www.binsearcher.com/live-cc-checker',
      'referrerPolicy': 'strict-origin-when-cross-origin',
    },
    body: body,
    // Credentials: 'include' may not work in a proxy context without shared cookies;
    // If the API requires session cookies, this proxy might need adjustments.
  });

  if (!response.ok) {
    throw new Error(`API responded with status ${response.status}: ${await response.text()}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Failed to parse API response as JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function getBinInfo(card: string): Promise<any> {
  const parts = card.split('|');
  const cardNum = parts[0]?.replace(/\D/g, '') || ''; // Extract card number and remove non-digits
  if (cardNum.length < 6) {
    throw new Error('Invalid card number: too short');
  }
  const bin = cardNum.slice(0, 6);
  const url = `https://binlist.io/lookup/${bin}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`BIN lookup failed with status ${response.status}: ${await response.text()}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Failed to parse BIN response as JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
