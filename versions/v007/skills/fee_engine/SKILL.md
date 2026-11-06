# fee_engine
Use this for any question about which fee IDs apply to a merchant, the delta if a fee's rate changed, or fees a merchant pays. It does the whole job in ONE python call. Do not hand-write the matching logic.

Load it at the start of the python code, because each python call is a fresh process:
```
import glob
exec(open(glob.glob('**/fee_engine.py', recursive=True)[0]).read())
```

Functions (period arguments: year defaults to 2023; month is 1-12; day is day_of_year):
- `applicable_fee_ids(merchant, month=None, day=None)` returns a sorted list of fee IDs that match at least one payment in the period.
- `fee_delta(merchant, fee_id, new_rate, month=None, day=None)` returns a dict with n, volume and delta for all payments. It also returns n_ok, volume_ok and delta_ok computed without refused payments.
- `match_table(merchant, month=None, day=None)` returns the payments DataFrame with a `fee_ids` column listing the matching fee IDs for each payment.
- `fee_cost(fee_id, amount)` returns fixed_amount + rate * amount / 10000.

Matching rules:
- Every fee field is checked. A NULL or empty list matches any value.
- intracountry compares issuing_country with acquirer_country.
- capture_delay is bucketed as <3, 3-5, >5, immediate or manual.
- monthly_volume and monthly_fraud_level use the merchant's calendar-month EUR totals. The fraud level is fraudulent EUR divided by total EUR, as a percentage.

Print the result and submit. Format the number as the guidelines require.