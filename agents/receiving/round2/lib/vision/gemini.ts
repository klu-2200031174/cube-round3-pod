import sharp from "sharp";
import { ObservationSchema, observationJsonSchema } from "../observation";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { VisionError, type VisionProvider, type VisionResult } from "./provider";

// Default provider (local runs, eval, deployment). Same contract as OllamaProvider: one call per unit, blind to the PO, output
// validated against the same schema, and every failure is a VisionError so the record goes
// to `pending` instead of blocking the operator.

const MODEL_IMAGE_MAX = 1536;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// Gemini's response schema is a JSON Schema subset; the draft marker isn't part of it.
const { $schema: _unused, ...responseSchema } = observationJsonSchema as Record<string, unknown>;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export class GeminiProvider implements VisionProvider {
  readonly provider = "gemini";

  constructor(
    // Google limits the 2.5 models to earlier users and recommends 3.5 Flash-Lite or 3.8 Flash
    // for new projects (ai.google.dev/gemini-api/docs/models, checked 2026-10-01); both are on
    // the free tier. 3.8 Flash answered HTTP 503 "high demand" on every try that day, so the
    // default is 3.5 Flash-Lite; set GEMINI_MODEL=gemini-3.8-flash to use the larger one.
    readonly model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    private readonly apiKey = process.env.GEMINI_API_KEY || "",
    private readonly timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 120_000),
    // Pauses before re-sending the same request after a temporary overload (HTTP 429 / 503).
    // Still one request per unit with all checks in it; only its delivery is retried.
    private readonly retryDelaysMs: number[] = [2_000, 5_000],
  ) {}

  async observe(sheetJpeg: Buffer, photoRoles: string[]): Promise<VisionResult> {
    const started = Date.now();
    if (!this.apiKey) throw new VisionError("GEMINI_API_KEY is not set", null, 0);

    const image = await sharp(sheetJpeg)
      .resize(MODEL_IMAGE_MAX, MODEL_IMAGE_MAX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    let body: GeminiResponse;
    let attempts = 0;
    try {
      const request = () => {
        attempts++;
        return fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        // Key in a header, not the URL, so it never lands in access logs.
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        // One overall budget for all attempts, so a retry can't stretch past the timeout.
        signal: AbortSignal.timeout(Math.max(1, this.timeoutMs - (Date.now() - started))),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [
            {
              role: "user",
              parts: [{ text: buildUserPrompt(photoRoles) }, { inlineData: { mimeType: "image/jpeg", data: image.toString("base64") } }],
            },
          ],
          generationConfig: {
            temperature: 0,
            // 3.x models think (3.8 Flash always, medium by default) and thinking tokens count
            // against this limit, so leave room for them on top of the ~1k-token JSON answer.
            maxOutputTokens: 32768,
            responseMimeType: "application/json",
            responseJsonSchema: responseSchema,
          },
        }),
        });
      };
      let res = await request();
      for (const wait of this.retryDelaysMs) {
        if (res.status !== 429 && res.status !== 503) break;
        if (Date.now() - started + wait >= this.timeoutMs) break;
        await new Promise((r) => setTimeout(r, wait));
        res = await request();
      }
      body = (await res.json()) as GeminiResponse;
      if (!res.ok) {
        const tries = attempts > 1 ? ` after ${attempts} attempts` : "";
        throw new VisionError(`Gemini returned HTTP ${res.status}${tries}: ${body.error?.message?.slice(0, 300) ?? "no message"}`, null, Date.now() - started);
      }
    } catch (err) {
      if (err instanceof VisionError) throw err;
      const e = err as Error;
      const why = e.name === "TimeoutError" ? `timed out after ${this.timeoutMs} ms` : `unreachable (${e.message})`;
      throw new VisionError(`Gemini ${why}`, null, Date.now() - started);
    }

    const latency_ms = Date.now() - started;
    if (body.promptFeedback?.blockReason) throw new VisionError(`Gemini blocked the request: ${body.promptFeedback.blockReason}`, null, latency_ms);
    const cand = body.candidates?.[0];
    // Thought summaries are off by default; if any part is one, it isn't the answer.
    const raw = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    if (cand?.finishReason && cand.finishReason !== "STOP") {
      throw new VisionError(`Gemini stopped early (${cand.finishReason})`, raw || null, latency_ms);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VisionError("Model output is not valid JSON", raw || null, latency_ms);
    }
    const result = ObservationSchema.safeParse(parsed);
    if (!result.success) {
      throw new VisionError(`Model output failed schema validation: ${result.error.issues[0]?.message}`, raw, latency_ms);
    }
    return { observation: result.data, raw_output: raw, latency_ms };
  }
}
