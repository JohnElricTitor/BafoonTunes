// Make a new BafoonsTunes release. GitHub builds the installer and publishes it
// (see .github/workflows/release.yml); installed copies then update themselves.
//
//   npm run release            -> 1.0.0 to 1.0.1
//   npm run release -- minor   -> 1.0.0 to 1.1.0
//   npm run release -- major   -> 1.0.0 to 2.0.0
//
// It bumps the version in package.json, commits everything, and pushes to main.
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const step = process.argv[2] || 'patch';
const run = cmd => execSync(cmd, { cwd: root, stdio: 'inherit' });

if (!['patch', 'minor', 'major'].includes(step)) {
  console.error(`Unknown version step "${step}". Use patch, minor or major.`);
  process.exit(1);
}

run(`npm version ${step} --no-git-tag-version`);
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
run('git add -A');
run(`git commit -m "Release v${version}"`);
run('git push origin main');

console.log(`\nPushed v${version}. GitHub is building it now (a few minutes):`);
console.log('  https://github.com/JohnElricTitor/BafoonTunes/actions');
console.log(`When it's done it appears at https://github.com/JohnElricTitor/BafoonTunes/releases/tag/v${version}\n`);
