// MinIO 8.0.7 uses the removed stream-json 1.x deep import and .make() API.
// Keep the SDK/S3 API pinned; adapt its dependency imports to patched stream-json and query-string APIs.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let entry;
try{entry=require.resolve('minio');}catch(error){if(error.code==='MODULE_NOT_FOUND')process.exit(0);throw error;}
const root=path.resolve(path.dirname(entry),'../..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if(pkg.name!=='minio'||pkg.version!=='8.0.7')throw Error('Review the MinIO JSONL compatibility patch before changing the pinned SDK');
const parser=createRequire(entry)('stream-json/jsonl/parser.js');
if(typeof parser.parser?.asStream!=='function')throw Error('The patched stream-json Node-stream API is required; refresh the lockfile/install');
const targets=[
 ['dist/main/notification.js', 'require("stream-json/jsonl/Parser.js")', 'require("stream-json/jsonl/parser.js")', '_Parser.make()', '_Parser.parser.asStream()'],
 ['dist/esm/notification.mjs', "from 'stream-json/jsonl/Parser.js'", "from 'stream-json/jsonl/parser.js'", 'jsonLineParser.make()', 'jsonLineParser.asStream()'],
];
for(const [relative,before,after,oldFactory,newFactory]of targets){
 const file=path.join(root,relative),s=fs.readFileSync(file,'utf8');
 if(s.includes(after)&&s.includes(newFactory))continue;
 if(!s.includes(before)||!s.includes(oldFactory))throw Error('Unexpected SDK notification code: '+relative);
 fs.writeFileSync(file,s.replace(before,after).replace(oldFactory,newFactory));
}
const query=createRequire(entry)('query-string').default;
if(typeof query?.stringify!=='function'||typeof query?.parse!=='function')throw Error('The patched query-string default API is required');
for(const [relative,before,after]of [
 ['dist/main/internal/client.js','var qs = _interopRequireWildcard(require("query-string"), true);','var qs = require("query-string").default;'],
 ['dist/main/helpers.js','var querystring = _interopRequireWildcard(require("query-string"), true);','var querystring = require("query-string").default;'],
 ['dist/esm/internal/client.mjs',"import * as qs from 'query-string';","import qs from 'query-string';"],
 ['dist/esm/helpers.mjs',"import * as querystring from 'query-string';","import querystring from 'query-string';"],
]){
 const file=path.join(root,relative),source=fs.readFileSync(file,'utf8');
 if(source.includes(after))continue;
 if(!source.includes(before))throw Error('Unexpected SDK query-string import: '+relative);
 fs.writeFileSync(file,source.replace(before,after));
}
