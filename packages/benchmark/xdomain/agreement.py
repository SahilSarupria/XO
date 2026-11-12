"""Inter-annotator agreement between two label files over the same clauses.

Inputs: two CSVs with columns doc,id,type,modality,outcome,conditions,exceptions,temporal (the second annotator's sheet, and a
CSV derived from the first annotator's gold via `--gold`). Prints per-field raw agreement and Cohen's kappa (categorical
fields) and lists every disagreement for adjudication. Disagreements are RESOLVED BY A PERSON, never by a rule.
Usage: python3 agreement.py <annotator2.csv> [--gold]      (the first annotator is read from xdomain.gold.json)
       python3 agreement.py --self-test                     (gold against itself; must give kappa 1.0)
"""
import csv, json, os, sys
from collections import Counter
here = os.path.dirname(os.path.abspath(__file__))
FIELDS = ['type', 'modality', 'outcome', 'conditions', 'exceptions', 'temporal']

def first_annotator():
    g = json.load(open(f'{here}/xdomain.gold.json'))
    rows = {}
    for doc, d in g['documents'].items():
        for c in d['clauses']:
            rows[(doc, c['id'])] = {'type': c['type'], 'modality': c['modality'], 'outcome': c['outcome'], 'conditions': str(c['conditions']), 'exceptions': str(c['exceptions']), 'temporal': str(bool(c['temporal'])).lower()}
    return rows

def read_sheet(path):
    rows = {}
    for r in csv.DictReader(open(path, encoding='utf-8')):
        rows[(r['doc'], r['id'])] = {f: (r.get(f) or '').strip().lower() for f in FIELDS}
    return rows

def kappa(pairs):
    n = len(pairs)
    if n == 0: return float('nan')
    po = sum(1 for a, b in pairs if a == b) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum((ca[k] / n) * (cb[k] / n) for k in set(ca) | set(cb))
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)

def compare(a, b):
    keys = sorted(set(a) & set(b))
    missing = sorted(set(a) ^ set(b))
    print(f'clauses compared: {len(keys)}; present in only one file: {len(missing)}')
    disagreements = []
    for f in FIELDS:
        pairs = [(str(a[k][f]).lower(), str(b[k][f]).lower()) for k in keys if b[k][f] != '']
        if not pairs: print(f'{f:11} no labels from annotator 2'); continue
        agree = sum(1 for x, y in pairs if x == y) / len(pairs)
        print(f'{f:11} agreement {agree*100:5.1f}%  kappa {kappa(pairs):5.2f}  (n={len(pairs)})')
        disagreements += [(k, f, x, y) for k, (x, y) in zip([k for k in keys if b[k][f] != ''], pairs) if x != y]
    print(f'\n{len(disagreements)} disagreement(s) to adjudicate by a person:')
    for (doc, cid), f, x, y in disagreements: print(f'  {doc}/{cid} {f}: annotator1={x!r} annotator2={y!r}')

if __name__ == '__main__':
    if '--self-test' in sys.argv:
        a = first_annotator(); compare(a, {k: dict(v) for k, v in a.items()}); sys.exit(0)
    compare(first_annotator(), read_sheet(sys.argv[1]))
