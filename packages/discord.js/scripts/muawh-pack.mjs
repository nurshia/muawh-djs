/**
 * MUAWH FORK PAKETLEME
 *
 * NEDEN VAR: upstream monorepo pnpm workspace protokolunu kullaniyor
 * (ornegin `"@discordjs/builders": "workspace:^"`). pnpm bu ifadeyi YAYIN
 * aninda gercek bir surum araligina cevirir; `npm pack` cevirmez. Cevrilmemis
 * bir tarball kurulmaya calisildiginda npm su hatayi verir:
 *
 *     npm error code EUNSUPPORTEDPROTOCOL
 *     npm error Unsupported URL Type "workspace:": workspace:^
 *
 * Bu script pnpm'in yaptigi cevrimi yapar, ESM tiplerini uretir ve tarball'i
 * olusturur.
 *
 * ⚠️ COMMITTE DURAN `package.json` DEGISMEZ. Cevrim yalnizca paketleme
 * suresince, gecici olarak uygulanir ve sonunda dosya eski haline dondurulur.
 * Bunun sebebi upstream takibi: cozulmus surumleri commitleseydik
 * `git rebase upstream/v14` her surumde bu dosyada catisma uretirdi.
 *
 * Kullanim:  node ./scripts/muawh-pack.mjs
 */

import { execFileSync } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packageJson = new URL('../package.json', import.meta.url);
const backup = new URL('../package.json.muawh-backup', import.meta.url);
const packageDir = fileURLToPath(new URL('../', import.meta.url));

/** `workspace:` ifadesini gercek surum araligina cevirir. */
function resolveWorkspaceRange(spec, version) {
  const suffix = spec.slice('workspace:'.length);

  // pnpm semantigi: `^` ve `~` operatoru korur, `*` ve bos ifade tam surumu alir.
  if (suffix === '^' || suffix === '~') return `${suffix}${version}`;
  if (suffix === '*' || suffix === '') return version;

  // Elle yazilmis bir aralik (`workspace:^1.2.3`) oldugu gibi gecer.
  return suffix;
}

/** `@discordjs/builders` → `packages/builders` */
async function workspaceVersion(name) {
  const directory = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  const target = new URL(`../../${directory}/package.json`, import.meta.url);

  try {
    const raw = await readFile(target, 'utf8');
    return JSON.parse(raw).version;
  } catch {
    throw new Error(
      `"${name}" workspace paketi bulunamadi (aranan: packages/${directory}/package.json). ` +
        'Monorepo kokunde misin?',
    );
  }
}

/** Bir bagimlilik blogundaki tum `workspace:` ifadelerini cozer. */
async function resolveBlock(block) {
  if (!block) return { resolved: undefined, changes: [] };

  const resolved = { ...block };
  const changes = [];

  for (const [name, spec] of Object.entries(block)) {
    if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;

    const version = await workspaceVersion(name);
    resolved[name] = resolveWorkspaceRange(spec, version);
    changes.push(`${name}: ${spec} → ${resolved[name]}`);
  }

  return { resolved, changes };
}

const original = await readFile(packageJson, 'utf8');
await copyFile(packageJson, backup);

try {
  const manifest = JSON.parse(original);

  const dependencies = await resolveBlock(manifest.dependencies);
  const peerDependencies = await resolveBlock(manifest.peerDependencies);
  const changes = [...dependencies.changes, ...peerDependencies.changes];

  if (dependencies.resolved) manifest.dependencies = dependencies.resolved;
  if (peerDependencies.resolved) manifest.peerDependencies = peerDependencies.resolved;

  console.log(`▶ ${manifest.name}@${manifest.version}`);
  if (changes.length === 0) {
    console.log('  workspace: bagimliligi yok, cevrim gerekmedi.');
  } else {
    for (const change of changes) console.log(`  ${change}`);
  }

  await writeFile(packageJson, `${JSON.stringify(manifest, null, 2)}\n`);

  // `.d.mts` tipleri depoda tutulmuyor, yayin aninda uretiliyor.
  // Muawh ESM (`NodeNext`) kullandigi icin TypeScript `import` kosulunda
  // bu dosyayi arar; eksik olursa TUM tipler kirilir.
  console.log('▶ ESM tipleri uretiliyor (esmDts.mjs)');
  execFileSync(process.execPath, ['./scripts/esmDts.mjs'], {
    cwd: packageDir,
    stdio: 'inherit',
  });

  // `--ignore-scripts`: upstream `prepack` betigi `lint` ve `test` calistiriyor,
  // ikisi de tum monorepo dev zincirini (tslint, tsd, docgen) istiyor. Bizim
  // ihtiyacimiz olan tek adim olan `esmDts` yukarida zaten calisti.
  console.log('▶ npm pack');
  execFileSync('npm', ['pack', '--ignore-scripts'], {
    cwd: packageDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  console.log(`\n✅ ${manifest.name}-${manifest.version}.tgz hazir.`);
} finally {
  // Hata olsa da committe duran dosya UPSTREAM HALINE donmeli.
  await copyFile(backup, packageJson);
  await rm(backup, { force: true });
}
