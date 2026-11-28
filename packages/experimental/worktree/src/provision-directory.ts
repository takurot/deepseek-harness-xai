/** Static Node worker for file provisioning under the calling Session's process sandbox. */

/** Git's control directory and common filesystem aliases must not be provisioned. */
export const GIT_METADATA_NAME = /^(?:\.git|git~[1-9]\d*)$/i

/** Validates shared directories and applies exclusive links and ignored-file copies. */
export const PROVISION_DIRECTORY = String.raw`
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
const [action, source, workspace, checkout, mode, config] = process.argv.slice(1);
const configured = JSON.parse(config);
const fold = value => process.platform === 'linux' ? value : value.toLowerCase();
const contains = (root, target) => {
  const rest = path.relative(fold(root), fold(target));
  return rest !== '..' && !rest.startsWith('..' + path.sep) && !path.isAbsolute(rest);
};
const conflicts = (left, right) => contains(left, right) || contains(right, left);
const metadata = ${GIT_METADATA_NAME};
const involvesMetadata = value => value.split(path.sep).some(part => metadata.test(part.replace(/[ .]+$/, '').replace(/\p{Default_Ignorable_Code_Point}/gu, '')));
async function shareTargets() {
  const canonicalRoots = [await fs.realpath(source), await fs.realpath(workspace)];
  const entries = [];
  for (const input of configured) {
    const target = await fs.realpath(input);
    if (involvesMetadata(input) || involvesMetadata(target)) throw new Error('shareDirectories cannot refer to Git metadata');
    if ([source, workspace].some(root => conflicts(root, path.resolve(input))) || canonicalRoots.some(root => conflicts(root, target))) {
      throw new Error('shareDirectories must refer to directories outside the source checkout and Session workspace, not their ancestors');
    }
    if (!(await fs.stat(target)).isDirectory()) throw new Error('shareDirectories target is not a directory: ' + input);
    entries.push([path.basename(input), target]);
  }
  return entries;
}
async function inspect(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function walk(root, parts, create) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let status = await inspect(current);
    if (status === undefined && create) {
      try { await fs.mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      status = await inspect(current);
    }
    if (status === undefined) return false;
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('refusing symlink or non-directory parent: ' + current);
  }
  if (fold(await fs.realpath(current)) !== fold(current)) throw new Error('refusing redirected parent: ' + current);
  return true;
}
async function main() {
  const shares = configured.length === 0 ? [] : await shareTargets();
  if (action === 'check') return;
  await walk(checkout, [], false);
  let listing = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) listing += chunk;
  for (const [name, target] of shares) {
    await walk(checkout, [], false);
    await fs.symlink(target, path.join(checkout, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  let copied = 0;
  for (let start = 0; start < listing.length;) {
    const end = listing.indexOf('\0', start);
    const parts = listing.slice(start, end).split('/');
    start = end + 1;
    const leaf = parts.pop();
    if (!await walk(source, parts, false)) continue;
    const original = path.join(source, ...parts, leaf);
    if (!(await inspect(original))?.isFile()) continue;
    await walk(checkout, parts, true);
    const destination = path.join(checkout, ...parts, leaf);
    try {
      if (mode === 'symlink') await fs.symlink(original, destination, 'file');
      else await fs.copyFile(original, destination, constants.COPYFILE_EXCL);
      copied++;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  console.log(copied);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
`
