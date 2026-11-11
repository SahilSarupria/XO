"""Builds ingestion-layout variants (plain/table/two-column/scanned PDF, DOCX) of ASCII corpus docs. Synthetic."""
import json, os, io
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Table, Paragraph, Spacer, Frame, PageTemplate, BaseDocTemplate
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont
import docx
here = os.path.dirname(os.path.abspath(__file__)); out = f'{here}/formats'; os.makedirs(out, exist_ok=True)
gold = json.load(open(f'{here}/xdomain.gold.json'))
ss = getSampleStyleSheet()
for slug in ['loan', 'leave']:
    d = gold['documents'][slug]; title = d['title']; cl = d['clauses']
    # plain
    c = canvas.Canvas(f'{out}/{slug}.plain.pdf', pagesize=A4); y = 800; c.setFont('Helvetica-Bold', 14); c.drawString(50, y, title); y -= 30; c.setFont('Helvetica', 10)
    for k in cl:
        c.drawString(50, y, f"{k['id']} {k['text']}"[:120]); y -= 18
    c.save()
    # table-heavy
    doc = SimpleDocTemplate(f'{out}/{slug}.table.pdf', pagesize=A4)
    rows = [['Clause', 'Requirement']] + [[k['id'], Paragraph(k['text'], ss['Normal'])] for k in cl]
    doc.build([Paragraph(title, ss['Title']), Table(rows, colWidths=[50, 400], style=[('GRID', (0,0), (-1,-1), 0.5, '#000000')])])
    # two-column
    bd = BaseDocTemplate(f'{out}/{slug}.twocol.pdf', pagesize=A4); w, h = A4
    f1 = Frame(40, 40, w/2-50, h-80, id='a'); f2 = Frame(w/2+10, 40, w/2-50, h-80, id='b')
    bd.addPageTemplates([PageTemplate(frames=[f1, f2])])
    bd.build([Paragraph(title, ss['Title'])] + [x for k in cl for x in (Paragraph(f"{k['id']} {k['text']}", ss['Normal']), Spacer(1, 8))])
    # scanned (image only, no text layer)
    img = Image.new('L', (1240, 1754), 255); dr = ImageDraw.Draw(img)
    try: fnt = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 22)
    except Exception: fnt = ImageFont.load_default()
    yy = 80; dr.text((60, yy), title, fill=0, font=fnt); yy += 50
    for k in cl: dr.text((60, yy), f"{k['id']} {k['text']}"[:95], fill=0, font=fnt); yy += 34
    buf = io.BytesIO(); img.save(buf, 'PNG'); buf.seek(0)
    c = canvas.Canvas(f'{out}/{slug}.scanned.pdf', pagesize=A4); c.drawImage(ImageReader(buf), 0, 0, width=w, height=h); c.save()
    # docx
    dx = docx.Document(); dx.add_heading(title, 1)
    for k in cl: dx.add_paragraph(f"{k['id']} {k['text']}")
    dx.save(f'{out}/{slug}.docx')
print(sorted(os.listdir(out)))
