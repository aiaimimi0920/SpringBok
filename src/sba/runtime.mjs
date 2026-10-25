// Only these complete tuples select platform-owned executors; applications cannot select workflow paths.
export const WINDOWS_RUNTIME = Object.freeze({ runner: 'windows-2025', powershell: '5.1', python: '3.12', node: '22' });
export const LINUX_RUNTIME = Object.freeze({ runner: 'ubuntu-24.04', powershell: '7.6.9', python: '3.12', node: '22' });
const profiles = Object.freeze([
  Object.freeze({ runtime: WINDOWS_RUNTIME, platform: 'win32', workflowPath: '.github/workflows/sba-execute.yml' }),
  Object.freeze({ runtime: LINUX_RUNTIME, platform: 'linux', workflowPath: '.github/workflows/sba-execute-linux.yml' }),
]);
export function runtimeProfile(runtime) {
  const profile = runtime && typeof runtime === 'object' && !Array.isArray(runtime) && Object.keys(runtime).length === 4 &&
    profiles.find(row => Object.entries(row.runtime).every(([key, value]) => runtime[key] === value));
  if (!profile) throw new Error('SBA_RUNTIME_REJECTED');
  return profile;
}
export function workflowProfile(path) {
  const profile = profiles.find(row => row.workflowPath === path);
  if (!profile) throw new Error('SBA_RUNTIME_REJECTED');
  return profile;
}
