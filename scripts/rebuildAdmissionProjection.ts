import dotenv from 'dotenv';dotenv.config();import {repairAdmissionProjection} from '../server/candidateAdmission/replay';
const actor=process.argv[2],cutoff=process.argv[3]||new Date().toISOString();
repairAdmissionProjection(actor||'',cutoff).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
