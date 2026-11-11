#!/usr/bin/env python3
"""Generates the SYNTHETIC insurance development corpus (PDFs + labels.json).

NOT independent evidence (CRD-06): the author of these documents also built the extractor they
exercise. Use it to find and fix gaps and to catch regressions; never to claim customer-level quality.
Deterministic: same script -> same PDFs/labels.
"""
import json, os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle, FrameBreak

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "pdfs")
os.makedirs(OUT, exist_ok=True)
S = getSampleStyleSheet()

# Each item: ("h", text) heading | ("p", text, rule_label_or_None) | ("t", rows, [rule labels per row or None])
# rule label = (family, key facts that must survive extraction)
DOCS = {}

DOCS["health_policy_wording"] = ("Health Insurance Policy Wording", "single", [
    ("h", "1. Waiting Periods"),
    ("p", "1.1 A waiting period of 30 days applies to all illnesses from the policy start date, except accidents.", ("waiting_period", ["30 days"])),
    ("p", "1.2 Pre-existing conditions are covered only after 24 months of continuous coverage.", ("waiting_period", ["24 months"])),
    ("p", "1.3 Maternity expenses will be covered after a waiting period of 9 months.", ("waiting_period", ["9 months"])),
    ("h", "2. Deductibles and Co-payment"),
    ("p", "2.1 The Insured must pay a deductible of 500 per claim before the Insurer pays any amount.", ("deductible", ["500"])),
    ("p", "2.2 A co-payment of 10% applies to every claim for insured persons above the age of 60.", ("copay", ["10%", "60"])),
    ("h", "3. Claims Notification"),
    ("p", "3.1 The Insured must notify the Insurer of a hospitalisation within 48 hours of admission.", ("deadline", ["48 hours"])),
    ("p", "3.2 Claim documents must be submitted within 15 days after discharge from hospital.", ("deadline", ["15 days"])),
    ("p", "3.3 The Insurer shall acknowledge each claim within 3 working days of receipt.", ("deadline", ["3 working days"])),
    ("p", "3.4 The Insurer shall settle or reject a claim within 30 days of receiving all documents.", ("deadline", ["30 days"])),
    ("h", "4. Limits"),
    ("p", "4.1 Room rent is limited to 1% of the sum insured per day.", ("limit", ["1%"])),
    ("p", "4.2 The maximum payable for cataract surgery is 25000 per eye.", ("limit", ["25000"])),
    ("h", "5. Exclusions"),
    ("p", "5.1 The Insurer will not pay for cosmetic surgery unless it is required following an accident.", ("prohibition", ["cosmetic surgery"])),
    ("p", "5.2 Claims arising from self-inflicted injury are not covered.", ("prohibition", ["self-inflicted"])),
    ("p", "5.3 If the Insured fails to disclose a material fact, the Insurer may reject the claim.", ("condition", ["material fact"])),
])

DOCS["motor_policy_wording"] = ("Private Motor Insurance Policy", "single", [
    ("h", "1. Excess"),
    ("p", "1.1 A compulsory excess of 250 applies to each own-damage claim.", ("deductible", ["250"])),
    ("p", "1.2 An additional excess of 500 applies if the driver is under 25 years of age.", ("deductible", ["500", "25"])),
    ("h", "2. Reporting"),
    ("p", "2.1 The policyholder must report an accident to the Insurer within 24 hours.", ("deadline", ["24 hours"])),
    ("p", "2.2 The policyholder must report theft to the police immediately and to the Insurer within 48 hours.", ("deadline", ["48 hours"])),
    ("p", "2.3 The policyholder must not admit liability or make any offer of payment without the written consent of the Insurer.", ("prohibition", ["liability"])),
    ("h", "3. Settlement"),
    ("p", "3.1 If the cost of repair exceeds 75% of the market value, the vehicle will be treated as a total loss.", ("condition", ["75%"])),
    ("p", "3.2 The Insurer will pay the market value of the vehicle immediately before the loss, less the applicable excess.", ("obligation", ["market value"])),
    ("p", "3.3 Settlement of a repairable claim shall be made within 10 working days of the repair invoice being received.", ("deadline", ["10 working days"])),
    ("h", "4. No Claim Discount"),
    ("p", "4.1 A no claim discount of 20% applies after one claim-free year and 40% after two claim-free years.", ("quantity", ["20%", "40%"])),
    ("p", "4.2 The no claim discount is forfeited if a claim is paid in the policy year.", ("condition", ["forfeited"])),
    ("h", "5. Cover Conditions"),
    ("p", "5.1 The Insurer is not liable for damage occurring while the driver is under the influence of alcohol.", ("prohibition", ["alcohol"])),
    ("p", "5.2 Cover is provided for use within the territory of the country only, unless extended in writing.", ("condition", ["territory"])),
])

DOCS["claims_sop"] = ("Claims Handling Standard Operating Procedure", "single", [
    ("h", "1. Registration"),
    ("p", "1.1 The claims handler must register every claim in the claims system on the day it is received.", ("deadline", ["day"])),
    ("p", "1.2 The claims handler shall verify policy status and premium payment before any further processing.", ("obligation", ["policy status"])),
    ("p", "1.3 If the policy has lapsed on the date of loss, the claim must be declined and the claimant informed in writing.", ("condition", ["lapsed"])),
    ("h", "2. Assessment"),
    ("p", "2.1 Claims above 10000 must be referred to a senior adjuster for approval.", ("limit", ["10000"])),
    ("p", "2.2 Claims above 50000 require approval from the claims manager and a loss-adjuster assessment.", ("limit", ["50000"])),
    ("p", "2.3 A site inspection must be completed within 5 working days of assignment for all property claims.", ("deadline", ["5 working days"])),
    ("p", "2.4 If fraud is suspected, the handler must escalate the claim to the Special Investigations Unit and must not communicate a decision to the claimant.", ("condition", ["fraud"])),
    ("h", "3. Payment"),
    ("p", "3.1 Payment must not be released until all required approvals are recorded in the claim file.", ("prohibition", ["approvals"])),
    ("p", "3.2 Approved payments shall be released within 7 days of final approval.", ("deadline", ["7 days"])),
    ("p", "3.3 The handler may grant an interim payment of up to 30% of the estimated loss where the claim is undisputed.", ("limit", ["30%"])),
    ("h", "4. Closure"),
    ("p", "4.1 A claim file shall be closed within 14 days after the final payment is confirmed.", ("deadline", ["14 days"])),
    ("p", "4.2 The claimant is entitled to a written explanation within 5 days of any rejection.", ("deadline", ["5 days"])),
])

DOCS["property_schedule_tables"] = ("Commercial Property Schedule of Benefits", "single", [
    ("h", "1. Schedule of Limits"),
    ("t", [["Coverage", "Limit", "Excess"],
           ["Buildings", "1000000", "1000"],
           ["Contents", "250000", "500"],
           ["Business interruption", "500000", "7 days"],
           ["Theft", "50000", "2500"]],
     [None, ("limit", ["Buildings", "1000000", "1000"]), ("limit", ["Contents", "250000", "500"]),
      ("limit", ["Business interruption", "500000", "7 days"]), ("limit", ["Theft", "50000", "2500"])]),
    ("h", "2. Conditions"),
    ("p", "2.1 The Insured must maintain a working fire alarm system at all insured premises.", ("obligation", ["fire alarm"])),
    ("p", "2.2 The Insurer will not pay for theft unless there is evidence of forcible entry.", ("prohibition", ["forcible entry"])),
    ("p", "2.3 Losses must be notified within 7 days of discovery.", ("deadline", ["7 days"])),
    ("h", "3. Waiting Periods"),
    ("t", [["Cover", "Waiting period"],
           ["Flood", "14 days"],
           ["Storm", "none"],
           ["Subsidence", "60 days"]],
     [None, ("waiting_period", ["Flood", "14 days"]), None, ("waiting_period", ["Subsidence", "60 days"])]),
])

DOCS["travel_two_column"] = ("Travel Insurance Terms", "twocol", [
    ("h", "1. Cancellation"),
    ("p", "1.1 Trip cancellation is covered up to 5000 per person if the insured falls ill before departure.", ("limit", ["5000"])),
    ("p", "1.2 The Insured must notify the Insurer of a cancellation within 72 hours of the cancellation event.", ("deadline", ["72 hours"])),
    ("p", "1.3 A medical certificate must be provided for every claim arising from illness.", ("obligation", ["medical certificate"])),
    ("h", "2. Baggage"),
    ("p", "2.1 Baggage loss is limited to 1500 per trip and 300 per single item.", ("limit", ["1500", "300"])),
    ("p", "2.2 Delay of baggage for more than 12 hours entitles the insured to an emergency purchase allowance of 200.", ("condition", ["12 hours", "200"])),
    ("h", "3. Medical"),
    ("p", "3.1 Emergency medical expenses are covered up to 100000 per person.", ("limit", ["100000"])),
    ("p", "3.2 The Insurer will not cover treatment for a condition that was diagnosed in the 12 months before the trip.", ("prohibition", ["12 months"])),
    ("p", "3.3 The Insured must contact the assistance provider within 24 hours of any hospital admission.", ("deadline", ["24 hours"])),
    ("h", "4. General"),
    ("p", "4.1 Claims must be submitted within 90 days after the end of the trip.", ("deadline", ["90 days"])),
    ("p", "4.2 No benefit is payable for activities undertaken against local government advice.", ("prohibition", ["government advice"])),
])

DOCS["underwriting_guidelines"] = ("Underwriting Referral Guidelines", "single", [
    ("h", "1. Authority Levels"),
    ("p", "1.1 Underwriters may accept risks with a sum insured up to 500000 without referral.", ("limit", ["500000"])),
    ("p", "1.2 Risks with a sum insured above 500000 must be referred to the underwriting manager.", ("limit", ["500000"])),
    ("p", "1.3 Applicants with more than 3 claims in the last 5 years must be referred and cannot be accepted at standard rates.", ("condition", ["3 claims", "5 years"])),
    ("h", "2. Required Information"),
    ("p", "2.1 The proposal form must be signed and dated by the applicant before a quotation is issued.", ("obligation", ["signed"])),
    ("p", "2.2 If the property is unoccupied for more than 30 days, the underwriter must apply the vacancy condition.", ("condition", ["30 days"])),
    ("h", "3. Quotations"),
    ("p", "3.1 A quotation is valid for 30 days from the date of issue.", ("deadline", ["30 days"])),
    ("p", "3.2 The underwriter shall respond to a broker submission within 2 working days.", ("deadline", ["2 working days"])),
    ("p", "3.3 Discounts exceeding 15% must not be offered without written approval.", ("prohibition", ["15%"])),
])


def build(name, title, layout, items):
    path = os.path.join(OUT, f"{name}.pdf")
    doc = BaseDocTemplate(path, pagesize=A4, title=title, author="XO synthetic corpus", invariant=1,
                          leftMargin=50, rightMargin=50, topMargin=60, bottomMargin=60)
    w, h = A4
    if layout == "twocol":
        gap = 20
        cw = (w - 100 - gap) / 2
        frames = [Frame(50, 60, cw, h - 120, id="c1"), Frame(50 + cw + gap, 60, cw, h - 120, id="c2")]
    else:
        frames = [Frame(50, 60, w - 100, h - 120, id="c1")]
    doc.addPageTemplates([PageTemplate(id="p", frames=frames)])
    story = [Paragraph(title, S["Title"]), Spacer(1, 12)]
    labels = []
    for it in items:
        if it[0] == "h":
            story.append(Paragraph(it[1], S["Heading2"]))
        elif it[0] == "p":
            story.append(Paragraph(it[1], S["BodyText"]))
            if it[2]:
                labels.append({"family": it[2][0], "text": it[1], "facts": it[2][1], "form": "prose"})
        else:
            rows, rl = it[1], it[2]
            t = Table(rows, hAlign="LEFT")
            t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                                   ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey)]))
            story.append(t)
            story.append(Spacer(1, 8))
            for row, lab in zip(rows, rl):
                if lab:
                    labels.append({"family": lab[0], "text": " | ".join(row), "facts": lab[1], "form": "table"})
    doc.build(story)
    return labels


def main():
    manifest = {
        "kind": "SYNTHETIC_DEVELOPMENT_CORPUS",
        "independent": False,
        "warning": "Authored by the same team as the extractor. Never held-out evidence (CRD-06). Dev/regression use only.",
        "documents": [],
    }
    for name, (title, layout, items) in DOCS.items():
        labels = build(name, title, layout, items)
        manifest["documents"].append({"id": name, "file": f"pdfs/{name}.pdf", "title": title, "layout": layout, "rules": labels})
    with open(os.path.join(HERE, "labels.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(sum(len(d["rules"]) for d in manifest["documents"]), "labelled rules in", len(manifest["documents"]), "documents")


main()
