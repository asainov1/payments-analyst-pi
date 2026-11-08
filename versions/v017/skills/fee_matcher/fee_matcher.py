import json, os, glob, datetime
import pandas as pd

def _find(name):
    for c in [os.path.join('data', name), name] + glob.glob('**/' + name, recursive=True):
        if os.path.exists(c):
            return c
    raise FileNotFoundError(name)

_P = pd.read_csv(_find('payments.csv'))
_F = json.load(open(_find('fees.json')))
try:
    _M = {m['merchant']: m for m in json.load(open(_find('merchant_data.json')))}
except Exception:
    _M = None
_P['month'] = _P.apply(lambda r: (datetime.date(int(r['year']), 1, 1) + datetime.timedelta(days=int(r['day_of_year']) - 1)).month, axis=1)
_P['intra'] = _P['issuing_country'] == _P['acquirer_country']

def _num(s):
    s = s.strip().lower().replace('%', '')
    mult = 1
    if s.endswith('k'): mult, s = 1e3, s[:-1]
    elif s.endswith('m'): mult, s = 1e6, s[:-1]
    return float(s) * mult

def _in_range(rule, v):
    if rule is None: return True
    r = rule.strip()
    if r.startswith('<'): return v < _num(r[1:])
    if r.startswith('>'): return v > _num(r[1:])
    a, b = r.split('-')
    return _num(a) <= v <= _num(b)

def _cd_bucket(cd):
    cd = str(cd)
    if cd in ('immediate', 'manual'): return cd
    d = float(cd)
    return '<3' if d < 3 else ('3-5' if d <= 5 else '>5')

def _empty(x):
    return x is None or (isinstance(x, float) and pd.isna(x)) or (isinstance(x, list) and len(x) == 0)

def _merchant(name):
    if _M is not None: return _M[name]
    raise ValueError('merchant_data.json not found; read merchant info via sql and pass it in')

def _month_stats(name):
    p = _P[_P.merchant == name]
    g = p.groupby('month')
    vol = g.eur_amount.sum()
    fr = p[p.has_fraudulent_dispute].groupby('month').eur_amount.sum().reindex(vol.index, fill_value=0) / vol * 100
    return vol.to_dict(), fr.to_dict()

def _match(f, t, m, vol, fr):
    if f['card_scheme'] is not None and f['card_scheme'] != t['card_scheme']: return False
    if not _empty(f['account_type']) and m['account_type'] not in f['account_type']: return False
    if not _empty(f['merchant_category_code']) and m['merchant_category_code'] not in f['merchant_category_code']: return False
    if f['capture_delay'] is not None and f['capture_delay'] != _cd_bucket(m['capture_delay']): return False
    if f['is_credit'] is not None and bool(f['is_credit']) != bool(t['is_credit']): return False
    if not _empty(f['aci']) and t['aci'] not in f['aci']: return False
    if not _empty(f['intracountry']) and bool(float(f['intracountry'])) != bool(t['intra']): return False
    if not _in_range(f['monthly_volume'], vol[t['month']]): return False
    if not _in_range(f['monthly_fraud_level'], fr[t['month']]): return False
    return True

def _txns(name, month):
    p = _P[_P.merchant == name]
    return p if month is None else p[p.month == month]

def applicable_fee_ids(name, month=None):
    m = _merchant(name); vol, fr = _month_stats(name)
    ids = set()
    for _, t in _txns(name, month).drop_duplicates(['card_scheme', 'is_credit', 'aci', 'intra', 'month']).iterrows():
        for f in _F:
            if _match(f, t, m, vol, fr): ids.add(f['ID'])
    return sorted(ids)

def fee_delta(name, fee_id, new_rate, month=None):
    m = _merchant(name); vol, fr = _month_stats(name)
    f = next(x for x in _F if x['ID'] == fee_id)
    tx = _txns(name, month)
    mask = tx.apply(lambda t: _match(f, t, m, vol, fr), axis=1) if len(tx) else []
    s = tx[mask].eur_amount.sum() if len(tx) else 0.0
    return {'delta': (new_rate - f['rate']) * s / 10000, 'n': int(sum(mask)) if len(tx) else 0, 'volume': s}

def total_fees(name, month=None):
    m = _merchant(name); vol, fr = _month_stats(name)
    tot = 0.0
    for _, t in _txns(name, month).iterrows():
        fs = [f for f in _F if _match(f, t, m, vol, fr)]
        if fs: tot += fs[0]['fixed_amount'] + fs[0]['rate'] * t['eur_amount'] / 10000
    return tot
