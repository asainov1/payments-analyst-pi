import json, glob, os, math
import pandas as pd

_DATA = 'data'
_CACHE = {}

def _load():
    if _CACHE:
        return _CACHE['p'], _CACHE['fees'], _CACHE['merch']
    p = pd.read_csv(os.path.join(_DATA, 'payments.csv'))
    dt = pd.to_datetime(p['year'].astype(int).astype(str) + '-01-01') + pd.to_timedelta(p['day_of_year'] - 1, unit='D')
    p['month'] = dt.dt.month
    p['is_credit'] = p['is_credit'].astype(str).str.lower().eq('true')
    p['has_fraudulent_dispute'] = p['has_fraudulent_dispute'].astype(str).str.lower().eq('true')
    fees = json.load(open(os.path.join(_DATA, 'fees.json')))
    mfile = [f for f in glob.glob(os.path.join(_DATA, '*merchant*.json'))][0]
    merch = {m['merchant']: m for m in json.load(open(mfile))}
    _CACHE.update(p=p, fees=fees, merch=merch)
    return p, fees, merch

def _null(x):
    return x is None or (isinstance(x, float) and math.isnan(x))

def _wild(lst):
    return _null(lst) or (isinstance(lst, (list, tuple)) and len(lst) == 0)

def _num(s):
    s = str(s).strip().lower().replace('%', '').replace(',', '')
    mult = 1.0
    if s.endswith('k'):
        mult, s = 1e3, s[:-1]
    elif s.endswith('m'):
        mult, s = 1e6, s[:-1]
    return float(s) * mult

def _range_mask(spec, series):
    if _null(spec):
        return pd.Series(True, index=series.index)
    s = str(spec).strip()
    if s.startswith('<'):
        return series < _num(s[1:])
    if s.startswith('>'):
        return series > _num(s[1:])
    a, b = s.split('-')
    return (series >= _num(a)) & (series <= _num(b))

def _cd_bucket(cd):
    s = str(cd).strip().lower()
    if s in ('immediate', 'manual'):
        return s
    try:
        n = float(s)
    except ValueError:
        return s
    if n < 3:
        return '<3'
    if n <= 5:
        return '3-5'
    return '>5'

def _merchant_ok(f, m):
    if not _wild(f.get('account_type')) and m['account_type'] not in f['account_type']:
        return False
    if not _wild(f.get('merchant_category_code')) and int(m['merchant_category_code']) not in [int(x) for x in f['merchant_category_code']]:
        return False
    cd = f.get('capture_delay')
    if not _null(cd) and str(cd) != _cd_bucket(m['capture_delay']) and str(cd) != str(m['capture_delay']):
        return False
    return True

def _txns(merchant, months=None, days=None):
    p, fees, merch = _load()
    allm = p[p['merchant'] == merchant].copy()
    g = allm.groupby('month')
    vol = g['eur_amount'].sum()
    fr = allm[allm['has_fraudulent_dispute']].groupby('month')['eur_amount'].sum().reindex(vol.index).fillna(0) / vol * 100
    allm['mvol'] = allm['month'].map(vol)
    allm['mfr'] = allm['month'].map(fr)
    if months:
        allm = allm[allm['month'].isin(months)]
    if days:
        allm = allm[allm['day_of_year'].isin(days)]
    return allm, fees, merch[merchant]

def _fee_mask(f, df):
    m = pd.Series(True, index=df.index)
    if not _null(f.get('card_scheme')):
        m &= df['card_scheme'] == f['card_scheme']
    if not _null(f.get('is_credit')):
        m &= df['is_credit'] == bool(f['is_credit'])
    if not _wild(f.get('aci')):
        m &= df['aci'].isin(f['aci'])
    ic = f.get('intracountry')
    if not _null(ic):
        dom = df['issuing_country'] == df['acquirer_country']
        m &= dom if float(ic) == 1.0 else ~dom
    m &= _range_mask(f.get('monthly_volume'), df['mvol'])
    m &= _range_mask(f.get('monthly_fraud_level'), df['mfr'])
    return m

def applicable_fee_ids(merchant, months=None, days=None):
    df, fees, m = _txns(merchant, months, days)
    ids = []
    for f in fees:
        if _merchant_ok(f, m) and len(df) and _fee_mask(f, df).any():
            ids.append(int(f['ID']))
    return sorted(ids)

def rate_change_delta(merchant, fee_id, new_rate, months=None, days=None):
    df, fees, m = _txns(merchant, months, days)
    f = [x for x in fees if int(x['ID']) == int(fee_id)][0]
    if not _merchant_ok(f, m) or not len(df):
        return {'delta': 0.0, 'n': 0, 'eur': 0.0}
    sel = df[_fee_mask(f, df)]
    eur = float(sel['eur_amount'].sum())
    return {'delta': (new_rate - f['rate']) * eur / 10000, 'n': int(len(sel)), 'eur': eur, 'old_rate': f['rate']}
