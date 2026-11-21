const fs = require('fs');
const path = require('path');

const npxBase = 'C:/Users/akash/AppData/Local/npm-cache/_npx';
if (!fs.existsSync(npxBase)) {
  console.log('No _npx directory found at', npxBase);
  process.exit(0);
}

const entries = fs.readdirSync(npxBase);
for (const entry of entries) {
  const pkgDir = path.join(npxBase, entry, 'node_modules/@truefoundry/trueforge-core/dist/core');
  if (!fs.existsSync(pkgDir)) continue;

  // 1. Patch VercelAILLM.mjs for Groq thinking blocks
  const llmPath = path.join(pkgDir, 'llm/VercelAILLM.mjs');
  if (fs.existsSync(llmPath)) {
    let content = fs.readFileSync(llmPath, 'utf8');
    const search = 'if (Array.isArray(rawThinking) && provider !== "alibaba") {';
    const replace = 'if (Array.isArray(rawThinking) && provider !== "alibaba" && provider !== "custom" && providerName !== "groq") {';
    if (content.includes(search)) {
      content = content.replace(search, replace);
      fs.writeFileSync(llmPath, content, 'utf8');
      console.log(`Successfully patched VercelAILLM.mjs in ${entry}!`);
    } else if (content.includes(replace)) {
      console.log(`Already patched VercelAILLM.mjs in ${entry}!`);
    }
  }

  // 2. Patch ssrfGuard.mjs to allow localhost / 127.0.0.1 for local MCP servers
  const ssrfPath = path.join(pkgDir, 'util/ssrfGuard.mjs');
  if (fs.existsSync(ssrfPath)) {
    let content = fs.readFileSync(ssrfPath, 'utf8');
    const searchSsrf = 'var allowedHosts = [];';
    const replaceSsrf = 'var allowedHosts = ["localhost", "127.0.0.1", "::1"];';
    if (content.includes(searchSsrf)) {
      content = content.replace(searchSsrf, replaceSsrf);
      fs.writeFileSync(ssrfPath, content, 'utf8');
      console.log(`Successfully patched ssrfGuard.mjs in ${entry}!`);
    } else if (content.includes(replaceSsrf)) {
      console.log(`Already patched ssrfGuard.mjs in ${entry}!`);
    }
  }
}
