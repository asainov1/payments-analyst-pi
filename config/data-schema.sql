-- Data schema shared by the harness `sql` tool (harness/src/data/db.ts) and the py-sandbox
-- (py-sandbox/build_db.py → payments.duckdb), so both tools see the same tables and views.
-- {data} is replaced with the path (single quotes doubled) of the bundle's data/ directory. One statement per `;`.
CREATE TABLE payments AS SELECT * FROM read_csv('{data}/payments.csv', header = true);
CREATE TABLE fees AS SELECT * FROM read_json('{data}/fees.json');
CREATE TABLE merchants AS SELECT * FROM read_json('{data}/merchant_data.json');
-- The two small CSVs carry a pandas index as an unnamed first column — drop it.
CREATE TABLE mcc AS SELECT mcc, description FROM read_csv('{data}/merchant_category_codes.csv', header = true);
CREATE TABLE acquirer_countries AS SELECT acquirer, country_code FROM read_csv('{data}/acquirer_countries.csv', header = true);
-- Natural months (manual §5): all payments are 2023.
CREATE VIEW payments_m AS SELECT *, CAST(month(DATE '2023-01-01' + CAST(day_of_year - 1 AS INTEGER)) AS INTEGER) AS month FROM payments;
