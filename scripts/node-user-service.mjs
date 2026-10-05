import { installUserUnit } from '../src/node-service/user-unit.mjs';
import { requireInstall } from '../src/node-install/package.mjs';

try {
  const args = process.argv.slice(2);
  requireInstall(args.length === 4 && args[0] === '--installation' && args[2] === '--unit-directory');
  const { contents, ...result } = installUserUnit({ installation: args[1], unitDirectory: args[3] });
  console.log(JSON.stringify(result));
} catch {
  console.error('Node user service rejected: installation, paths, permissions or existing unit unconfirmed. Preserve installation, state and units. Usage: node scripts/node-user-service.mjs --installation <absolute-directory> --unit-directory <private-systemd-user-directory>');
  process.exitCode = 2;
}
