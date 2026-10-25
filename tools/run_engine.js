/* 用 Node 运行 JS 引擎，输出 JSON，供 Excel/文档/校验使用。
 * 用法: node tools/run_engine.js [paths] [outfile]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let src = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8');
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'defaults.json'), 'utf8'));
src = src.replace('__DEFAULTS__', JSON.stringify(defaults));
const tmp = path.join(ROOT, 'src', '_engine_test.js');
fs.writeFileSync(tmp, src);
const E = require(tmp);
const n = Number(process.argv[2] || 4000);
const out = process.argv[3] || path.join(ROOT, 'data', 'base_result.json');
const result = E.runModel({}, n);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
console.log('wrote', out, 'required', (result.required / 1e4).toFixed(0), '万', 'paths', n);
