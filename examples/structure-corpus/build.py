"""Builds the UW-3b structure-corpus PDFs (deterministic: fixed metadata, no timestamps).

Run from the repository root:  python3 examples/structure-corpus/build.py
Needs reportlab (pip install reportlab). The PDFs are committed; this script documents exactly how they were made.
The documents are synthetic and cover kinds of structure, not any real organisation's procedures.
"""
import os
from reportlab import rl_config

rl_config.invariant = 1  # no timestamps or random ids: byte-identical output on every run
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.units import mm

HERE = os.path.dirname(os.path.abspath(__file__))
styles = getSampleStyleSheet()
body = ParagraphStyle('body', parent=styles['BodyText'], fontName='Helvetica', fontSize=9.5, leading=13)
bold = ParagraphStyle('bold', parent=body, fontName='Helvetica-Bold')
h1 = ParagraphStyle('h1', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=22, alignment=0)
h2 = ParagraphStyle('h2', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=14)


def doc(name, title, story):
    path = os.path.join(HERE, name)
    d = SimpleDocTemplate(path, pagesize=A4, leftMargin=22 * mm, rightMargin=22 * mm, topMargin=20 * mm, bottomMargin=20 * mm,
                          title=title, author='XO structure corpus', subject='synthetic test fixture', creator='build.py')
    d.build(story, onFirstPage=lambda c, _d: c.setPageCompression(1), onLaterPages=lambda c, _d: c.setPageCompression(1))
    print('wrote', path)


def grid(rows, widths, header=True):
    t = Table(rows, colWidths=widths, hAlign='LEFT')
    style = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('BOTTOMPADDING', (0, 0), (-1, -1), 6), ('LEFTPADDING', (0, 0), (-1, -1), 0)]
    if header:
        style.append(('LINEBELOW', (0, 0), (-1, 0), 0.5, colors.grey))
    t.setStyle(TableStyle(style))
    return t


def P(text, style=body):
    return Paragraph(text, style)


# 1. An SOP whose step table wraps, in a non-software domain.
sop_rows = [[P('#', bold), P('Step', bold), P('Instructions', bold), P('Done when', bold)]]
for n, (step, what, done) in enumerate([
    ('Isolate', 'Switch off the pump at the local panel. Lock the isolator and attach your personal tag to it.', 'Isolator locked and tagged'),
    ('Drain', 'Open the drain valve slowly and collect the fluid in an approved container. Record the volume drained.', 'Casing empty, volume recorded'),
    ('Inspect', 'Check the seal faces, the bearings and the coupling for wear or damage. Photograph anything unusual.', 'Inspection sheet completed'),
    ('Replace', 'Fit the new seal kit to the manufacturer torque settings. Never reuse an old gasket.', 'New seal fitted and torqued'),
    ('Restore', 'Remove your tag and lock, close the drain valve and restart the pump. Watch for leaks for ten minutes.', 'Pump running without leaks'),
], start=1):
    sop_rows.append([P(str(n)), P(step), P(what), P(done)])
doc('sop-wrapped-table.pdf', 'Pump seal replacement procedure', [
    P('Pump Seal Replacement', h1),
    P('Standard operating procedure for the maintenance team.', body),
    Spacer(1, 6 * mm),
    P('1. Procedure', h2),
    grid(sop_rows, [10 * mm, 24 * mm, 90 * mm, 42 * mm]),
])

# 2. A checklist with two ticked-off sections.
def checklist(items):
    return grid([[P('[ ]'), P(text)] for text in items], [12 * mm, 140 * mm], header=False)

doc('checklist.pdf', 'Event venue readiness checklist', [
    P('Venue Readiness', h1),
    P('1. Safety checklist', h2),
    checklist(['Fire exits are unlocked and clearly signed', 'First aid kit is stocked', 'Emergency contact list is posted at the entrance']),
    P('2. Setup checklist', h2),
    checklist(['Chairs arranged for 120 guests', 'Microphones tested', 'No cables left across walkways']),
])

# 3. A fill-in form followed by short numbered instructions.
form_rows = [[P('Reported by', bold), P('')], [P('Date of incident', bold), P('')], [P('Location', bold), P('Building / floor / room')],
             [P('Severity', bold), P('Low / Medium / High')], [P('Description', bold), P('What happened, in your own words?')]]
doc('form.pdf', 'Incident report form', [
    P('Incident Report', h1),
    P('1. Report details (fill in first)', h2),
    grid(form_rows, [40 * mm, 120 * mm], header=False),
    P('2. Rules for reporting', h2),
    grid([[P('1'), P('<b>Report within 24 hours.</b> Late reports cannot be investigated properly.')],
          [P('2'), P('<b>Never name a person as the cause.</b> Describe what happened, not who is to blame.')],
          [P('3'), P('<b>Keep the evidence.</b> Do not clean up the area until a supervisor has seen it.')]],
         [10 * mm, 150 * mm], header=False),
])

# 4. Guidelines: numbered rules with bold titles and explanatory bodies.
doc('guidelines.pdf', 'Data handling guidelines', [
    P('Data Handling Guidelines', h1),
    P('1. Principles', h2),
    grid([[P('1'), P('<b>Collect only what you need.</b> Every extra field is a liability.')],
          [P('2'), P('<b>Do not email personal data.</b> Use the secure share instead.')],
          [P('3'), P('<b>Encrypt laptops.</b> A lost laptop without encryption is a reportable breach.')],
          [P('4'), P('<b>You should review access every quarter.</b> Remove people who have changed role.')]],
         [10 * mm, 150 * mm], header=False),
])
