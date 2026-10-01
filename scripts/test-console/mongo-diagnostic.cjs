// Executed by mongosh --nodb. Only fixed category names and numeric fields leave
// tmpfs; raw messages, attributes, environment and credentials are never printed.
const fs = require('fs');
const categories = new Set(), ids = new Set();
const patterns = {
  ADDRESS_IN_USE: /Address already in use|EADDRINUSE/i,
  ADDRESS_UNAVAILABLE: /Cannot assign requested address|EADDRNOTAVAIL/i,
  PERMISSION: /Permission denied|Operation not permitted/i,
  UNIX_SOCKET: /unix domain socket|unlink.*socket/i,
  NO_SPACE: /No space left on device|out of space/i,
  LISTENER: /Failed to set up listener|Error setting up listener/i,
  BIND: /couldn't bind|failed to bind/i,
};
let count = 0;
for (const path of ['/tmp/mongo-startup.log', '/data/db/docker-initdb.log']) {
  if (!fs.existsSync(path)) continue;
  // Bounded diagnostic input, no output of arbitrary log content.
  const fd = fs.openSync(path, 'r'), size = fs.fstatSync(fd).size;
  const bytes = Buffer.alloc(Math.min(size, 256 * 1024));
  try { fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); } finally { fs.closeSync(fd); }
  for (const line of bytes.toString('utf8').split('\n')) {
    try {
      const value = JSON.parse(line);
      if (!['E', 'F'].includes(value.s)) continue;
      count++; if (Number.isSafeInteger(value.id)) ids.add(value.id);
      const text = JSON.stringify({ message: value.msg, attr: value.attr });
      for (const [name, pattern] of Object.entries(patterns)) if (pattern.test(text)) categories.add(name);
    } catch { /* Non-JSON lines are never echoed. */ }
  }
}
const exit = fs.existsSync('/tmp/mongo-exit') ? Number(fs.readFileSync('/tmp/mongo-exit', 'utf8')) : -1;
print(`Mongo diagnostic exit=${Number.isSafeInteger(exit) ? exit : -1} fatal_count=${count} categories=${[...categories].sort().join(',') || 'UNCLASSIFIED'} ids=${[...ids].slice(-12).join(',') || 'none'}`);
