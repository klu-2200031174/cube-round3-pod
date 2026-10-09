import type { Observation } from "../observation";

export interface VisionResult {
  observation: Observation;
  raw_output: string;
  latency_ms: number;
}

/**
 * One call per unit: all photos (already composed into one sheet) and all checks together.
 * Deliberately takes no PO line: the model must describe what it sees, not confirm what we expect.
 */
export interface VisionProvider {
  readonly provider: string;
  readonly model: string;
  observe(sheetJpeg: Buffer, photoRoles: string[]): Promise<VisionResult>;
}

/** Thrown for anything that should put the record into `pending` rather than crash. */
export class VisionError extends Error {
  constructor(
    message: string,
    readonly raw_output: string | null = null,
    readonly latency_ms: number | null = null,
  ) {
    super(message);
    this.name = "VisionError";
  }
}
