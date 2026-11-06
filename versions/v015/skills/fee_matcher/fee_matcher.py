import json, os, datetime
import pandas as pd

_D = 'data'
_FEES = json.load(open(os.path.join(_D, 'fees.json')))
_FEES_BY_ID = {f['ID']: f for f in _FEES}
_PAY = pd.read_csv(os.path.join(_D, 'payments.csv'))
_PAY['month'] = _PAY['day_of_year'].apply(lambda d: (datetime.date(2023, 1, 1) + datetime.timedelta(days=int(d) - 1)).month)
_mpath = os.path.join(_D, 'merchant_data.json')
_MER = {m['merchant']: m for m in json.load(open(_mpath))} if os.path.exists(_mpath) else {}

def _num(s):
    s = str(s).strip().lower().replace('%', '').replace(',', '')
    mult = 1
    if s.endswith('k'): mult, s = 1e3, s[:-1]
    elif s.endswith('m'): mult, s = 1e6, s[:-1]
    return float(s) * mult

def _in_range(spec, val):
    if spec is None: return True
    s = str(spec).strip()
    if s.startswith('<'): return val < _num(s[1:])
    if s.startswith('>'): return val > _num(s[1:])
    if '-' in s:
        lo, hi = s.split('-', 1)
        return _num(lo) <= val <= _num(hi)
    return val == _num(s)

def _cap_ok(spec, mval):
    if spec is None: return True
    m = str(mval).lower()
    if spec in ('immediate', 'manual'): return m == spec
    try:
        return _in_range(spec, float(m))
    except ValueError:
        return False

def _list_ok(spec, v):
    return spec is None or len(spec) == 0 or v in spec

def _month_stats(merchant):
    p = _PAY[_PAY.merchant == merchant]
    out = {}
    for m, g in p.groupby('month'):
        vol = g.eur_amount.sum()
        fr = g.loc[g.has_fraudulent_dispute.astype(bool), 'eur_amount'].sum() / vol * 100 if vol else 0
        out[m] = (vol, fr)
    return out

def _match_mask(f, merchant, txns, stats):
    m = _MER[merchant]
    if f.get('card_scheme') is not None:
        txns = txns[txns.card_scheme == f['card_scheme']]
    if not _list_ok(f.get('account_type'), m['account_type']): return txns.iloc[0:0]
    if not _list_ok(f.get('merchant_category_code'), m['merchant_category_code']): return txns.iloc[0:0]
    if not _cap_ok(f.get('capture_delay'), m['capture_delay']): return txns.iloc[0:0]
    if f.get('is_credit') is not None:
        txns = txns[txns.is_credit.astype(bool) == bool(f['is_credit'])]
    if f.get('aci'):
        txns = txns[txns.aci.isin(f['aci'])]
    if f.get('intracountry') is not None:
        intra = (txns.issuing_country == txns.acquirer_country).astype(float)
        txns = txns[intra == float(f['intracountry'])]
    ok_months = [mo for mo, (vol, fr) in stats.items() if _in_range(f.get('monthly_volume'), vol) and _in_range(f.get('monthly_fraud_level'), fr)]
    return txns[txns.month.isin(ok_months)]

def show_fee(fid):
    print(_FEES_BY_ID[fid])

def matching_txns(fid, merchant, month=None):
    t = _PAY[_PAY.merchant == merchant]
    if month is not None: t = t[t.month == month]
    return _match_mask(_FEES_BY_ID[fid], merchant, t, _month_stats(merchant))

def fee_delta(fid, merchant, new_rate, month=None):
    f = _FEES_BY_ID[fid]
    t = matching_txns(fid, merchant, month)
    vol = t.eur_amount.sum()
    d = (new_rate - f['rate']) * vol / 10000
    print({'fee': f, 'n_txns': len(t), 'volume': vol, 'delta': d, 'delta_14dp': round(d, 14)})
    return d

def applicable_fees(merchant, month=None):
    t = _PAY[_PAY.merchant == merchant]
    if month is not None: t = t[t.month == month]
    stats = _month_stats(merchant)
    ids = sorted(f['ID'] for f in _FEES if len(_match_mask(f, merchant, t, stats)) > 0)
    print(', '.join(map(str, ids)))
    return ids
