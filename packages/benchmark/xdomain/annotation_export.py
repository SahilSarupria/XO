"""Exports the clause set as a BLIND annotation sheet for an independent second annotator.

The first annotator's labels are deliberately NOT included, so the second annotator cannot be anchored by them.
Usage: python3 annotation_export.py [out.csv]
Fields to fill (see EVALUATION_PROTOCOL.md): type, modality, outcome, conditions, exceptions, temporal.
"""
import csv, json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
gold = json.load(open(f'{here}/xdomain.gold.json'))
out = sys.argv[1] if len(sys.argv) > 1 else f'{here}/annotation-sheet.csv'
with open(out, 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    w.writerow(['doc', 'id', 'text', 'type', 'modality', 'outcome', 'conditions', 'exceptions', 'temporal'])
    for doc, d in gold['documents'].items():
        for c in d['clauses']:
            w.writerow([doc, c['id'], c['text'], '', '', '', '', '', ''])
print('wrote', out, sum(len(d['clauses']) for d in gold['documents'].values()), 'clauses')
