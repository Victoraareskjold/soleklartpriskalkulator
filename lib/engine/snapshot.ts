import { CalculationError } from "./errors";
import { ENGINE_VERSION } from "./calculate";
import type { CalculationInput, CalculationResult } from "./types";

export interface Snapshot<Meta extends object = Record<string, unknown>> {
  schemaVersion: 1;
  engineVersion: string;
  createdAt: string;
  input: CalculationInput;
  result: CalculationResult;
  meta: Meta;
}

/** Låst kopi av input og resultat. Nekter å lagre hvis et blokkerende avvik finnes. */
export function createSnapshot<Meta extends object>(
  input: CalculationInput,
  result: CalculationResult,
  meta = {} as Meta,
): Snapshot<Meta> {
  if (!result.ready) throw new CalculationError("Avklar manglende prisregler før versjonen lagres");
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      engineVersion: ENGINE_VERSION,
      createdAt: new Date().toISOString(),
      input,
      result,
      meta,
    }),
  );
}
