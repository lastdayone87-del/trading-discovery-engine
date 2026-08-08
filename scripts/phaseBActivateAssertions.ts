import 'dotenv/config';
import {activateAssertionDualWrite} from '../server/phaseBShadow';
const validationRunId=process.env.PHASE_B_VALIDATION_RUN_ID;if(!validationRunId)throw new Error('PHASE_B_VALIDATION_RUN_ID is required');
activateAssertionDualWrite({validationRunId,actor:process.env.PHASE_B_ACTOR||'phase-b-operator',reason:process.env.PHASE_B_ACTIVATION_REASON||'Phase B document validation passed'}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
