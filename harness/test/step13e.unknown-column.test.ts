// Deterministic check before SMOKE: snake_case identifiers in playbook rules, SKILL.md and tool
// descriptions must exist in the data schema / domain vocabulary — else reject `unknown_column` for $0.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type DataDb, openDataDb } from "../src/data/db.ts";
import { buildIdentifierAllowList, unknownIdentifiers } from "../src/improver/schemacheck.ts";

const ROOT = join(import.meta.dirname, "..", "..");
let db: DataDb;
let allowed: Set<string>;
beforeAll(async () => {
  db = await openDataDb(join(ROOT, "bundle", "data"));
  allowed = await buildIdentifierAllowList(ROOT, db);
});
afterAll(() => db?.close());

describe("unknown_column", () => {
  test("v001's rule (is_refused_by_adyen) is caught", () => {
    expect(unknownIdentifiers("Exclude rows with is_refused_by_adyen = true, then match the fee rule.", allowed)).toEqual(["is_refused_by_adyen"]);
  });

  test("real columns, fee keys, manual terms, tables and tools pass", () => {
    const text =
      "Filter is_refused_by_psp = false, use eur_amount, has_fraudulent_dispute, card_scheme, monthly_fraud_level, " +
      "capture_delay, merchant_category_code, fixed_amount, aci, intracountry from payments_m and fees; call submit_answer or read_manual; max_turn_s.";
    expect(unknownIdentifiers(text, allowed)).toEqual([]);
  });

  test("skill names of the candidate are allowed; ordinary words are ignored", () => {
    expect(unknownIdentifiers("Use the fee_delta skill helper for this.", new Set([...allowed, "fee_delta"]))).toEqual([]);
    expect(unknownIdentifiers("Round to 6 decimals, never guess.", allowed)).toEqual([]);
  });
});
