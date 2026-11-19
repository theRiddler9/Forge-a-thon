const fs = require('fs');

const p = 'C:/Users/akash/AppData/Local/npm-cache/_npx/efcb13bb8fe8f852/node_modules/@truefoundry/trueforge-core/dist/core/llm/VercelAILLM.mjs';
let content = fs.readFileSync(p, 'utf8');
const search = 'if (Array.isArray(rawThinking) && provider !== "alibaba") {';
const replace = 'if (Array.isArray(rawThinking) && provider !== "alibaba" && provider !== "custom" && providerName !== "groq") {';

if (content.includes(search)) {
  content = content.replace(search, replace);
  fs.writeFileSync(p, content, 'utf8');
  console.log('Successfully patched VercelAILLM.mjs!');
} else if (content.includes(replace)) {
  console.log('Already patched VercelAILLM.mjs!');
} else {
  console.error('Search string not found in VercelAILLM.mjs');
}
