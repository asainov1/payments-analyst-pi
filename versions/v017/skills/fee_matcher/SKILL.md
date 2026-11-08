# fee_matcher
Use this for any question that needs fee rules matched to transactions: applicable fee IDs for a merchant and period, total fees paid, or the delta if a fee's rate changes.

It matches every fee field against every transaction:
- card_scheme, is_credit, aci, intracountry (issuing_country == acquirer_country)
- the merchant's account_type, merchant_category_code and capture_delay (bucketed)
- the merchant's monthly_volume and monthly_fraud_level for the calendar month of that transaction

A NULL field or an empty list matches all values.

Usage (python tool):
```
exec(open('skills/fee_matcher/fee_matcher.py').read())
print(applicable_fee_ids('Merchant_X', month=5))      # month=None -> whole year
print(fee_delta('Merchant_X', fee_id=123, new_rate=99, month=None))
print(total_fees('Merchant_X', month=3))
```

`fee_delta` returns (new_rate - old_rate) * sum(eur_amount of matching txns) / 10000, together with the matched count and volume. If the path fails, locate the file with `import glob; glob.glob('**/fee_matcher.py', recursive=True)`.