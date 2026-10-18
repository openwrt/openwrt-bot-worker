// --- OPENWRT BOT POLICY AND CONVENTIONS ---

export const IGNORED_USERS = [
  'dependabot[bot]', 'dependabot', 'weblate',
  'github-actions[bot]', 'github-actions',
  'github-copilot[bot]', 'github-advanced-security[bot]'
];

export const MAINTAINER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

export const PROTECTED_HEAD_BRANCH_NAMES = ['master', 'main', 'stable'];

export function isProtectedHeadBranch(branch: string): boolean {
  return PROTECTED_HEAD_BRANCH_NAMES.includes(branch) || /^openwrt-\d{2}\.\d{2}$/.test(branch);
}

export const ALLOW_BRANCH_PATTERN = /\[allow[ -]branch\]/i;
export const ALLOW_CHERRY_PICK_PATTERN = /\[allow[ -]cherry[ -]pick\]/i;
export const CHERRY_PICK_MARKER = /cherry[ -]picked from commit ([0-9a-fA-F]{7,40})/i;

// The release branches openwrt/packages' CONTRIBUTING.md names: `for-XX.YY`
// before the LEDE split, `lede-17.01` during it, `openwrt-XX.YY` since. A base
// branch, unlike isProtectedHeadBranch, and unlike isBackportPr in context.ts,
// which a pull request to master titled `[24.10] ...` also sets.
export function isStableBaseBranch(branch: string): boolean {
  return /^(?:openwrt|lede|for)-\d{2}\.\d{2}$/.test(branch);
}
