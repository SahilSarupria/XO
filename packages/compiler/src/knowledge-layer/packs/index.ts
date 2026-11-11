import type { DomainKnowledgePack } from '../types.js';
import { FINANCE_LENDING_PACK } from './finance-lending.js';
import { INSURANCE_CLAIMS_PACK } from './insurance-claims.js';
import { SUPPLY_CHAIN_PACK } from './supply-chain.js';

export { FINANCE_LENDING_PACK, INSURANCE_CLAIMS_PACK, SUPPLY_CHAIN_PACK };
export const BUILT_IN_PACKS: readonly DomainKnowledgePack[] = [INSURANCE_CLAIMS_PACK, FINANCE_LENDING_PACK, SUPPLY_CHAIN_PACK];
