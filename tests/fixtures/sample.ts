export const VERSION = "1.0.0";

export function classify(score: number): string {
  if (score > 90) {
    return "high";
  }
  return "low";
}

export const transform = (items: number[]): number[] =>
  items
    .filter((n) => n > 0)
    .map((n) => n * 2);

export class Reporter {
  private count = 0;

  increment(by: number): void {
    this.count += by;
  }
}
