import { GeminiProvider } from "./gemini";
import { OllamaProvider } from "./ollama";
import type { VisionProvider } from "./provider";

/**
 * Picks the vision model from VISION_PROVIDER. One default everywhere, so the eval measures the
 * same model the deployment and the demo use: "gemini" (hosted). "ollama" (local LLaVA) is kept
 * as an opt-in offline fallback. Both are blind to the PO and make one call per unit.
 */
export function visionProvider(name = process.env.VISION_PROVIDER || "gemini"): VisionProvider {
  switch (name) {
    case "gemini":
      return new GeminiProvider();
    case "ollama":
      return new OllamaProvider();
    default:
      throw new Error(`Unknown VISION_PROVIDER "${name}" (use "ollama" or "gemini")`);
  }
}
