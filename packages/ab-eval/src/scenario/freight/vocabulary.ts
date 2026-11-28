import type { EvidenceLexiconEntryAttributes } from '@xo/knowledge-base';

/**
 * FREIGHT CLAIMS: evidence vocabulary. This is business knowledge, so it is data for the Business Knowledge Base, not code in the
 * runtime or in the rule trees. `names` lists the input names a concept goes by (the hand-built tree's and the compiler's);
 * `trees` scopes an entry where the same concept is read differently by different trees. Authored by the scenario's author and
 * reviewed into the BKB as `xo:EvidenceLexiconEntry` records (see bkb.ts).
 */
export const FREIGHT_EVIDENCE_VOCABULARY: readonly EvidenceLexiconEntryAttributes[] = [
  {
    "concept": "damage noted on the proof of delivery",
    "names": [
      "pod_damage_noted",
      "damage_noted_on_proof_of_delivery"
    ],
    "cues": [
      "proof of delivery",
      "pod",
      "delivery receipt",
      "delivery ticket",
      "delivery note",
      "delivery document",
      "cod receipt",
      "receipt",
      "signed for",
      "signed",
      "consignee",
      "receiver",
      "recipient",
      "exception",
      "noted on delivery",
      "waybill"
    ],
    "values": [
      {
        "value": true,
        "patterns": [
          "noted the damage",
          "wrote the damage",
          "damage was noted",
          "signed for it with exceptions",
          "signed with exceptions",
          "exceptions noted"
        ]
      },
      {
        "value": false,
        "patterns": [
          "signed clean",
          "signed with no exceptions",
          "no exceptions",
          "no damage noted",
          "clean receipt",
          "without exception"
        ]
      }
    ]
  },
  {
    "concept": "declared value of the goods",
    "names": [
      "declared_value_usd"
    ],
    "cues": [
      "declared",
      "declaration",
      "bill of lading",
      "bol",
      "b l",
      "worth",
      "stated value",
      "invoice value",
      "commercial invoice",
      "valued at",
      "cargo value",
      "value of the goods"
    ]
  },
  {
    "concept": "full value coverage endorsement",
    "names": [
      "full_value_coverage",
      "full_value_coverage_endorsement"
    ],
    "cues": [
      "full value",
      "fvc",
      "endorsement",
      "protection",
      "coverage",
      "covered",
      "insured value",
      "valuation",
      "rider",
      "add on",
      "additional cover"
    ],
    "values": [
      {
        "value": true,
        "patterns": [
          "carries a full value coverage",
          "bought the full value protection",
          "fvc endorsement was purchased",
          "purchased an fvc",
          "bought fvc",
          "full value coverage was purchased"
        ]
      },
      {
        "value": false,
        "patterns": [
          "no full value coverage",
          "no full value protection",
          "no additional coverage",
          "no fvc",
          "without full value",
          "declined full value"
        ]
      }
    ]
  },
  {
    "concept": "salvage value of damaged goods",
    "names": [
      "salvage_value_usd"
    ],
    "cues": [
      "salvage",
      "scrap",
      "left worth",
      "recover",
      "resale",
      "residual",
      "remnant",
      "buyer",
      "disposal",
      "what is left"
    ]
  },
  {
    "concept": "delay caused by a weather event",
    "names": [
      "weather_event",
      "delay_caused_by_weather_event"
    ],
    "cues": [
      "weather",
      "blizzard",
      "flood",
      "storm",
      "snow",
      "ice storm",
      "icy",
      "hurricane",
      "tornado",
      "wildfire",
      "high wind",
      "windstorm",
      "rain",
      "fog",
      "road closure",
      "closed the",
      "act of god",
      "acts of god",
      "shortage",
      "backlog",
      "capacity",
      "bumped",
      "breakdown",
      "mechanical",
      "congestion",
      "staff"
    ],
    "values": [
      {
        "value": true,
        "patterns": [
          "documented blizzard",
          "blizzard",
          "flood",
          "storm",
          "hurricane",
          "tornado",
          "wildfire",
          "heavy rain",
          "weather event",
          "severe weather in the lane",
          "road closure",
          "high winds"
        ]
      },
      {
        "value": false,
        "patterns": [
          "driver shortage",
          "dock backlog",
          "nothing weather related",
          "internal capacity",
          "short staffed",
          "staffing",
          "mechanical breakdown",
          "breakdown",
          "equipment shortage"
        ]
      }
    ]
  },
  {
    "concept": "packaging of the freight (three labels)",
    "names": [
      "packaging"
    ],
    "trees": [
      "claim_adjudication"
    ],
    "cues": [
      "packed",
      "packaging",
      "packing",
      "crate",
      "palletis",
      "palletiz",
      "pallet",
      "skid",
      "wrap",
      "banded",
      "strapped",
      "boxed",
      "carton",
      "padded",
      "cushion",
      "dunnage",
      "blanket",
      "dock crew"
    ],
    "values": [
      {
        "value": "carrier_packed",
        "patterns": [
          "crated and packed by halvorsen",
          "dock crew crated",
          "our own dock crew"
        ]
      },
      {
        "value": "shipper_adequate",
        "patterns": [
          "packaging was adequate",
          "wrap bands and edge protection looked proper",
          "wrap looked proper",
          "properly wrapped",
          "well packed"
        ]
      },
      {
        "value": "shipper_inadequate",
        "patterns": [
          "packaging was inadequate",
          "loose and unprotected",
          "unwrapped",
          "no padding",
          "bare skid"
        ]
      }
    ]
  },
  {
    "concept": "packaging inadequate (shipper packed it)",
    "names": [
      "shipper_packed_freight_and_packaging_inadequate"
    ],
    "trees": [
      "compiled_policy"
    ],
    "cues": [
      "packed",
      "packaging",
      "packing",
      "crate",
      "palletis",
      "palletiz",
      "pallet",
      "skid",
      "wrap",
      "banded",
      "strapped",
      "boxed",
      "carton",
      "padded",
      "cushion",
      "dunnage",
      "blanket",
      "dock crew"
    ],
    "values": [
      {
        "value": true,
        "patterns": [
          "packaging was inadequate",
          "loose and unprotected",
          "unwrapped",
          "no padding",
          "bare skid"
        ]
      },
      {
        "value": false,
        "patterns": [
          "packaging was adequate",
          "wrap bands and edge protection looked proper",
          "wrap looked proper",
          "properly wrapped",
          "well packed",
          "crated and packed by halvorsen",
          "dock crew crated",
          "our own dock crew"
        ]
      }
    ]
  },
  {
    "concept": "earlier claims or cases from the same customer",
    "names": [
      "claimant_claims_last_90d"
    ],
    "cues": [
      "claim",
      "case",
      "first contact",
      "earlier",
      "opened"
    ]
  },
  {
    "concept": "percent of the goods damaged",
    "names": [
      "damage_pct"
    ],
    "cues": [
      "damaged",
      "ruined",
      "crushed",
      "affected goods",
      "% of"
    ]
  },
  {
    "concept": "hours a reefer unit ran above its set temperature",
    "names": [
      "excursion_hours"
    ],
    "cues": [
      "hrs",
      "hours",
      "ran warm",
      "above its set temperature"
    ]
  }
];
