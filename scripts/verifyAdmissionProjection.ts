import dotenv from 'dotenv';dotenv.config();import {verifyAdmissionProjection} from '../server/candidateAdmission/replay';
verifyAdmissionProjection(process.argv[2]||new Date().toISOString()).then(result=>{console.log(JSON.stringify(result,null,2));if(!result.pass)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});
