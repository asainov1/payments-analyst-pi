## Playbook

Rules learned from earlier mistakes. Follow them unless the question clearly says otherwise.

- [R001] When a question asks which country, merchant, scheme or segment is 'top', 'worst' or 'most' for fraud, rank by fraud rate, not raw fraud counts or EUR totals. Fraud rate is the EUR volume of payments with has_fraudulent_dispute divided by total EUR volume, computed per group over the requested period. Choose only among the offered options or the listed dimensions, and treat groups whose rate is NULL (no fraud volume) as 0.
