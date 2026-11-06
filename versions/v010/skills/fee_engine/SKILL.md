# fee_engine
Use for any question that needs to know which fee rules apply to a merchant's payments: applicable fee IDs, fee deltas when a rule's rate changes, or the payments a fee ID touches.

Every python call is a fresh process, so load the helper in the same call that uses it:
```
import glob; exec(open(glob.glob('**/fee_engine.py', recursive=True)[0]).read())
print(applicable_fee_ids('MerchantName', month=1))      # or day=10, months=[1,2,3], or no filter for the whole year
print(fee_delta(787, 'MerchantName', new_rate=1, month=5))  # (new_rate - rate) * matched EUR / 10000
tx = matching(787, 'MerchantName', month=5); print(len(tx), tx.eur_amount.sum())
```
What it does:
- Reads data/payments.csv, data/fees.json and data/merchant*.json at run time.
- Treats a NULL or empty-list rule field as a wildcard.
- Maps capture_delay to the buckets <3, 3-5, >5, immediate, manual.
- Checks monthly_volume and monthly_fraud_level (EUR-based, in %) against the merchant's totals for each natural calendar month.
- Checks card_scheme, is_credit, aci and intracountry (issuing_country = acquirer_country) per transaction.

fee_delta takes include_refused=True by default; state that choice in your assumptions.