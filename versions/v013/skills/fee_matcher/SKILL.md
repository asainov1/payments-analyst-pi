# fee_matcher
Use this for ANY question about which fee rules apply to a merchant, what fees a merchant pays, or the delta if a fee's rate changes.
It reads raw data/fees.json, because the SQL `fees` table may show null booleans as false. It matches every rule field per transaction:
- card_scheme, account_type, merchant_category_code, capture_delay, is_credit, aci and intracountry;
- monthly_volume and monthly_fraud_level, computed for each calendar month separately.
NULL or an empty list matches everything.

Usage (python tool):
```
exec(open('skills/fee_matcher/fee_matcher.py').read())
show_fee(787)                                      # raw rule as stored in fees.json
fee_delta(787, 'Rafa_AI', new_rate=1, month=5)     # month=None -> whole year
applicable_fees('Martinis_Fine_Steakhouse', month=5)
```
Compute delta as (new_rate - old_rate) * sum(eur_amount of matching txns) / 10000. If the helper's result differs from a hand-written SQL result, trust the helper. Then fix your SQL filter, e.g. drop a filter on a field that is null in the raw JSON.