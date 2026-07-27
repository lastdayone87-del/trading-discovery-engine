const fs = require('fs');
let code = fs.readFileSync('server/inspector.ts', 'utf-8');

code = code.replace(
  'export async function crawlExternalLinks(\n  links: string[],\n  logDetails: string[] = []\n): Promise<{ foundInvite: string | null;  foundLocation?: string; details: string }> {',
  'export async function crawlExternalLinks(\n  links: string[],\n  logDetails: string[] = [],\n  debugLog?: any\n): Promise<{ foundInvite: string | null;  foundLocation?: string; details: string }> {'
);

code = code.replace(
  'export async function crawlSocialBios(\n  socialUrls: string[],\n  logDetails: string[] = []\n): Promise<{ foundInvite: string | null; details: string }> {',
  'export async function crawlSocialBios(\n  socialUrls: string[],\n  logDetails: string[] = [],\n  debugLog?: any\n): Promise<{ foundInvite: string | null; details: string }> {'
);

fs.writeFileSync('server/inspector.ts', code, 'utf-8');
console.log("Updated server/inspector.ts part 2");
