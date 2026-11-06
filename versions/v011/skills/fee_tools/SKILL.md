# fee_tools
Use this for any question about which fee IDs apply to a merchant, or how much a merchant would pay or save if a fee's rate changed (delta). It replaces hand-written matching logic.

It applies every fee criterion:
- Merchant-level fields: account_type, merchant_category_code, and capture_delay mapped to its bucket.
- Transaction-level fields: card_scheme, is_credit, aci, and intracountry (issuing_country == acquirer_country).
- Monthly fields: monthly_volume and monthly_fraud_level, computed per natural calendar month. Fraud level is the EUR share of payments with a fraudulent dispute, as a percentage.
- NULL or empty-list fields act as wildcards.

The python tool keeps no state between calls, so load and call in ONE python call:
```
exec(open('skills/fee_tools/fee_tools.py').read())
print(applicable_fee_ids('Rafa_AI', days=[10]))
print(applicable_fee_ids('Some_Merchant', months=[3]))
print(applicable_fee_ids('Some_Merchant'))
print(rate_change_delta('Some_Merchant', 276, 99, months=[7]))
print(rate_change_delta('Some_Merchant', 276, 99))
```
- `months` is a list of month numbers. `days` is a list of day_of_year values. If neither is given, the whole year is used.
- `rate_change_delta` returns `(new_rate - old_rate) * matched_eur / 10000`, with the matched count and volume.
- If the path differs, locate the file with `glob.glob('**/fee_tools.py', recursive=True)`.
- A delta of 0 matched transactions means the answer is 0.