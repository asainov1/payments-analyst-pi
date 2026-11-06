## Playbook

Rules learned from earlier mistakes. Follow them unless the question clearly says otherwise.

- [R001] For fee-rule questions (applicable fee IDs, rate-change deltas, which payments a fee covers), load and call the fee_engine skill in a single python call instead of hand-writing matching logic. Every python call is a fresh process, so re-import everything in each call.
