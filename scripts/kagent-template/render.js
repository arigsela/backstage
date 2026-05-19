#!/usr/bin/env node
// Offline renderer for the kagent-agent scaffolder template.
// Usage: node render.js <fixture.json> > rendered.yaml
//
// Mirrors Backstage scaffolder's Nunjucks setup:
//   - Custom variable tags: ${{ ... }} (not {{ ... }})
//   - Custom `dump` filter that JSON-stringifies
//   - Standard `trim`, `length`, `indent` filters from Nunjucks core

const fs = require('fs');
const path = require('path');
const nunjucks = require('nunjucks');

const REPO_ROOT = path.resolve(__dirname, '../..');
const TEMPLATE_PATH = path.join(
  REPO_ROOT,
  'examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml',
);

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error('Usage: node render.js <fixture.json>');
  process.exit(2);
}

const values = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const templateSource = fs.readFileSync(TEMPLATE_PATH, 'utf8');

const env = new nunjucks.Environment(null, {
  autoescape: false,
  tags: { variableStart: '${{', variableEnd: '}}' },
});
env.addFilter('dump', (v, spaces) => JSON.stringify(v, null, spaces));

// The template references `values.X`, so wrap accordingly.
const rendered = env.renderString(templateSource, { values });
process.stdout.write(rendered);
