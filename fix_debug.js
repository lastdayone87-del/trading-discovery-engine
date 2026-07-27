const fs = require('fs');
let code = fs.readFileSync('server/inspector.ts', 'utf-8');

code = code.replace(
  'export interface InspectionResult {',
  'export interface InspectionResult {\n  debugLog?: any;'
);

code = code.replace(
  'export async function runChannelInspection(channelData: {',
  'export async function runChannelInspection(channelData: {\n  enableDebug?: boolean;'
);

fs.writeFileSync('server/inspector.ts', code, 'utf-8');
console.log("Updated server/inspector.ts");
