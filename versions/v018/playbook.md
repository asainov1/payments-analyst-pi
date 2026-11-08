## Playbook

Rules learned from earlier mistakes. Follow them unless the question clearly says otherwise.

- [R001] For 'what delta would <merchant> pay if the relative fee of fee <ID> changed to <rate>' questions: delta = (new_rate - old_rate) * (sum of eur_amount of that merchant's transactions in the period that match the fee) / 10000. Round the delta to 2 decimals (euro cents) first, then write it with the number of decimals the guidelines ask for (e.g. -1.23 -> -1.23000000000000).
