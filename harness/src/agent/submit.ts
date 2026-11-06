// `submit_answer` tool state (SPEC §3.3 / §4.4): validates against the task's guidelines, lets the
// model fix the format up to MAX_INVALID times, then accepts the answer flagged as invalid.
import { type AnswerFormat, parseFormat, validateAnswer } from "./validate.ts";

const MAX_INVALID = 3;

export type SubmitResult =
  | { ok: true; warning?: string }
  | { ok: false; reason: string; expected_format: string; attempts_left: number };

export interface SubmittedAnswer {
  answer: string;
  assumptions: string[];
  valid: boolean;
  attempts: number;
}

export class AnswerSlot {
  private readonly format: AnswerFormat;
  private attempts = 0;
  private invalid = 0;
  private current: SubmittedAnswer | null = null;

  constructor(guidelines: string) {
    this.format = parseFormat(guidelines);
  }

  submit(input: { answer: string; assumptions?: string[] }): SubmitResult {
    this.attempts++;
    const answer = input.answer.trim();
    const assumptions = input.assumptions ?? [];
    const v = validateAnswer(answer, this.format);
    if (v.ok) {
      this.current = { answer, assumptions, valid: true, attempts: this.attempts };
      return { ok: true };
    }
    if (this.invalid >= MAX_INVALID) {
      this.current = { answer, assumptions, valid: false, attempts: this.attempts };
      return { ok: true, warning: "accepted without passing format validation" };
    }
    this.invalid++;
    return { ok: false, reason: v.reason, expected_format: this.format.describe, attempts_left: MAX_INVALID - this.invalid };
  }

  result(): SubmittedAnswer | null {
    return this.current;
  }
}
