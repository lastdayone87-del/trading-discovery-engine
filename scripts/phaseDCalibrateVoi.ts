import {calibrateVoiFromOutcomes} from '../server/voiCalibration';
const [windowStart,cutoffAt,actor,minimum='30']=process.argv.slice(2);if(!windowStart||!cutoffAt||!actor)throw new Error('Usage: phaseDCalibrateVoi <windowStart> <cutoffAt> <actor> [minimumOutcomes]');
console.log(JSON.stringify(await calibrateVoiFromOutcomes({windowStart,cutoffAt,actor,minimumOutcomes:Number(minimum)}),null,2));
