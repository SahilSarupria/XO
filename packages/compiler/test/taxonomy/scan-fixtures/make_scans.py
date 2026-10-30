"""Generates the scanned-page taxonomy fixtures and their ground truth. SYNTHETIC: rendered from a font, then
rotated / skewed / degraded with a fixed seed. Regenerate with: python3 make_scans.py (needs Pillow, reportlab,
DejaVuSans). The outputs are committed, so CI does not need Python."""
import json, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
W_PT, H_PT = A4

PAGES = [
    ["Claim Assessment", "If the claim assessment amount exceeds 10000, then deny the claim.",
     "The Insurer shall pay the sum insured less the applicable excess.", "Theft is excluded unless there is evidence of forced entry."],
    ["Notification", "The Insured must notify the Insurer within 7 days of becoming aware of the loss.",
     "A waiting period of 30 days applies to all new claims.", "Cover under this section is limited to 50000 per event."],
    ["General Conditions", "The policy period is twelve months from the effective date.",
     "Flood damage is covered only where the premises are located above the flood line.",
     "No claim will be paid where the loss was caused by wear and tear."],
]
TWO_COL = [["Left column heading", "The Insured must notify the Insurer promptly.", "Theft is excluded without forced entry."],
           ["Right column heading", "A waiting period of 30 days applies.", "Cover is limited to 50000 per event."]]

def render(lines, dpi, columns=None):
    scale = dpi / 150.0
    img = Image.new("L", (int(W_PT / 72 * dpi), int(H_PT / 72 * dpi)), 255)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, max(10, int(30 * scale)))
    if columns:
        for ci, col in enumerate(columns):
            y = int(140 * scale)
            for t in col:
                d.text((int((100 + ci * 560) * scale), y), t, font=font, fill=0)
                y += int(70 * scale)
    else:
        y = int(140 * scale)
        for t in lines:
            d.text((int(100 * scale), y), t, font=font, fill=0)
            y += int(70 * scale)
    return img

def degrade(img, seed):
    rnd = random.Random(seed)
    px = img.load()
    for _ in range(img.width * img.height // 40):
        x, y = rnd.randrange(img.width), rnd.randrange(img.height)
        px[x, y] = max(0, min(255, px[x, y] + rnd.randint(-70, 70)))
    return img.filter(ImageFilter.GaussianBlur(0.8))

def pdf(path, images):
    c = canvas.Canvas(path, pagesize=A4, invariant=1)
    for img in images:
        c.drawImage(ImageReader(img), 0, 0, width=W_PT, height=H_PT)
        c.showPage()
    c.save()

truth = {}
def emit(name, images, lines_by_page):
    pdf(f"{name}.pdf", images)
    truth[name] = lines_by_page

emit("scan-clean-3p", [render(p, 150) for p in PAGES], PAGES)
for deg in (90, 180, 270):
    emit(f"scan-rotated-{deg}", [render(PAGES[0], 150).rotate(-deg, expand=True, fillcolor=255)], [PAGES[0]])
emit("scan-skewed-2deg", [render(PAGES[0], 150).rotate(2, expand=False, fillcolor=255)], [PAGES[0]])
emit("scan-noisy-100dpi", [degrade(render(PAGES[1], 100), 7)], [PAGES[1]])
emit("scan-two-column", [render(None, 150, columns=TWO_COL)], [TWO_COL[0] + TWO_COL[1]])
# Adversarial pages: there is NO correct text. A recovery tier must not return confident words for these.
def noise_only(seed):
    rnd = random.Random(seed)
    img = Image.new("L", (int(W_PT / 72 * 150), int(H_PT / 72 * 150)), 255)
    px = img.load()
    for _ in range(img.width * img.height // 6):
        px[rnd.randrange(img.width), rnd.randrange(img.height)] = rnd.randrange(256)
    return img

def random_strokes(seed):
    rnd = random.Random(seed)
    img = Image.new("L", (int(W_PT / 72 * 150), int(H_PT / 72 * 150)), 255)
    d = ImageDraw.Draw(img)
    for _ in range(260):
        x, y = rnd.randrange(100, 1100), rnd.randrange(100, 1600)
        d.line([(x, y), (x + rnd.randint(-60, 60), y + rnd.randint(-60, 60)), (x + rnd.randint(-90, 90), y + rnd.randint(-90, 90))], fill=0, width=rnd.randint(2, 5))
    return img

def tiny_text():
    img = Image.new("L", (int(W_PT / 72 * 150), int(H_PT / 72 * 150)), 255)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT_PATH, 5)
    y = 140
    for t in PAGES[0] * 6:
        d.text((100, y), t, font=f, fill=0)
        y += 9
    return img

emit("scan-adversarial-noise", [noise_only(11)], [[]])
emit("scan-adversarial-strokes", [random_strokes(5)], [[]])
emit("scan-adversarial-tiny-text", [tiny_text()], [[]])
json.dump(truth, open("scan-truth.json", "w"), indent=1)
print("ok", list(truth))
