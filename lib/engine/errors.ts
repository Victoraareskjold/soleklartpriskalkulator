export class CalculationError extends Error {
  readonly field: string;

  constructor(message: string, field = "input") {
    super(message);
    this.name = "CalculationError";
    this.field = field;
  }
}
