import {evaluateDelayedQueryFeedback,projectDelayedVerifiedQueryOutcomes} from '../server/queryFeedbackEvaluation';
const [windowStart,cutoffAt,rewardPolicyId,actor]=process.argv.slice(2);if(!windowStart||!cutoffAt||!rewardPolicyId||!actor)throw new Error('Usage: phaseEQueryFeedback <windowStart> <cutoffAt> <rewardPolicyId> <actor>');
await projectDelayedVerifiedQueryOutcomes(cutoffAt);console.log(JSON.stringify(await evaluateDelayedQueryFeedback({windowStart,cutoffAt,rewardPolicyId,actor}),null,2));
