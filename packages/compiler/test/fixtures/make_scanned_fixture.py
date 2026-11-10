"""Generates scanned-and-mixed.pdf: page 1 is real text, pages 2 and 3 are image-only (no text layer), like a scan.
Synthetic; regenerate with: python3 make_scanned_fixture.py"""
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont

W, H = A4
FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 30)

def scan(lines):
    img = Image.new("L", (1240, 1754), 255)
    d = ImageDraw.Draw(img)
    y = 120
    for t in lines:
        d.text((100, y), t, font=FONT, fill=0)
        y += 60
    return img

c = canvas.Canvas("scanned-and-mixed.pdf", pagesize=A4)
c.setFont("Helvetica-Bold", 14); c.drawString(72, H - 80, "Claims Handling Guide")
c.setFont("Helvetica", 11)
c.drawString(72, H - 110, "The claims handler shall verify policy status before any further processing.")
c.showPage()
for lines in (
    ["Claim Assessment", "If the claim assessment amount exceeds 10000, then deny the claim."],
    ["Notification", "The Insured must notify the Insurer within 7 days of becoming aware of the loss."],
):
    c.drawImage(ImageReader(scan(lines)), 0, 0, width=W, height=H)
    c.showPage()
c.save()
