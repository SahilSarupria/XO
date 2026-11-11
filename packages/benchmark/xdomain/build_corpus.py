"""Deterministic generator for the XO cross-domain candidate corpus (M0b).
All documents are SYNTHETIC and authored for this benchmark. Gold labels are hand-authored by the same author as the
documents (single annotator, not independently reviewed) — see README.md limitations. Re-running overwrites outputs.
Clause tuple: (id, text, type, modality, polarity, outcome, conds, exceptions, temporal, extra)
"""
import json, os, hashlib
D = {}
def doc(slug, title, domain, sections): D[slug] = dict(title=title, domain=domain, sections=sections)
C = lambda *a, **k: (a, k)

doc('leave', 'Employee Leave Policy', 'hr', [
 ('1. Annual Leave', [
  ('1.1','Full-time employees may take up to 20 days of annual leave per year.','permission','may','positive','none',0,0,False,{}),
  ('1.2','Leave requests longer than 5 days require line manager approval.','rule','must','positive','requires_approval',1,0,False,{}),
  ('1.3','If an employee has less than 90 days of service, annual leave is not permitted unless the HR director approves.','prohibition','must_not','negative','deny',1,1,False,{}),
  ('1.4','Leave must be requested at least 14 days in advance.','obligation','must','positive','none',0,0,True,{}),
  ('1.5','If the leave balance is insufficient or the request overlaps a blackout period, the request must be rejected.','rule','must','negative','deny',2,0,False,{'connective':'or'})]),
 ('2. Sick Leave', [
  ('2.1','Employees must provide a medical certificate when absent for more than 3 consecutive days.','obligation','must','positive','none',1,0,True,{}),
  ('2.2','Sick leave is never deducted from annual leave.','prohibition','must_not','negative','none',0,0,False,{})])])
doc('loan', 'Equipment Loan Policy', 'operations', [
 ('1. Eligibility', [
  ('1.1','Staff may borrow equipment for up to 30 days.','permission','may','positive','none',0,0,True,{}),
  ('1.2','If the equipment value exceeds 2000 USD, department head approval is required.','rule','must','positive','requires_approval',1,0,False,{}),
  ('1.3','Loans are not permitted for contractors, except when a sponsor employee signs the loan form.','prohibition','must_not','negative','deny',1,1,False,{})]),
 ('2. Returns', [
  ('2.1','If equipment is returned more than 7 days late, the borrower is suspended from borrowing for 90 days.','rule','must','positive','none',1,0,True,{'label_disputed':'consequence statement; "must" vs declarative needs second-annotator review'}),
  ('2.2','When equipment is returned damaged and the damage is not caused by normal use, the borrower must pay the repair cost.','obligation','must','positive','none',2,0,False,{'negation':True,'connective':'and'})])])
doc('sop', 'Incident Response SOP', 'it-ops', [
 ('1. Detection', [
  ('1.1','The on-call engineer must acknowledge the alert within 15 minutes.','obligation','must','positive','none',0,0,True,{}),
  ('1.2','The on-call engineer must open an incident ticket and assign a severity.','procedure','must','positive','none',0,0,False,{'compound_actions':2})]),
 ('2. Escalation', [
  ('2.1','If severity is 1 or the outage lasts more than 60 minutes, notify the engineering director.','rule','must','positive','escalate',2,0,True,{'connective':'or','label_disputed':'outcome: "notify" is a notification, not an explicit escalation/referral; second-annotator review needed'}),
  ('2.2','After resolution, the incident owner must write a post-incident report within 5 business days.','obligation','must','positive','none',1,0,True,{})]),
 ('3. Definitions', [
  ('3.1','Severity 1 means a complete outage of a customer-facing service.','definition','declarative','positive','none',0,0,False,{})])])
doc('contract', 'Software Services Agreement', 'legal', [
 ('1. Payment', [
  ('1.1','The Customer shall pay each invoice within 30 days of receipt.','obligation','must','positive','none',0,0,True,{}),
  ('1.2','If payment is late by more than 15 days, the Supplier may suspend the service.','permission','may','positive','none',1,0,True,{}),
  ('1.3','Late payments accrue interest at 1.5% per month.','obligation','declarative','positive','none',0,0,True,{})]),
 ('2. Termination', [
  ('2.1','Either party may terminate this Agreement with 60 days written notice.','permission','may','positive','none',0,0,True,{}),
  ('2.2','The Supplier shall not terminate for convenience during the first 12 months unless the Customer is in material breach.','prohibition','must_not','negative','none',0,1,True,{})]),
 ('3. Confidentiality', [
  ('3.1',"Each party must keep the other party's confidential information secret and must not disclose it to third parties.",'obligation','must','positive','none',0,0,False,{'compound_actions':2})])])
doc('warranty', 'Product Warranty Policy', 'consumer', [
 ('1. Coverage', [
  ('1.1','The warranty period is 24 months from the date of purchase.','definition','declarative','positive','none',0,0,True,{}),
  ('1.2','A claim within the warranty period is approved if the defect is a manufacturing defect and proof of purchase is provided.','rule','declarative','positive','approve',3,0,True,{'connective':'and'}),
  ('1.3','Damage caused by misuse is not covered.','rule','declarative','negative','deny',0,0,False,{}),
  ('1.4','If the product has been repaired by an unauthorised party, the warranty is void unless the repair was approved in writing by the manufacturer.','rule','declarative','negative','deny',1,1,False,{}),
  ('1.5','Replacement is offered only when repair is not possible within 30 days.','rule','declarative','positive','none',1,0,True,{'negation':True}),
  ('1.6','Claims over 5,000 USD must be referred to the warranty committee.','rule','must','positive','escalate',1,0,False,{})])])
doc('procurement', 'Procurement Approval Policy', 'finance', [
 ('1. Approval Limits', [
  ('1.1','Purchases up to 1,000 USD may be approved by the department manager.','permission','may','positive','approve',1,0,False,{'conflicts_with':'1.6'}),
  ('1.2','Purchases above 1,000 USD and up to 10,000 USD require approval from the finance director.','rule','must','positive','requires_approval',2,0,False,{'connective':'and'}),
  ('1.3','Purchases above 10,000 USD require approval from the board.','rule','must','positive','requires_approval',1,0,False,{}),
  ('1.4','A purchase must not be split into smaller orders to avoid an approval threshold.','prohibition','must_not','negative','none',0,0,False,{}),
  ('1.5','Purchases from a vendor that is not on the approved vendor list must be approved by the procurement head regardless of value.','rule','must','positive','requires_approval',1,0,False,{'negation':True}),
  ('1.6','Purchases up to 1,500 USD may be approved by the department manager.','permission','may','positive','approve',1,0,False,{'conflicts_with':'1.1'})])])
doc('travel', 'Employee Travel and Expense Policy', 'hr-finance', [
 ('1. Reimbursement', [
  ('1.1','Employees may claim reimbursement for eligible travel expenses if receipts are submitted within 30 days.','permission','may','positive','approve',2,0,True,{'connective':'and'}),
  ('1.2','Expenses exceeding ₹50,000 require manager approval.','rule','must','positive','requires_approval',1,0,False,{'currency':'INR'}),
  ('1.3','Alcohol purchases are never reimbursable.','prohibition','must_not','negative','deny',0,0,False,{}),
  ('1.4','Hotel rates should be reasonable for the city of travel.','obligation','should','positive','none',0,0,False,{'requires_review':True,'reason':'vague standard'}),
  ('1.5','Employees travelling internationally must obtain approval before booking.','obligation','must','positive','requires_approval',1,0,True,{}),
  ('1.6','Meal expenses above ₹2,000 are denied unless the employee is on an approved client trip.','rule','declarative','negative','deny',1,1,False,{'currency':'INR'})])])
doc('research', 'Clinical Study Abstract', 'research', [
 ('1. Results', [
  ('1.1','The study enrolled 240 participants across three hospitals.','reference','declarative','positive','none',0,0,False,{}),
  ('1.2','Participants receiving the intervention showed a 12% reduction in symptoms.','reference','declarative','positive','none',0,0,False,{}),
  ('1.3','Larger trials are needed to confirm these findings.','reference','declarative','positive','none',0,0,False,{})])])

doc('facility', 'Facility Access Policy', 'facilities', [
 ('1. Entry', [
  ('1.1','If the badge is missing or the visitor is unregistered, entry must be denied.','rule','must','negative','deny',2,0,False,{'connective':'or'}),
  ('1.2','If the badge is valid and the visitor is escorted by a staff member, entry is permitted.','rule','may','positive','approve',2,0,False,{'connective':'and','label_note':'corrected from declarative: text says "is permitted" (annotation error found during M1 review)'}),
  ('1.3','If the badge is valid, the visitor is registered, the area is open, and the escort is present, entry may proceed.','rule','may','positive','approve',4,0,False,{'connective':'and'}),
  ('1.4','If the badge is valid, the visitor is registered, approve the entry.','rule','must','positive','approve',2,0,False,{'connective':'and'})])])

here = os.path.dirname(os.path.abspath(__file__)); os.makedirs(f'{here}/corpus', exist_ok=True)
gold = {'schemaVersion': 1, 'suiteId': 'xdomain-candidate-v0', 'status': 'candidate (not an accepted baseline)',
        'annotation': 'single annotator (author), not independently reviewed; documents are synthetic', 'documents': {}}
fields = ['id','text','type','modality','polarity','outcome','conditions','exceptions','temporal','extra']
for slug, d in D.items():
    md = [f"# {d['title']}"]; clauses = []
    for sec, items in d['sections']:
        md.append(f'## {sec}')
        for t in items:
            md.append(f'{t[0]} {t[1]}'); clauses.append(dict(zip(fields, t)))
    open(f'{here}/corpus/{slug}.md','w').write('\n'.join(md)+'\n')
    gold['documents'][slug] = {'title': d['title'], 'domain': d['domain'], 'clauses': clauses}
json.dump(gold, open(f'{here}/xdomain.gold.json','w'), ensure_ascii=False, indent=1)
print('docs', len(D), 'clauses', sum(len(v['clauses']) for v in gold['documents'].values()))
