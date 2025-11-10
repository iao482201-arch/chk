export interface Env {
  BIN_CACHE: KVNamespace;
}

export class UserState {
  state: DurableObjectState;
  rateLimit: number[] = [];
  checking: {
    cards: string[];
    live: number;
    die: number;
    unknown: number;
    error: number;
    startTime: number;
    messageId?: number;
    results: string[];
  } | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { method } = request;

    if (method !== "POST") return new Response("OK");

    const { action, data } = await request.json<any>();

    switch (action) {
      case "rate_check":
        return this.handleRateCheck(data.userId);

      case "start_check":
        return this.handleStartCheck(data);

      case "update_progress":
        return this.handleUpdateProgress(data);

      case "get_progress":
        return this.handleGetProgress();

      default:
        return new Response("Invalid action", { status: 400 });
    }
  }

  async handleRateCheck(userId: number): Promise<Response> {
    const now = Date.now();
    const recent = this.rateLimit.filter(t => now - t < 60_000);
    if (recent.length >= 3) {
      return new Response(JSON.stringify({ allowed: false }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    recent.push(now);
    this.rateLimit = recent;
    await this.state.storage.put("rateLimit", recent);
    return new Response(JSON.stringify({ allowed: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async handleStartCheck(data: {
    userId: number;
    cards: string[];
    messageId: number;
  }): Promise<Response> {
    this.checking = {
      cards: data.cards,
      live: 0,
      die: 0,
      unknown: 0,
      error: 0,
      startTime: Date.now(),
      messageId: data.messageId,
      results: [],
    };
    await this.state.storage.put("checking", this.checking);
    return new Response("OK");
  }

  async handleUpdateProgress(data: {
    index: number;
    status: "live" | "die" | "unknown" | "error";
    result: string;
  }): Promise<Response> {
    if (!this.checking) return new Response("No session");

    const { index, status, result } = data;
    if (status === "live") this.checking.live++;
    else if (status === "die") this.checking.die++;
    else if (status === "unknown") this.checking.unknown++;
    else this.checking.error++;

    this.checking.results.push(result);
    await this.state.storage.put("checking", this.checking);

    return new Response(JSON.stringify({
      progress: `${index + 1}/${this.checking.cards.length}`,
      live: this.checking.live,
      die: this.checking.die,
      unknown: this.checking.unknown,
      error: this.checking.error,
      elapsed: ((Date.now() - this.checking.startTime) / 1000).toFixed(2),
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async handleGetProgress(): Promise<Response> {
    if (!this.checking) return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({
      progress: `${this.checking.results.length}/${this.checking.cards.length}`,
      live: this.checking.live,
      die: this.checking.die,
      unknown: this.checking.unknown,
      error: this.checking.error,
      elapsed: ((Date.now() - this.checking.startTime) / 1000).toFixed(2),
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
