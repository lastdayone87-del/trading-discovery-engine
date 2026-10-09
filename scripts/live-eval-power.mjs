// Power arithmetic for the live Thompson evaluation plan.
// Pure: no imports, no I/O. Run: node scripts/live-eval-power.mjs
// Inputs default to the measured 2026-10-09 census; override as needed.
// Normal CDF via Abramowitz-Stegun 7.1.26 (adequate for planning).
const invites14d = 308; // measured join count, trailing 14 days
const runsPerDay = 47; // measured completed query_runs/day
const arms = 2; // Thompson vs UCB1 (50/50 split)
const runDays = 14;
const alphaOneSided = 0.05;
const zAlpha = 1.6448536269514722;

function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d =
    0.3989422804014327 *
    Math.exp((-z * z) / 2) *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - d : d;
}

const lambda = invites14d / 14 / runsPerDay; // invites per run
const runsPerArm = (runsPerDay * runDays) / arms;
const invitesPerArm = lambda * runsPerArm;
const se = Math.sqrt((lambda / runsPerArm) * 2); // Poisson rate-difference SE
console.log(`lambda_invites_per_run=${lambda.toFixed(4)}`);
console.log(`runs_per_arm=${runsPerArm.toFixed(0)} invites_per_arm~${invitesPerArm.toFixed(0)}`);
for (const margin of [0.2, 0.3]) {
  const delta = margin * lambda;
  const power = phi(delta / se - zAlpha);
  console.log(`margin_${Math.round(margin * 100)}pct: power~${power.toFixed(2)}`);
}
// Floor check: 30/arm minimum.
console.log(`floor_30_per_arm_met=${invitesPerArm >= 30}`);
// Days needed for 80% power at 20% margin: n/arm with z_(1-beta)=0.8416.
const zBeta = 0.8416212335729143;
const nNeeded = Math.ceil(((2 * lambda * (zAlpha + zBeta) ** 2) / (0.2 * lambda) ** 2));
console.log(`days_for_80pct_at_20pct_margin~${(nNeeded / (runsPerDay / arms)).toFixed(0)}`);
