import 'dotenv/config';
import {validateEvidenceProjection} from '../server/phaseBShadow';
const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error(`${key} is required`);return value;};
validateEvidenceProjection({windowStart:required('PHASE_B_WINDOW_START'),cutoffAt:required('PHASE_B_CUTOFF_AT'),actor:process.env.PHASE_B_ACTOR||'phase-b-operator',maximumP95DurationMs:Number(process.env.PHASE_B_MAXIMUM_P95_MS||'250')}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
