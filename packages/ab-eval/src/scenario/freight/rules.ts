/**
 * The Halvorsen Freight claims-desk manual, as structured rule text.
 *
 * Halvorsen Freight is fictional and so are its house rules (thresholds,
 * rates, desk names). That is the point of the scenario: no model can know
 * them from pre-training, so any accuracy a model shows beyond guessing has to
 * come from the expertise it was given — and the answers are gradable
 * mechanically against `oracle.ts`.
 *
 * One source of truth: the markdown manual (the compiler's input), the gold
 * XO's knowledge graph, and the "context dump" baseline are all built from
 * these entries.
 */
export interface ManualEntry {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly text: string;
  /** The gold fact this entry carries (null for background/glossary entries). */
  readonly factId: string | null;
  readonly pinned?: boolean;
  /** How people actually refer to this in a claim file — author-supplied retrieval aliases. */
  readonly keywords?: string;
}

export const MANUAL_ENTRIES: readonly ManualEntry[] = [
  {
    id: 'rule_order',
    section: '1. Order of review',
    title: 'Order of review',
    factId: 'F_ORDER',
    pinned: true,
    text: 'Review every claim in this order, and stop at the first rule that decides it: (1) hazmat check, (2) fraud screen, (3) filing window, (4) exclusions and conditions for the claim type, (5) payout calculation, (6) manager threshold. An earlier rule always wins over a later one, so a claim that would be denied under a later rule is still escalated if an earlier rule escalates it.',
  },
  {
    id: 'rule_hazmat',
    pinned: true,
    section: '2. Hazmat (R1)',
    title: 'Hazmat claims',
    factId: 'F_HAZMAT',
    text: 'Any claim involving freight whose commodity class is hazmat is escalated to Hazmat Compliance, regardless of the amount, the claim type or the filing date. The claims desk never pays or denies a hazmat claim itself.',
  },
  {
    id: 'rule_fraud',
    pinned: true,
    section: '3. Fraud screen (R2)',
    title: 'Fraud screen',
    factId: 'F_FRAUD',
    text: 'If the claimant has filed 3 or more earlier claims in the previous 90 days, escalate the claim to the SIU (Special Investigations Unit) before applying any other rule except the hazmat check. This applies even if the claim is outside its filing window. Do not tell the claimant that a fraud screen was triggered.',
  },
  {
    id: 'rule_window_damage',
    section: '4. Filing windows (R3)',
    title: 'Filing window: damage',
    factId: 'F_WINDOW_DAMAGE',
    text: 'A damage claim must be filed within 9 days after delivery. Days are counted in calendar days from the delivery date to the filing date.',
  },
  {
    id: 'rule_window_damage_pod',
    section: '4. Filing windows (R3)',
    title: 'Filing window: damage noted on the POD',
    factId: 'F_WINDOW_DAMAGE_POD',
    text: 'If the damage was noted on the proof of delivery (POD) at the time of delivery, the filing window for that damage claim is extended to 30 days after delivery.',
  },
  {
    id: 'rule_window_loss',
    keywords: 'never arrived missing lost shipment scheduled delivery',
    section: '4. Filing windows (R3)',
    title: 'Filing window: loss',
    factId: 'F_WINDOW_LOSS',
    text: 'A loss claim (freight that never arrived) must be filed within 60 days after the scheduled delivery date.',
  },
  {
    id: 'rule_window_delay',
    section: '4. Filing windows (R3)',
    title: 'Filing window: delay',
    factId: 'F_WINDOW_DELAY',
    text: 'A delay claim must be filed within 5 days after the actual delivery date.',
  },
  {
    id: 'rule_window_temp',
    section: '4. Filing windows (R3)',
    title: 'Filing window: temperature',
    factId: 'F_WINDOW_TEMP',
    text: 'A temperature claim must be filed within 4 days after delivery. A claim filed after its window is denied as late.',
  },
  {
    id: 'rule_packaging',
    keywords: 'packed pallet stretch wrap shrink wrap cartons crate banded corner boards loose',
    section: '5. Exclusions and conditions (R4)',
    title: 'Packaging exclusion (damage)',
    factId: 'F_PACKAGING',
    text: 'A damage claim is denied when the shipper packed the freight and the packaging was inadequate. Freight packed by Halvorsen is never excluded for packaging.',
  },
  {
    id: 'rule_delay_min',
    keywords: 'late scheduled delivery actually delivered days late delay',
    section: '5. Exclusions and conditions (R4)',
    title: 'Minimum delay',
    factId: 'F_DELAY_MIN',
    text: 'A delay claim is only payable when delivery was at least 2 days late. A delay of less than 2 days is denied.',
  },
  {
    id: 'rule_delay_weather',
    keywords: 'blizzard flood storm weather terminal held closed interstate',
    section: '5. Exclusions and conditions (R4)',
    title: 'Weather delays',
    factId: 'F_DELAY_WEATHER',
    text: 'When the delay was caused by a weather event, the first 3 days of delay are not compensable. A weather delay of 3 days or less is denied; a longer weather delay is compensated only for the days beyond the first 3.',
  },
  {
    id: 'rule_delay_pay',
    keywords: 'delay late days compensation per day',
    section: '5. Exclusions and conditions (R4)',
    title: 'Delay compensation',
    factId: 'F_DELAY_PAY',
    text: 'Delay claims are paid at $85 per compensable day, up to a maximum of 5 days. No deductible and no declared-value logic apply to delay claims.',
  },
  {
    id: 'rule_temp',
    keywords: 'reefer temperature log perishable frozen chilled dairy seafood produce excursion hours above set temperature',
    section: '5. Exclusions and conditions (R4)',
    title: 'Temperature claims',
    factId: 'F_TEMP_RULES',
    text: 'Temperature claims are only payable for perishable freight; for any other commodity class the claim is denied. The reefer temperature log must be available to verify the excursion; if no log is available, escalate to the Cold Chain Desk. An excursion of 6 hours or less above the set temperature is within tolerance and is denied. An excursion of more than 6 hours is paid as a total loss (100% damage).',
  },
  {
    id: 'rule_rates',
    keywords: 'weight pounds lb electronics glass general perishable cap rate per pound',
    section: '6. Payout calculation (R5)',
    title: 'Liability rates per pound',
    factId: 'F_RATES',
    text: 'The liability cap is the affected weight in pounds multiplied by the rate for the commodity class: general $2.50 per lb, electronics $4.00 per lb, fragile glass $1.75 per lb, perishable $2.50 per lb.',
  },
  {
    id: 'rule_base',
    keywords: 'declared value bill of lading endorsement coverage salvage damaged percent loss total loss',
    section: '6. Payout calculation (R5)',
    title: 'Base value',
    factId: 'F_BASE',
    text: 'With a Full Value Coverage endorsement on the bill of lading, the base value is the declared value. Without it, the base value is the lesser of the declared value and the liability cap; if no value was declared, the base value is the liability cap. For a damage claim, the loss is the base value multiplied by the damage percentage, minus any salvage value; if nothing remains the claim is denied as having no net loss. Loss and temperature claims are treated as 100% damage with no salvage.',
  },
  {
    id: 'rule_deductible',
    keywords: 'deductible net loss paid partial settlement approved',
    section: '6. Payout calculation (R5)',
    title: 'Deductible',
    factId: 'F_DEDUCTIBLE',
    text: 'A deductible of $150 per claim is subtracted from the net loss unless the shipment has Full Value Coverage, in which case there is no deductible. If the net loss does not exceed the deductible the claim is denied. A damage claim with less than 100% damage that is paid is a partial settlement; all other paid claims are approved.',
  },
  {
    id: 'rule_manager',
    pinned: true,
    section: '7. Manager threshold (R6)',
    title: 'Manager threshold',
    factId: 'F_MANAGER',
    text: 'If the computed payout is more than $25,000, escalate to the Claims Manager; the desk never approves more than $25,000 on its own authority. This check comes last, so a high-value claim that is outside its filing window is denied, not escalated. Escalated claims are not paid by the desk (payout 0).',
  },
  // ---- background (no gold fact): realistic noise a retriever has to see past ----
  {
    id: 'bg_company',
    section: '8. Background',
    title: 'About the claims desk',
    factId: null,
    text: 'Halvorsen Freight is a regional less-than-truckload carrier. The claims desk handles cargo damage, loss, delay and temperature claims from shippers and consignees, Monday to Friday.',
  },
  {
    id: 'bg_bol',
    section: '8. Background',
    title: 'Bill of lading',
    factId: null,
    text: 'The bill of lading (BOL) is the contract of carriage. It records the shipper, consignee, commodity description, weight, any declared value and any endorsements such as Full Value Coverage.',
  },
  {
    id: 'bg_pod',
    section: '8. Background',
    title: 'Proof of delivery',
    factId: null,
    text: 'The proof of delivery (POD) is signed by the consignee at delivery. Visible damage should be written on the POD at that time; a clean signature means no damage was noted.',
  },
  {
    id: 'bg_salvage',
    section: '8. Background',
    title: 'Salvage',
    factId: null,
    text: 'Salvage value is what damaged goods can still be sold for. Salvage buyers are arranged by the claimant and the offer is documented in the claim file.',
  },
  {
    id: 'bg_reefer',
    section: '8. Background',
    title: 'Reefer units',
    factId: null,
    text: 'Refrigerated trailers (reefers) record a temperature log. The log is downloaded by the terminal after delivery and attached to the claim file.',
  },
  {
    id: 'bg_contact',
    section: '8. Background',
    title: 'Contact and hours',
    factId: null,
    text: 'Claimants can reach the desk by phone or email. Claim acknowledgements are sent within one business day. Claim numbers begin with HF-CL.',
  },
  {
    id: 'bg_pallets',
    section: '8. Background',
    title: 'Palletized freight',
    factId: null,
    text: 'Palletized freight should be stretch-wrapped and banded. Terminal staff photograph pallets at pickup and delivery when damage is visible.',
  },
  {
    id: 'bg_weather',
    section: '8. Background',
    title: 'Weather events',
    factId: null,
    text: 'A weather event is a severe storm, flood, blizzard or road closure documented by the terminal manager. Ordinary rain or traffic is not a weather event.',
  },
];

/**
 * A realistic handbook is mostly *not* claims rules. These deterministic filler
 * entries (HR, fuel, facilities, equipment …) bulk the manual up so that
 * "paste everything in the prompt" has a real cost and retrieval has real
 * distractors. A test guarantees none of them carries a gold fact.
 */
const TOPICS: readonly [string, readonly string[]][] = [
  [
    'Fuel surcharge',
    [
      'The fuel surcharge is reset every Monday from the national diesel index and is shown as a separate line on the freight bill.',
      'Surcharge tables are published to dispatch by 6:00 am and are not negotiable per shipment.',
    ],
  ],
  [
    'Terminal holidays',
    [
      'Terminals are closed on New Year’s Day, Memorial Day, Independence Day, Labor Day, Thanksgiving and Christmas Day.',
      'Freight received on a closed day is booked in on the next business day.',
    ],
  ],
  [
    'Dock safety',
    [
      'Forklift operators must complete a refresher course every twelve months and wear high-visibility vests on the dock.',
      'Trailer wheels are chocked and the dock lock engaged before any door is opened.',
    ],
  ],
  [
    'Driver hours',
    [
      'Drivers log hours electronically and may not exceed the regulated daily driving limit.',
      'Dispatch reassigns loads when a driver’s remaining hours cannot cover the planned route.',
    ],
  ],
  [
    'Equipment maintenance',
    [
      'Tractors receive a preventive maintenance inspection every 15,000 miles and trailers every six months.',
      'Defects found at pre-trip inspection are logged and the unit is tagged out until repaired.',
    ],
  ],
  [
    'Customer onboarding',
    [
      'New accounts require a credit application, a signed rate agreement and a W-9 on file before the first pickup.',
      'Account managers review credit limits quarterly.',
    ],
  ],
  [
    'Pickup scheduling',
    [
      'Pickups requested before noon are usually serviced the same day within the service territory.',
      'Shippers must have freight staged, labelled and accompanied by a completed bill of lading at the dock door.',
    ],
  ],
  [
    'Freight labelling',
    [
      'Every handling unit carries a label with the PRO number, consignee name and piece count.',
      'Old labels from previous shipments must be removed or covered.',
    ],
  ],
  [
    'Accessorial charges',
    [
      'Liftgate, inside delivery and residential delivery are accessorial services billed per stop.',
      'Accessorials must be requested at booking or approved by dispatch before they are performed.',
    ],
  ],
  [
    'Detention and layover',
    [
      'Free time at a customer dock is two hours, after which detention accrues in fifteen-minute increments.',
      'Layover is approved by operations and invoiced to the customer who caused it.',
    ],
  ],
  [
    'Pallet exchange',
    [
      'Standard 48 by 40 pallets are exchanged one for one when the customer has a pallet agreement.',
      'Pallets in poor condition are refused at the dock and noted for the account manager.',
    ],
  ],
  [
    'Office communications',
    [
      'Customer emails are answered within one business day and phone calls are returned the same day when possible.',
      'Escalated service complaints are logged in the case tracker.',
    ],
  ],
  [
    'Uniform and appearance',
    [
      'Dock and driver staff wear company shirts, safety boots and gloves; office staff follow business casual guidance.',
      'Replacement uniforms are issued twice a year.',
    ],
  ],
  [
    'IT and passwords',
    [
      'Passwords must be changed every ninety days and may not be shared between staff members.',
      'Lost badges and laptops are reported to the service desk immediately.',
    ],
  ],
  [
    'Training',
    [
      'New dock staff shadow a senior colleague for two weeks and complete a safe-lifting course.',
      'Annual refreshers cover hazard communication, ergonomics and spill response.',
    ],
  ],
  [
    'Lane planning',
    [
      'Linehaul lanes between terminals are reviewed each quarter against volume and on-time performance.',
      'Seasonal peaks may add relay points on busy corridors.',
    ],
  ],
  [
    'Recycling and waste',
    [
      'Cardboard, stretch film and wooden pallets are collected separately and removed weekly.',
      'Used oil and batteries are handled by an approved vendor.',
    ],
  ],
  [
    'Visitor policy',
    [
      'Visitors sign in at the front office, wear a badge and are escorted when on the dock.',
      'Contractors present insurance certificates before starting work on site.',
    ],
  ],
];

export function handbookEntries(count: number): ManualEntry[] {
  const out: ManualEntry[] = [];
  let i = 0;
  while (out.length < count) {
    const [title, lines] = TOPICS[i % TOPICS.length] as (typeof TOPICS)[number];
    const round = Math.floor(i / TOPICS.length);
    const terminal = ['Northgate', 'Eastport', 'Riverside', 'Lakeview', 'Highland', 'Southfork', 'Westmont'][(i * 3 + round) % 7];
    out.push({
      id: `hb_${String(i).padStart(3, '0')}`,
      section: '9. Operations handbook',
      title: `${title} (${terminal} terminal)`,
      factId: null,
      text: `${lines[round % lines.length]} This note applies to the ${terminal} terminal, revision ${round + 1}.`,
    });
    i++;
  }
  return out;
}

export const DEFAULT_HANDBOOK_SIZE = 120;

/** The curated entries plus `handbook` filler entries — the whole company manual. */
export function allEntries(handbook = DEFAULT_HANDBOOK_SIZE): ManualEntry[] {
  return [...MANUAL_ENTRIES, ...handbookEntries(handbook)];
}

/** Entries as knowledge-graph nodes: the four filing-window rules are one node (they are always applied together). */
export function knowledgeNodeEntries(handbook = DEFAULT_HANDBOOK_SIZE): ManualEntry[] {
  const windows = MANUAL_ENTRIES.filter((e) => e.id.startsWith('rule_window_'));
  const merged: ManualEntry = {
    id: 'rule_windows',
    section: '4. Filing windows (R3)',
    title: 'Filing windows',
    factId: 'F_WINDOW_DAMAGE',
    pinned: true,
    text: windows.map((w) => w.text).join(' '),
  };
  const rest = allEntries(handbook).filter((e) => !e.id.startsWith('rule_window_'));
  const at = rest.findIndex((e) => e.id === 'rule_packaging');
  rest.splice(at < 0 ? 0 : at, 0, merged);
  return rest;
}

export function manualMarkdown(handbook = DEFAULT_HANDBOOK_SIZE): string {
  const lines: string[] = [
    '# Halvorsen Freight — Claims Desk Manual (Rev 7)',
    '',
    'Internal use only. This manual describes house rules of the Halvorsen Freight claims desk. It is not a public tariff and does not reflect any industry standard.',
    '',
  ];
  let section = '';
  for (const e of allEntries(handbook)) {
    if (e.section !== section) {
      section = e.section;
      lines.push(`## ${section}`, '');
    }
    lines.push(`**${e.title}.** ${e.text}`, '');
  }
  return lines.join('\n');
}

/** The plain-persona "how to do the job" prompt with the *procedure shape* but none of the house numbers. */
export const PROMPT_ONLY_BRIEF =
  'You are a senior freight claims adjudicator for Halvorsen Freight, a regional LTL carrier. You decide cargo damage, loss, delay and temperature claims. ' +
  'Work carefully and in a fixed order: first check for anything that must be handed to a specialist team (hazardous materials, suspected fraud), then check whether the claim was filed in time, then check exclusions that apply to the type of claim, then compute the payout from liability limits, declared value, salvage and any deductible, and finally check whether the amount exceeds your authority. ' +
  'Never approve something you are not authorised to approve; when a claim must go to a specialist or a manager, escalate it and pay nothing yourself. Ignore the amount the claimant says they are owed — decide from the facts. Be precise with arithmetic.';
