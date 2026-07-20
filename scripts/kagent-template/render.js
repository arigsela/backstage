#!/usr/bin/env node
// Offline renderer for kagent scaffolder templates.
// Usage: node render.js <template-path> <fixture.json> > rendered.yaml
//        node render.js <fixture.json>                  # agent template (back-compat)
//
// Mirrors Backstage scaffolder's Nunjucks setup:
//   - Custom variable tags: ${{ ... }} (not {{ ... }})
//   - Custom `dump` filter that JSON-stringifies
//   - Standard `trim`, `length`, `indent` filters from Nunjucks core

const fs = require('fs');
const path = require('path');
const nunjucks = require('nunjucks');

const REPO_ROOT = path.resolve(__dirname, '../..');

// Usage: node render.js <template-path-relative-to-repo-root> <fixture.json>
// Back-compat: when only one arg is given, default to the agent template.
const argTemplate = process.argv[2];
const argFixture = process.argv[3];

let templatePath;
let fixturePath;

if (argFixture) {
  templatePath = path.resolve(REPO_ROOT, argTemplate);
  fixturePath = argFixture;
} else {
  // Back-compat: single-arg form keeps the agent contract test working.
  templatePath = path.join(
    REPO_ROOT,
    'examples/templates/kagent-agent/content/base-apps/kagent/agents/${{ values.name }}.yaml',
  );
  fixturePath = argTemplate;
}

if (!fixturePath) {
  console.error(
    'Usage: node render.js <template-path> <fixture.json>\n' +
    '       node render.js <fixture.json>   # agent template (back-compat)',
  );
  process.exit(2);
}

const values = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const templateSource = fs.readFileSync(templatePath, 'utf8');

const env = new nunjucks.Environment(null, {
  autoescape: false,
  tags: { variableStart: '${{', variableEnd: '}}' },
});
env.addFilter('dump', (v, spaces) => JSON.stringify(v, null, spaces));

// The template references `values.X`, so wrap accordingly.
const rendered = env.renderString(templateSource, { values });
process.stdout.write(rendered);
