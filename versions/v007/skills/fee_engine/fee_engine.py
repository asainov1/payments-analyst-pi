import json, os, glob
import pandas as pd

_S = {}

def _find(part, ext):
    for base in ('data', '../data', '.', '..'):
        for p in sorted(glob.glob(os.path.join(base, '*' + ext))):
            b = os.path.basename(p)
            if b.startswith(part) and not b.startswith(part + '_m'):
                return p
    raise FileNotFoundError(part + ext)

def load():
    if _S:
        return
    pay = pd.read_csv(_find('payments', '.csv'))
    d = pd.to_datetime(pay['year'].astype(str) + '-01-01') + pd.to_timedelta(pay['day_of_year'] - 1, unit='D')
    pay['month'] = d.dt.month
    pay['intra'] = pay['issuing_country'] == pay['acquirer_country']
    pay['fraud_eur'] = pay['eur_amount'].where(pay['has_fraudulent_dispute'].astype(bool), 0.0)
    g = pay.groupby(['merchant', 'year', 'month']).agg(vol=('eur_amount', 'sum'), fr=('fraud_eur', 'sum'))
    g['fr_pct'] = 100.0 * g['fr'] / g['vol']
    _S['pay'] = pay
    _S['stats'] = g
    _S['fees'] = json.load(open(_find('fees', '.json')))
    _S['mer'] = {m['merchant']: m for m in json.load(open(_find('merchant', '.json')))}

def _num(x):
    x = x.strip().lower().replace('%', '')
    mult = 1.0
    if x.endswith('k'):
        mult, x = 1e3, x[:-1]
    elif x.endswith('m'):
        mult, x = 1e6, x[:-1]
    return float(x) * mult

def _inrange(s, v):
    if s is None:
        return True
    if s.startswith('<'):
        return v < _num(s[1:])
    if s.startswith('>'):
        return v > _num(s[1:])
    a, b = s.split('-')
    return _num(a) <= v <= _num(b)

def _cd(v):
    v = str(v)
    if v in ('immediate', 'manual'):
        return v
    x = float(v)
    if x < 3:
        return '<3'
    if x <= 5:
        return '3-5'
    return '>5'

def _empty(x):
    return x is None or (isinstance(x, list) and len(x) == 0)

def _match(f, m, cs, cr, aci, intra, vol, frp):
    if f.get('card_scheme') is not None and f['card_scheme'] != cs:
        return False
    if not _empty(f.get('account_type')) and m['account_type'] not in f['account_type']:
        return False
    if f.get('capture_delay') is not None and f['capture_delay'] != _cd(m['capture_delay']):
        return False
    if not _empty(f.get('merchant_category_code')) and int(m['merchant_category_code']) not in [int(c) for c in f['merchant_category_code']]:
        return False
    if f.get('is_credit') is not None and bool(f['is_credit']) != cr:
        return False
    if not _empty(f.get('aci')) and aci not in f['aci']:
        return False
    if f.get('intracountry') is not None and bool(f['intracountry']) != intra:
        return False
    if not _inrange(f.get('monthly_volume'), vol):
        return False
    if not _inrange(f.get('monthly_fraud_level'), frp):
        return False
    return True

def match_table(merchant, year=2023, month=None, day=None):
    load()
    p = _S['pay']
    p = p[(p['merchant'] == merchant) & (p['year'] == year)]
    if month is not None:
        p = p[p['month'] == month]
    if day is not None:
        p = p[p['day_of_year'] == day]
    p = p.copy()
    m = _S['mer'][merchant]
    cache = {}
    out = []
    for cs, cr, aci, intra, mo in zip(p['card_scheme'], p['is_credit'], p['aci'], p['intra'], p['month']):
        k = (cs, bool(cr), aci, bool(intra), int(mo))
        if k not in cache:
            st = _S['stats'].loc[(merchant, year, k[4])]
            cache[k] = [f['ID'] for f in _S['fees'] if _match(f, m, k[0], k[1], k[2], k[3], st['vol'], st['fr_pct'])]
        out.append(cache[k])
    p['fee_ids'] = out
    return p

def applicable_fee_ids(merchant, year=2023, month=None, day=None):
    p = match_table(merchant, year, month, day)
    ids = set()
    for l in p['fee_ids']:
        ids.update(l)
    return sorted(ids)

def fee_cost(fee_id, amount):
    load()
    f = next(x for x in _S['fees'] if x['ID'] == fee_id)
    return f['fixed_amount'] + f['rate'] * amount / 10000.0

def fee_delta(merchant, fee_id, new_rate, year=2023, month=None, day=None):
    p = match_table(merchant, year, month, day)
    f = next(x for x in _S['fees'] if x['ID'] == fee_id)
    hit = p[p['fee_ids'].apply(lambda l: fee_id in l)]
    ok = hit[~hit['is_refused_by_psp'].astype(bool)]
    v, vo = float(hit['eur_amount'].sum()), float(ok['eur_amount'].sum())
    r = f['rate']
    return {'fee_id': fee_id, 'old_rate': r, 'new_rate': new_rate, 'n': len(hit), 'volume': v, 'delta': (new_rate - r) * v / 10000.0, 'n_ok': len(ok), 'volume_ok': vo, 'delta_ok': (new_rate - r) * vo / 10000.0}
