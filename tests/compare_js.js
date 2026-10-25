const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let src = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8');
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'defaults.json'), 'utf8'));
src = src.replace('__DEFAULTS__', JSON.stringify(defaults));
const tmp = path.join(ROOT, 'src', '_engine_test.js');
fs.writeFileSync(tmp, src);
const E = require(tmp);
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const out = {};
for (const c of cases) {
  const p = E.normalize(c.override);
  const det = E.requiredCapital(p, 0.9, 1, 20261025, 'deterministic', 20).req;
  const mc = E.requiredCapital(p, 0.9, 800, 20261025, 'stochastic', 14).req;
  out[c.name] = { deterministic: det, required: mc, pension: [E.pensionToday(p, 'self'), E.pensionToday(p, 'spouse')] };
}
fs.writeFileSync(path.join(ROOT, 'data', 'js_cases.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('wrote data/js_cases.json');
