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

describe("unknown_column only on explicit column references (v007 fix)", () => {
  test("SKILL.md with local snake_case variables and SQL aliases passes", async () => {
    const { candidateColumnRefs } = await import("../src/improver/schemacheck.ts");
    const skill =
      "# fee matching\nCall `match_fees(merchant, month)`; it returns applicable_fee_ids and fee_cost.\n" +
      "```python\nnew_rate = 99\ndelta_ok = True\nrows = con.sql(\"SELECT SUM(eur_amount) AS fee_cost FROM payments_m WHERE merchant = ? AND is_refused_by_psp = false\")\n```";
    expect(unknownIdentifiers(candidateColumnRefs({ rules: [], skillDocs: [skill] }), allowed)).toEqual([]);
  });

  test("rule with is_refused_by_adyen, table.column and SQL references are still caught", async () => {
    const { candidateColumnRefs } = await import("../src/improver/schemacheck.ts");
    expect(unknownIdentifiers(candidateColumnRefs({ rules: ["Exclude rows with is_refused_by_adyen = true."], skillDocs: [] }), allowed)).toEqual(["is_refused_by_adyen"]);
    expect(unknownIdentifiers(candidateColumnRefs({ rules: [], skillDocs: ["Filter payments.is_refused_by_adyen first."] }), allowed)).toEqual(["is_refused_by_adyen"]);
    expect(unknownIdentifiers(candidateColumnRefs({ rules: [], skillDocs: ["```sql\nSELECT * FROM payments WHERE shopper_country = 'NL'\n```"] }), allowed)).toEqual(["shopper_country"]);
  });
});
