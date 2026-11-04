export type ClaimType = 'damage' | 'loss' | 'delay' | 'temperature';
export type CommodityClass = 'general' | 'electronics' | 'fragile_glass' | 'perishable' | 'hazmat';
export type Packaging = 'carrier_packed' | 'shipper_adequate' | 'shipper_inadequate';

/** Every fact a Halvorsen claim can turn on. A given claim only states the facts its path needs. */
export interface ClaimFacts {
  claim_type: ClaimType;
  commodity_class: CommodityClass;
  /** earlier claims by this claimant in the previous 90 days */
  claimant_claims_last_90d: number;
  /** calendar days from the event date to the filing date (event date = delivery date; scheduled delivery date for loss claims) */
  days_to_file: number;
  pod_damage_noted: boolean;
  packaging: Packaging;
  weight_lb: number;
  declared_value_usd: number;
  full_value_coverage: boolean;
  damage_pct: number;
  salvage_value_usd: number;
  days_late: number;
  weather_event: boolean;
  reefer_log_available: boolean;
  excursion_hours: number;
}

export type Decision = 'approve' | 'partial' | 'deny' | 'escalate';

export interface Outcome {
  decision: Decision;
  payout_usd: number;
  escalation_target: string | null;
  reason_code: string;
  /** manual rule ids that applied, in order */
  rules: string[];
  /** gold fact ids (see gold-facts.ts) a reviewer needs in front of them to reach this outcome */
  factsUsed: string[];
  /** human-readable steps, used to write worked examples */
  steps: string[];
}
