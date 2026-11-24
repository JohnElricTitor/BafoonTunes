// Publish a new version of BafoonsTunes to GitHub Releases. Installed copies update themselves.
//
//   npm run release            -> bump 1.0.0 to 1.0.1, build, publish
//   npm run release -- minor   -> 1.0.0 to 1.1.0
//   npm run release -- major   -> 1.0.0 to 2.0.0
//   npm run release -- current -> publish the version already in package.json
//
// Needs the GitHub CLI signed in once:  gh auth login
// Commit and push your code changes as usual; this script only bumps the version and publishes.
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const bump = process.argv[2] || 'patch';
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });

function ghToken() {
  try {
    return execSync('gh auth token', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    console.error('\nThe GitHub CLI is not signed in. Run "gh auth login" once, then try again.\n');
    process.exit(1);
  }
}

const token = process.env.GH_TOKEN || ghToken();

if (bump !== 'current') {
  if (!['patch', 'minor', 'major'].includes(bump)) {
    console.error(`Unknown version step "${bump}". Use patch, minor, major or current.`);
    process.exit(1);
  }
  run(`npm version ${bump} --no-git-tag-version`);
}
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log(`\nBuilding and publishing BafoonsTunes ${version}…\n`);

const r = spawnSync('npx', ['electron-builder', '--win', 'nsis', '--publish', 'always'], {
  cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, GH_TOKEN: token },
});
if (r.status !== 0) process.exit(r.status || 1);

console.log(`\nPublished v${version}: https://github.com/JohnElricTitor/BafoonTunes/releases/tag/v${version}`);
console.log('Installed copies will download it the next time they open. Remember to commit and push package.json.\n');
