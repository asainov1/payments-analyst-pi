// Task guidelines → AnswerFormat → validation (SPEC §3.2 agent/validate). Checks shape only, not truth.

export type AnswerFormat = { notApplicable: boolean; describe: string } & (
  | { kind: "decimals"; places: number }
  | { kind: "grouped" }
  | { kind: "list"; allowEmpty: boolean }
  | { kind: "option" }
  | { kind: "yes_no" }
  | { kind: "country_code" }
  | { kind: "number" }
  | { kind: "name" }
  | { kind: "free" }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Validation = { ok: true } | { ok: false; reason: string };

export function parseFormat(guidelines: string): AnswerFormat {
  const g = guidelines.toLowerCase();
  const notApplicable = g.includes("not applicable");
  const f = (x: DistributiveOmit<AnswerFormat, "notApplicable">) => ({ ...x, notApplicable }) as AnswerFormat;

  if (g.includes("[grouping_i: amount_i")) {
    return f({ kind: "grouped", describe: "[key: amount, …] — amounts with exactly 2 decimals, sorted ascending by amount" });
  }
  if (g.includes("in the form 'x. y'")) return f({ kind: "option", describe: "'X. Y' — option letter, dot, space, value (e.g. 'B. BE')" });
  if (g.includes("comma separated list")) {
    const allowEmpty = g.includes("empty list, reply with an empty string");
    return f({ kind: "list", allowEmpty, describe: `comma-separated values 'A, B, C'${allowEmpty ? "; empty string for an empty list" : ""}` });
  }
  const dec = /rounded to (\d+) decimals/.exec(g);
  if (dec) {
    const places = Number(dec[1]);
    return f({ kind: "decimals", places, describe: `a bare number rounded to ${places} decimals (e.g. ${(1).toFixed(places)})` });
  }
  if (/\byes or no\b/.test(g)) return f({ kind: "yes_no", describe: "just 'yes' or 'no'" });
  if (g.includes("country code")) return f({ kind: "country_code", describe: "a 2-letter country code (e.g. NL)" });
  if (/just a number|exact number/.test(g)) return f({ kind: "number", describe: "a bare number (e.g. 42 or 12.5)" });
  if (/just the (name|column|string)|column's name/.test(g)) return f({ kind: "name", describe: "a single name/token, no sentence" });
  return f({ kind: "free", describe: "free text as the guidelines describe" });
}

const NUMBER = /^-?\d+(\.\d+)?$/;
const fail = (reason: string): Validation => ({ ok: false, reason });

export function validateAnswer(raw: string, fmt: AnswerFormat): Validation {
  const a = raw.trim();
  if (fmt.notApplicable && a === "Not Applicable") return { ok: true };

  switch (fmt.kind) {
    case "decimals":
      // Gold answers sometimes drop trailing digits (-10.48 for "14 decimals"), so ≤ places is valid.
      return new RegExp(`^-?\\d+(\\.\\d{1,${fmt.places}})?$`).test(a) ? { ok: true } : fail(`expected a bare number with at most ${fmt.places} decimals`);
    case "number":
      return NUMBER.test(a) ? { ok: true } : fail("expected a bare number without units or text");
    case "yes_no":
      return /^(yes|no)$/i.test(a) ? { ok: true } : fail("expected just 'yes' or 'no'");
    case "country_code":
      return /^[A-Z]{2}$/.test(a) ? { ok: true } : fail("expected a 2-letter uppercase country code");
    case "option":
      return /^[A-Z]\. \S.*$/.test(a) ? { ok: true } : fail("expected 'X. Y' (letter, dot, space, value)");
    case "name":
      return a && !/[\s,]/.test(a) && a.length <= 60 ? { ok: true } : fail("expected a single name without spaces or commas");
    case "list": {
      if (a === "") return fmt.allowEmpty ? { ok: true } : fail("empty answer not allowed");
      if (/[[\]]/.test(a)) return fail("plain comma-separated list expected, without brackets");
      const items = a.split(",").map((s) => s.trim());
      const bad = items.find((s) => !s || /\s/.test(s));
      return bad === undefined ? { ok: true } : fail(`list items must be single values separated by ', ' (bad item: '${bad}')`);
    }
    case "grouped": {
      const m = /^\[(.*)\]$/.exec(a);
      if (!m) return fail("expected [key: amount, …] in square brackets");
      if (m[1].trim() === "") return { ok: true };
      const amounts: number[] = [];
      for (const part of m[1].split(",").map((s) => s.trim())) {
        const it = /^([^:[\]]+): (-?\d+\.\d{2})$/.exec(part);
        if (!it) return fail(`bad element '${part}': expected 'key: amount' with 2 decimals`);
        amounts.push(Number(it[2]));
      }
      return amounts.every((x, i) => i === 0 || amounts[i - 1] <= x) ? { ok: true } : fail("elements must be sorted ascending by amount");
    }
    case "free":
      return a ? { ok: true } : fail("empty answer");
  }
}
