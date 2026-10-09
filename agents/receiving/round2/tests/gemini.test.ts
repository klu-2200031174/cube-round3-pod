import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectUnit } from "../lib/inspect";
import { visionProvider } from "../lib/vision";
import { GeminiProvider } from "../lib/vision/gemini";
import { goodObs, po } from "./helpers";

const jpeg = () => sharp({ create: { width: 400, height: 300, channels: 3, background: "#468" } }).jpeg().toBuffer();

function mockFetch(status: number, body: unknown) {
  const spy = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const ok = (text: string, finishReason = "STOP") => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });

afterEach(() => vi.unstubAllGlobals());

describe("GeminiProvider", () => {
  it("sends one request with the image, the key in a header (never the URL), and no PO data", async () => {
    const spy = mockFetch(200, ok(JSON.stringify(goodObs())));
    const res = await new GeminiProvider("gemini-test", "k-123").observe(await jpeg(), ["carton", "unit"]);
    expect(res.observation.product_type).toBe("water bottle");
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).not.toContain("k-123");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-123");
    const sent = String(init.body);
    expect(sent).toContain("inlineData");
    for (const leak of [po.sku, po.product_title, po.spec_variant]) expect(sent).not.toContain(leak);
  });

  it.each([
    ["missing key", () => new GeminiProvider("m", ""), () => mockFetch(200, {}), /GEMINI_API_KEY/],
    ["rate limit, still limited after retries", () => new GeminiProvider("m", "k", 120_000, [0, 0]), () => mockFetch(429, { error: { message: "quota" } }), /HTTP 429 after 3 attempts/],
    ["overloaded, still overloaded after retries", () => new GeminiProvider("m", "k", 120_000, [0, 0]), () => mockFetch(503, { error: { message: "high demand" } }), /HTTP 503 after 3 attempts/],
    ["cut off", () => new GeminiProvider("m", "k"), () => mockFetch(200, ok('{"photo_q', "MAX_TOKENS")), /stopped early/],
    ["wrong shape", () => new GeminiProvider("m", "k"), () => mockFetch(200, ok('{"photo_quality":"great"}')), /schema/],
  ])("%s → pending record, not a crash", async (_name, make, mock, why) => {
    mock();
    const rec = await inspectUnit({ po, provider: make(), operator_id: "o", photos: [{ role: "unit", ref: "x.jpg", bytes: await jpeg() }] });
    expect(rec.status).toBe("pending");
    expect(rec.model.error).toMatch(why);
    expect(rec.overall).not.toBe("ACCEPT");
  });
});

describe("provider choice", () => {
  it("defaults to Gemini 3.5 Flash-Lite; Ollama only when asked for", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("GEMINI_MODEL", "");
    const p = visionProvider();
    expect([p.provider, p.model]).toEqual(["gemini", "gemini-3.5-flash-lite"]);
    expect(visionProvider("ollama").provider).toBe("ollama");
    expect(() => visionProvider("grok")).toThrow(/Unknown VISION_PROVIDER/);
    vi.unstubAllEnvs();
  });

  it("ignores thought parts and returns only the answer", async () => {
    mockFetch(200, { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify(goodObs()) }] }, finishReason: "STOP" }] });
    const res = await new GeminiProvider("m", "k").observe(await jpeg(), ["unit"]);
    expect(res.observation.product_type).toBe("water bottle");
  });
});

describe("temporary overload", () => {
  it("re-sends the same single request after a 503 and succeeds", async () => {
    const answers = [new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 }), new Response(JSON.stringify(ok(JSON.stringify(goodObs()))), { status: 200 })];
    const spy = vi.fn(async () => answers.shift()!);
    vi.stubGlobal("fetch", spy);
    const res = await new GeminiProvider("m", "k", 120_000, [0, 0]).observe(await jpeg(), ["unit"]);
    expect(res.observation.product_type).toBe("water bottle");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not retry errors that won't go away (e.g. 400 bad request)", async () => {
    const spy = mockFetch(400, { error: { message: "bad request" } });
    const rec = await inspectUnit({ po, provider: new GeminiProvider("m", "k", 120_000, [0, 0]), operator_id: "o", photos: [{ role: "unit", ref: "x.jpg", bytes: await jpeg() }] });
    expect(rec.status).toBe("pending");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

