## Playbook

Rules learned from earlier mistakes. Follow them unless the question clearly says otherwise.

- [R001] For fee questions (applicable fee IDs, fee totals, rate-change deltas), compute with the fee_matcher skill, which checks every fee field (including the merchant's monthly volume and fraud bucket for each transaction's own month). Do not hand-write a partial SQL filter. Cross-check the matched transaction count with one quick SQL query before submitting.
