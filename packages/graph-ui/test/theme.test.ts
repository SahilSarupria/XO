import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphTheme } from '../src/theme/GraphTheme.js';

const node = { id: 'a', type: 'service', label: 'A', position: { x: 0, y: 0 } };
const edge = { id: 'e1', type: 'link', source: 'a', target: 'b' };

test('built-in themes: light, dark, high-contrast', () => {
  assert.equal(GraphTheme.light().definition.name, 'light');
  assert.equal(GraphTheme.dark().definition.name, 'dark');
  assert.equal(GraphTheme.highContrast().definition.name, 'high-contrast');
});

test('named() resolves by string, throws on unknown', () => {
  assert.equal(GraphTheme.named('dark').definition.name, 'dark');
  assert.throws(() => GraphTheme.named('nope'));
});

test('resolveNodeStyle falls back to default style', () => {
  const style = GraphTheme.light().resolveNodeStyle(node);
  assert.equal(style.fill, GraphTheme.light().definition.defaultNodeStyle.fill);
});

test('resolveNodeStyle cascades type -> execution -> hover -> selected', () => {
  const theme = GraphTheme.light().extend({ nodeTypeStyles: { service: { fill: 'type-fill' } } });
  const typeOnly = theme.resolveNodeStyle(node);
  assert.equal(typeOnly.fill, 'type-fill');

  const withExecution = theme.resolveNodeStyle(node, { executionStatus: 'failed' });
  assert.equal(withExecution.fill, theme.definition.executionStyles!.failed.fill);

  const selected = theme.resolveNodeStyle(node, { selected: true });
  assert.equal(selected.stroke, theme.definition.selectionStyle.node.stroke);
});

test('resolveEdgeStyle marks animated when requested', () => {
  const style = GraphTheme.light().resolveEdgeStyle(edge, { animated: true });
  assert.equal(style.animated, true);
});

test('custom() and extend() produce independent immutable themes', () => {
  const base = GraphTheme.light();
  const custom = base.extend({ background: '#123456' });
  assert.equal(base.definition.background, '#ffffff');
  assert.equal(custom.definition.background, '#123456');
});
