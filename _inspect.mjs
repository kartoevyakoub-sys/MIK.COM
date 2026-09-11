import fs from 'fs';
const source = fs.readFileSync('node_modules/@vercel/blob/dist/chunk-YYMLUMXS.js', 'utf8');
for (const key of ['parseBody', 'computeBodyLength', 'isStream', 'createUploadPart', 'parseReadableStream', 'requestApi(', 'async function put']) {
  const i = source.indexOf(key);
  console.log(key, '=>', i);
  if (i >= 0) console.log('--- ctx ---\n' + source.slice(i, i + 500) + '\n');
}