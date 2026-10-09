import sharp from "sharp";
import { Agent, fetch } from "undici";
import { ObservationSchema, observationJsonSchema } from "../observation";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { VisionError, type VisionProvider, type VisionResult } from "./provider";

// Longest side of the image actually sent to the model. Smaller = fewer image tokens = much
// faster on CPU. Evidence hashes are taken from the original photos, not from this copy.
const MODEL_IMAGE_MAX = 1024;

export class OllamaProvider implements VisionProvider {
  readonly provider = "ollama";

  constructor(
    readonly model = process.env.OLLAMA_MODEL || "llava",
    private readonly url = process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    private readonly timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 600_000),
  ) {
    this.dispatcher = new Agent({ headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs });
  }

  // Node's fetch gives up after 300 s without response headers or body data. On a CPU-only
  // machine the model can spend longer than that reading the image before its first token,
  // so the connection limits are raised to our own timeout, which stays the only limit.
  private readonly dispatcher: Agent;

  async observe(sheetJpeg: Buffer, photoRoles: string[]): Promise<VisionResult> {
    const started = Date.now();
    const image = await sharp(sheetJpeg)
      .resize(MODEL_IMAGE_MAX, MODEL_IMAGE_MAX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    let raw = "";
    try {
      // Streaming, so a long generation doesn't sit silent until the very end.
      const res = await fetch(`${this.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        dispatcher: this.dispatcher,
        body: JSON.stringify({
          model: this.model,
          stream: true,
          keep_alive: "10m",
          format: observationJsonSchema,
          options: { temperature: 0, num_ctx: 4096, num_predict: 900 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(photoRoles), images: [image.toString("base64")] },
          ],
        }),
      });
      if (!res.ok || !res.body) {
        throw new VisionError(`Ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, null, Date.now() - started);
      }

      // NDJSON: one {"message":{"content":"..."},"done":false} object per line.
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { message?: { content?: string }; error?: string };
          if (msg.error) throw new VisionError(`Ollama error: ${msg.error}`, raw || null, Date.now() - started);
          raw += msg.message?.content ?? "";
        }
      }
    } catch (err) {
      if (err instanceof VisionError) throw err;
      const e = err as Error;
      const why = e.name === "TimeoutError" ? `timed out after ${this.timeoutMs} ms` : `unreachable at ${this.url} (${e.message})`;
      throw new VisionError(`Ollama ${why}`, raw || null, Date.now() - started);
    }

    const latency_ms = Date.now() - started;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VisionError("Model output is not valid JSON (possibly cut off at the token limit)", raw, latency_ms);
    }
    const result = ObservationSchema.safeParse(parsed);
    if (!result.success) {
      throw new VisionError(`Model output failed schema validation: ${result.error.issues[0]?.message}`, raw, latency_ms);
    }
    return { observation: result.data, raw_output: raw, latency_ms };
  }
}
