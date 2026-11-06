## Playbook

Rules learned from earlier mistakes. Follow them unless the question clearly says otherwise.

- [R001] For applicable-fee-ID and fee rate-change delta questions, run the fee_tools skill in a single python call instead of hand-writing matching logic. A fee applies only if every criterion matches, including monthly_volume and monthly_fraud_level for that transaction's calendar month.
