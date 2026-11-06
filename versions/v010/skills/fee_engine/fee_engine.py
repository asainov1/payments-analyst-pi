import json, glob, os
import pandas as pd

def _find(pat):
    for base in ('data', '../data', '.', '../../data'):
        hits = sorted(glob.glob(os.path.join(base, pat)))
        if hits:
            return hits[0]
    raise FileNotFoundError(pat)

def _b(s):
    if s.dtype == object:
        return s.astype(str).str.strip().str.lower().isin(['true', '1', '1.0'])
    return s.fillna(False).astype(bool)

_C = {}

def load():
    if not _C:
        p = pd.read_csv(_find('payments.csv'))
        p['month'] = (pd.to_datetime('2023-01-01') + pd.to_timedelta(p['day_of_year'] - 1, unit='D')).dt.month
        p['_credit'] = _b(p['is_credit'])
        p['_fraud'] = _b(p['has_fraudulent_dispute'])
        p['_refused'] = _b(p['is_refused_by_psp'])
        p['_fr_amt'] = p['eur_amount'].where(p['_fraud'], 0.0)
        g = p.groupby(['merchant', 'year', 'month']).agg(vol=('eur_amount', 'sum'), fr=('_fr_amt', 'sum'))
        g['fraud_pct'] = 100 * g['fr'] / g['vol']
        _C['P'] = p
        _C['F'] = json.load(open(_find('fees.json')))
        _C['M'] = {m['merchant']: m for m in json.load(open(_find('merchant*.json')))}
        _C['S'] = g
    return _C['P'], _C['F'], _C['M'], _C['S']

def _wild(x):
    if x is None:
        return True
    if isinstance(x, float) and x != x:
        return True
    if isinstance(x, (list, tuple)) and len(x) == 0:
        return True
    return False

def _num(s):
    s = s.strip().lower().replace('%', '').replace(',', '')
    mult = 1.0
    if s.endswith('k'):
        mult, s = 1e3, s[:-1]
    elif s.endswith('m'):
        mult, s = 1e6, s[:-1]
    return float(s) * mult

def _in_range(rule, v):
    if _wild(rule):
        return True
    r = str(rule).strip()
    if r.startswith('<'):
        return v < _num(r[1:])
    if r.startswith('>'):
        return v > _num(r[1:])
    a, b = r.split('-')
    return _num(a) <= v <= _num(b)

def _cd_bucket(v):
    s = str(v).strip().lower()
    if s in ('immediate', 'manual'):
        return s
    try:
        n = float(s)
    except ValueError:
        return s
    return '<3' if n < 3 else ('3-5' if n <= 5 else '>5')

def _merchant_ok(f, m, vol, fpct):
    if not _wild(f.get('account_type')) and m['account_type'] not in f['account_type']:
        return False
    if not _wild(f.get('merchant_category_code')) and m['merchant_category_code'] not in f['merchant_category_code']:
        return False
    if not _wild(f.get('capture_delay')) and _cd_bucket(m['capture_delay']) != str(f['capture_delay']).strip().lower():
        return False
    if not _in_range(f.get('monthly_volume'), vol):
        return False
    if not _in_range(f.get('monthly_fraud_level'), fpct):
        return False
    return True

def _tx_mask(f, tx):
    mask = pd.Series(True, index=tx.index)
    if not _wild(f.get('card_scheme')):
        mask &= tx['card_scheme'] == f['card_scheme']
    if not _wild(f.get('is_credit')):
        mask &= tx['_credit'] == bool(f['is_credit'])
    if not _wild(f.get('aci')):
        mask &= tx['aci'].isin(f['aci'])
    if not _wild(f.get('intracountry')):
        dom = tx['issuing_country'] == tx['acquirer_country']
        mask &= dom if float(f['intracountry']) == 1.0 else ~dom
    return mask

def _scope(merchant, month=None, day=None, months=None):
    p = load()[0]
    tx = p[p['merchant'] == merchant]
    if month is not None:
        tx = tx[tx['month'] == month]
    if months is not None:
        tx = tx[tx['month'].isin(months)]
    if day is not None:
        tx = tx[tx['day_of_year'] == day]
    return tx

def _fee(fee_id):
    return next(x for x in load()[1] if int(x['ID']) == int(fee_id))

def _match(f, merchant, tx):
    S = load()[3]
    m = load()[2][merchant]
    parts = []
    for (yr, mo), grp in tx.groupby(['year', 'month']):
        st = S.loc[(merchant, yr, mo)]
        if _merchant_ok(f, m, st['vol'], st['fraud_pct']):
            parts.append(grp[_tx_mask(f, grp)])
    return pd.concat(parts) if parts else tx.iloc[0:0]

def matching(fee_id, merchant, month=None, day=None, months=None):
    return _match(_fee(fee_id), merchant, _scope(merchant, month, day, months))

def applicable_fee_ids(merchant, month=None, day=None, months=None):
    tx = _scope(merchant, month, day, months)
    return sorted(int(f['ID']) for f in load()[1] if len(_match(f, merchant, tx)) > 0)

def fee_delta(fee_id, merchant, new_rate, month=None, day=None, months=None, include_refused=True):
    f = _fee(fee_id)
    tx = _match(f, merchant, _scope(merchant, month, day, months))
    if not include_refused:
        tx = tx[~tx['_refused']]
    return (new_rate - f['rate']) * tx['eur_amount'].sum() / 10000
