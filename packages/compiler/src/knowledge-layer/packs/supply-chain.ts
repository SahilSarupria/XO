import type { ConceptKind, DomainConcept, DomainKnowledgePack } from '../types.js';

const c = (
  id: string,
  label: string,
  kind: ConceptKind,
  definition: string,
  synonyms: readonly string[] = [],
  weight = 1,
): DomainConcept => ({ id, label, kind, definition, synonyms, weight });

export const SUPPLY_CHAIN_PACK: DomainKnowledgePack = {
  id: 'supply-chain',
  version: '0.1.0',
  domain: 'supply-chain',
  description: 'Procurement, logistics and inventory terminology in supplier agreements.',
  provenance: 'Authored for the XO compiler from general public knowledge of supply-chain terminology; not yet expert-reviewed.',
  status: 'draft',
  concepts: [
    c('supplier', 'supplier', 'entity', 'The party that provides goods or services against orders.', ['vendor', 'seller']),
    c('purchase-order', 'purchase order', 'process', 'A buyer’s document committing to purchase specified goods.', ['PO']),
    c('shipment', 'shipment', 'term', 'Goods dispatched together under one transport document.', ['consignment']),
    c('lead-time', 'lead time', 'constraint', 'Elapsed time between placing an order and receiving the goods.', [
      'turnaround time',
      'delivery lead time',
    ]),
    c('sku', 'SKU', 'term', 'A unique code identifying a stock-keeping unit.', ['stock keeping unit', 'stock-keeping unit']),
    c('moq', 'minimum order quantity', 'constraint', 'The smallest quantity a supplier will accept per order.', ['MOQ']),
    c('bill-of-lading', 'bill of lading', 'term', 'The carrier’s receipt and document of title for goods in transit.', ['BOL']),
    c('incoterms', 'Incoterms', 'term', 'Standard trade terms allocating transport cost and risk between buyer and seller.', [
      'international commercial terms',
    ]),
    c('safety-stock', 'safety stock', 'constraint', 'Buffer inventory held against demand or supply variability.', ['buffer stock']),
    c('reorder-point', 'reorder point', 'condition', 'The stock level at which a replenishment order is triggered.', ['reorder level']),
    c('warehouse', 'warehouse', 'entity', 'A facility where inventory is stored.', ['distribution centre', 'distribution center'], 0.7),
    c('inventory', 'inventory', 'term', 'Goods held for sale or use.', ['stock on hand'], 0.5),
    c('backorder', 'backorder', 'process', 'An order that cannot be filled immediately and is fulfilled later.', ['back order']),
    c('fulfilment', 'fulfilment', 'process', 'The process of completing and delivering an order.', ['fulfillment', 'order fulfilment']),
    c('freight', 'freight', 'term', 'Goods in transit, or the charge for carrying them.', ['carriage']),
    c('delivery', 'delivery', 'process', 'The handing over of goods at the agreed place.', [], 0.4),
    c('demand-forecast', 'demand forecast', 'term', 'An estimate of future customer demand.', ['sales forecast']),
    c('order-tolerance', 'order tolerance', 'constraint', 'The permitted variance between ordered and delivered quantity.', [
      'quantity tolerance',
      'over-delivery tolerance',
    ]),
  ],
  relationships: [
    { from: 'supplier', type: 'fulfils', to: 'purchase-order' },
    { from: 'purchase-order', type: 'results-in', to: 'shipment' },
    { from: 'lead-time', type: 'measured-from', to: 'purchase-order' },
    { from: 'reorder-point', type: 'triggers', to: 'purchase-order' },
    { from: 'safety-stock', type: 'protects-against', to: 'lead-time' },
  ],
  patterns: [
    {
      id: 'delivery-window',
      description: 'Delivery must occur within a stated time of the order.',
      example: 'The supplier shall deliver within 14 days of the purchase order.',
      conceptIds: ['supplier', 'purchase-order', 'lead-time'],
    },
    {
      id: 'moq-rejection',
      description: 'Orders below the minimum quantity are not accepted.',
      example: 'Orders below the minimum order quantity may be rejected.',
      conceptIds: ['moq'],
    },
  ],
};
