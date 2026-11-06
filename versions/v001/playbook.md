## Playbook

Rules learned from earlier mistakes. Follow them unless the question clearly says otherwise.

- [R001] For fee-cost computations (fees paid, fee deltas when a rate or fixed amount changes, cheapest or most expensive fee options), charge only payments that were actually processed. Exclude rows with is_refused_by_adyen = true, then match every non-null or non-empty criterion of the fee rule (scheme, account_type, MCC, capture_delay bucket, is_credit, ACI, intracountry, monthly volume and fraud buckets). Compute delta = (new_rate - old_rate) * matched EUR volume / 10000 + (new_fixed - old_fixed) * matched count. Before submitting, run the query with and without the refused filter, report the count and volume for both in your assumptions, and submit the non-refused figure at full precision.
