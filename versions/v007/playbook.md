## Playbook

Rules learned from earlier mistakes. Follow them unless the question clearly says otherwise.

- [R001] For applicable-fee-ID, fee-delta or fees-paid questions, call the fee_engine skill in a single python call instead of hand-writing the matching. It checks every fee field, including the monthly volume and fraud buckets. Submit right after sanity-checking its output.
