## Playbook

Rules learned from earlier mistakes. Follow them unless the question clearly says otherwise.

- [R001] For fee-rule questions (applicable fee IDs, fees paid, or rate-change deltas), run the fee_matcher skill instead of a hand-written SQL filter. It reads raw fees.json, where the SQL `fees` table may show null booleans as false, and checks volume and fraud buckets month by month. Report its result.
